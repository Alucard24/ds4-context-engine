import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SessionManager, sessionEntryToContextMessages, type ExtensionCommandContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Ds4ContextConfig } from "ds4-context-core/config/config";
import type { ContextDatabase } from "ds4-context-core/persistence/sqlite";
import { MEMORY_CUSTOM_ENTRY_TYPE, PIN_CUSTOM_ENTRY_TYPE, type MemoryItem, type PinItem } from "ds4-context-core/memory/memory-types";
import { REBASE_CHECKPOINT_TYPE, REBASE_LINK_TYPE, type RebaseCheckpoint, type RebaseLink, type RebaseOperation, type RebasePhase, type RebaseResult } from "ds4-context-core/rebase/rebase-types";
import { buildRebaseCheckpoint } from "ds4-context-core/rebase/checkpoint";
import { historyPrivacyClassification } from "ds4-context-core/retrieval/history-privacy";
import { estimateTextTokens } from "ds4-context-core/core/token-estimator";
import { classifyMarkedContent, highestClassification, isPrivacyClassification, type PrivacyClassification } from "ds4-context-core/privacy/privacy-policy";
import { sha256 } from "ds4-context-core/shared/hash";
import { hashFileRange, readJsonlRecords, readSessionHeaderRecord } from "./session-jsonl.ts";
import { historyProjectPath } from "./history-source-reader.ts";
import { isPiSessionEntryRecord } from "./indexed-entry.ts";
import { acquireRebaseLock } from "./rebase-lock.ts";
import { validateAtomicSelection } from "ds4-context-core/planner/atomic-groups";

export interface RebaseAccess {
  config: Ds4ContextConfig;
  database: ContextDatabase;
  projectPath: string;
  compactionActive: () => boolean;
  snapshotMemory: () => { pins: PinItem[]; memories: MemoryItem[] };
  /** Synthetic offline fault injection only; no content is supplied to the callback. */
  afterPhase?: (phase: RebasePhase) => void;
}
function syncDirectory(path: string): void {
  let fd: number | undefined;
  try { fd = openSync(path, "r"); fsyncSync(fd); }
  catch (error) {
    if (process.platform !== "win32") throw error;
    // Windows does not provide Node directory-fsync; files are still explicitly flushed.
  } finally { if (fd !== undefined) closeSync(fd); }
}
function writeDurable(path: string, bytes: string, replace: boolean): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    if (replace) renameSync(temporary, path);
    else { linkSync(temporary, path); unlinkSync(temporary); }
    syncDirectory(dirname(path));
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Only our temporary file; never source JSONL. */ }
    throw error;
  }
}
function journalPath(sourceFile: string, operationId: string): string {
  if (!/^rebase_[a-f0-9]{32}$/u.test(operationId)) throw new Error("invalid-operation");
  return join(dirname(sourceFile), ".ds4-rebase", "operations", `${operationId}.json`);
}
function checkPrefix(file: string, size: number, hash: string): void {
  if (!Number.isSafeInteger(size) || size < 1 || !/^[a-f0-9]{64}$/u.test(hash)
    || statSync(file).size < size || hashFileRange(file, 0, size) !== hash) throw new Error("archive-changed");
}
function checkTargetPrefix(operation: RebaseOperation): void {
  if (operation.targetSize === undefined || operation.targetHash === undefined) throw new Error("target-integrity");
  try { checkPrefix(operation.targetSessionFile, operation.targetSize, operation.targetHash); }
  catch { throw new Error("target-integrity"); }
}
function validateBranch(records: ReadonlyMap<string, Record<string, unknown>>, leaf: string): void {
  const seen = new Set<string>(); let id: string | null = leaf;
  while (id !== null) {
    const record = records.get(id);
    if (!record || !isPiSessionEntryRecord(record) || seen.has(id)) throw new Error("archive-branch-invalid");
    seen.add(id); id = record.parentId;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export interface VerifiedRebaseState {
  checkpoint?: RebaseCheckpoint;
  sources: { sessionId: string; sessionFile: string; allowedEntryIds: ReadonlySet<string> }[];
  warnings: string[];
}
/** Default ancestry requires a complete, verified canonical pair on the current branch. */
export function loadRebaseState(sessionFile: string, branch: readonly SessionEntry[], projectPath: string, database?: ContextDatabase): VerifiedRebaseState {
  const sources: VerifiedRebaseState["sources"] = [], warnings: string[] = [];
  const visited = new Set<string>();
  const origins = new Map<string, Map<string, Record<string, unknown>>>();
  const projections: { targetSessionId: string; cp: RebaseCheckpoint; link: RebaseLink }[] = [];
  let file = realpathSync.native(sessionFile), current = branch;
  let checkpoint: RebaseCheckpoint | undefined;
  for (let depth = 0; depth < 16; depth++) {
    const linkEntry = current.find((entry) => entry.type === "custom" && entry.customType === REBASE_LINK_TYPE);
    if (!linkEntry || linkEntry.type !== "custom") break;
    try {
      const link = linkEntry.data as RebaseLink;
      const cpEntry = current.find((entry) => entry.type === "custom" && entry.customType === REBASE_CHECKPOINT_TYPE);
      if (!isRecord(link) || link.schemaVersion !== 1 || !cpEntry || cpEntry.type !== "custom") throw new Error();
      const cp = cpEntry.data as RebaseCheckpoint;
      const header = readSessionHeaderRecord(file).value;
      if (header.version !== 3 || !isRecord(cp) || cp.schemaVersion !== 1 || cp.id !== link.checkpointId || sha256(JSON.stringify(cp)) !== link.checkpointHash
        || cp.sourceSessionId !== link.sourceSessionId || cp.sourceLeafId !== link.sourceLeafId || cp.sourceSize !== link.sourceSize
        || cp.sourceHash !== link.sourceHash || link.targetSessionId !== header.id
        || typeof link.sourceSessionFile !== "string" || dirname(resolve(link.sourceSessionFile)) !== dirname(resolve(file))
        || typeof link.projectPath !== "string" || historyProjectPath(link.projectPath) !== historyProjectPath(projectPath)
        || visited.has(link.sourceSessionId) || !Array.isArray(cp.pins) || !Array.isArray(cp.memories)
        || cp.pins.length > 1_000 || cp.memories.length > 1_000 || typeof cp.handoff !== "string" || cp.handoff.length > 120_000) throw new Error();
      checkPrefix(link.sourceSessionFile, link.sourceSize, link.sourceHash);
      const sourceHeader = readSessionHeaderRecord(link.sourceSessionFile).value;
      if (sourceHeader.version !== 3 || sourceHeader.id !== link.sourceSessionId || typeof sourceHeader.cwd !== "string"
        || historyProjectPath(sourceHeader.cwd) !== historyProjectPath(projectPath)) throw new Error();
      const records = readJsonlRecords(link.sourceSessionFile).records.filter((record) => record.endOffset <= link.sourceSize);
      const byId = new Map<string, Record<string, unknown>>();
      for (const record of records) {
        if (record.value.type === "session") continue;
        if (typeof record.value.id !== "string" || byId.has(record.value.id)) throw new Error();
        byId.set(record.value.id, record.value);
      }
      validateBranch(byId, link.sourceLeafId);
      const source = SessionManager.open(link.sourceSessionFile);
      const ancestors = source.getBranch(link.sourceLeafId);
      if (!ancestors.length || ancestors.at(-1)?.id !== link.sourceLeafId || ancestors.some((entry) => !byId.has(entry.id))) throw new Error();
      origins.set(link.sourceSessionId, byId);
      const handoff = current.find((entry) => entry.type === "custom_message" && entry.customType === "ds4-rebase-handoff-v1");
      if (!handoff || handoff.type !== "custom_message" || handoff.content !== `[ds4:${cp.classification}]${cp.handoff}[/ds4:${cp.classification}]`
        || !isPrivacyClassification(cp.classification) || typeof header.cwd !== "string"
        || historyProjectPath(header.cwd) !== historyProjectPath(projectPath)) throw new Error();
      visited.add(link.sourceSessionId);
      sources.push({ sessionId: link.sourceSessionId, sessionFile: link.sourceSessionFile, allowedEntryIds: new Set(ancestors.map((entry) => entry.id)) });
      if (!checkpoint) checkpoint = cp;
      projections.push({ targetSessionId: String(header.id), cp, link });
      file = link.sourceSessionFile; current = ancestors;
      if (depth === 15) warnings.push("lineage-depth-limit");
    } catch { warnings.push("lineage-integrity-unavailable"); break; }
  }
  if (checkpoint && !warnings.length) {
    try {
      for (const { cp } of projections) for (const item of [...cp.pins, ...cp.memories]) {
        if (!isRecord(item) || !isRecord(item.provenance) || item.status !== "active" || item.scope === "project") throw new Error();
        const origin = origins.get(String(item.provenance.sourceSessionId))?.get(String(item.provenance.mutationEntryId));
        const payload = origin && isRecord(origin.data) ? origin.data : undefined;
        const original = payload && isRecord(payload.item) ? payload.item : undefined;
        if (origin?.type !== "custom" || origin.customType !== ("content" in item ? PIN_CUSTOM_ENTRY_TYPE : MEMORY_CUSTOM_ENTRY_TYPE)
          || payload?.schemaVersion !== 1 || !original || original.id !== item.id || original.scope !== item.scope || original.classification !== item.classification
          || ("content" in item ? original.content !== item.content : original.claim !== item.claim)) throw new Error();
        if ("content" in item && item.scope === "branch"
          && (original.branchLeafId !== item.branchLeafId
            || !sources.find((source) => source.sessionId === item.provenance.sourceSessionId)?.allowedEntryIds.has(String(item.branchLeafId)))) throw new Error();
      }
    } catch { checkpoint = undefined; warnings.push("checkpoint-memory-provenance-invalid"); }
  }
  if (!warnings.length) for (const { targetSessionId, cp, link } of projections) {
    try { database?.rebase.project(targetSessionId, cp, link); } catch { /* Canonical verification does not depend on an available projection. */ }
  }
  return { ...(checkpoint ? { checkpoint } : {}), sources, warnings };
}
export class PiSessionRebase {
  private active = false;
  isActive(): boolean { return this.active; }
  async run(ctx: ExtensionCommandContext, access: RebaseAccess, options: { dryRun?: boolean; recover?: string } = {}): Promise<RebaseResult> {
    if (!access.config.enabled || !access.config.sessionRebase.enabled) return { status: "unavailable", warnings: ["disabled"] };
    if (!access.config.historyTools.enabled) return { status: "unavailable", warnings: ["history-tools-required"] };
    if (!ctx.isProjectTrusted()) return { status: "unavailable", warnings: ["project-untrusted"] };
    if (this.active || access.compactionActive()) return { status: "unavailable", warnings: ["compaction-or-rebase-busy"] };
    await ctx.waitForIdle();
    if (this.active || !ctx.isIdle() || ctx.hasPendingMessages() || access.compactionActive()) return { status: "unavailable", warnings: ["session-busy"] };
    const currentFile = ctx.sessionManager.getSessionFile();
    if (!currentFile || !existsSync(currentFile)) return { status: "unavailable", warnings: ["ephemeral-session"] };
    let operation: RebaseOperation | undefined, release: (() => void) | undefined;
    let activated = false;
    let toolExchangeDiagnostics: RebaseResult["toolExchangeDiagnostics"];
    this.active = true;
    try {
      let sourceFile = realpathSync.native(currentFile);
      if (options.recover) {
        const state = loadRebaseState(currentFile, ctx.sessionManager.getBranch(), access.projectPath);
        if (state.sources.length) sourceFile = state.sources[0]!.sessionFile;
        const path = journalPath(sourceFile, options.recover);
        if (!existsSync(path) || statSync(path).size > 32_000) throw new Error("operation-unavailable");
        operation = JSON.parse(readFileSync(path, "utf8")) as RebaseOperation;
        if (operation.id !== options.recover || operation.schemaVersion !== 1 || operation.sourceSessionFile !== sourceFile
          || historyProjectPath(operation.projectPath) !== historyProjectPath(access.projectPath)
          || dirname(resolve(operation.targetSessionFile)) !== dirname(resolve(sourceFile))) throw new Error("operation-integrity");
      }
      release = acquireRebaseLock(sourceFile);
      const header = readSessionHeaderRecord(sourceFile).value;
      // SessionManager.open() migrates older formats on disk: never let a read/rebase rewrite its source.
      if (header.version !== 3) throw new Error("unsupported-source-version");
      if (typeof header.cwd !== "string" || historyProjectPath(header.cwd) !== historyProjectPath(access.projectPath)) throw new Error("source-scope-mismatch");
      const archive = readJsonlRecords(sourceFile);
      if (archive.malformedLines || archive.safeCheckpointOffset !== archive.fileSize) throw new Error("archive-incomplete");
      const entryIds = new Set<string>();
      const sourceRecords = new Map<string, Record<string, unknown>>();
      for (const record of archive.records) {
        const id = record.value.id;
        if (record.value.type === "session") continue;
        if (typeof id !== "string" || entryIds.has(id) || !isPiSessionEntryRecord(record.value)) throw new Error("archive-invalid-ids");
        entryIds.add(id); sourceRecords.set(id, record.value);
      }
      const leaf = operation?.sourceLeafId ?? ctx.sessionManager.getLeafId();
      if (!leaf) throw new Error("source-empty");
      validateBranch(sourceRecords, leaf);
      const manager = SessionManager.open(sourceFile);
      const branch = manager.getBranch(leaf);
      if (branch.at(-1)?.id !== leaf) throw new Error("source-leaf-unavailable");
      // The active Pi leaf can precede the last physical JSONL row after tree navigation.
      // Build the handoff from THAT captured branch, never from SessionManager.open()'s default leaf.
      manager.branch(leaf);
      if (loadRebaseState(sourceFile, branch, access.projectPath).warnings.length) throw new Error("lineage-integrity-unavailable");
      // Validate exactly what the checkpoint transfers, not tool operations already
      // excluded by Pi compaction. Reuse this captured context for the handoff below.
      const contextEntries = manager.buildContextEntries();
      const core = contextEntries.flatMap((entry) => sessionEntryToContextMessages(entry));
      const atomic = validateAtomicSelection(core, new Set(core.map((_, i) => i)));
      const branchCore = branch.flatMap((entry) => sessionEntryToContextMessages(entry));
      const branchIssues = validateAtomicSelection(branchCore, new Set(branchCore.map((_, i) => i)));
      const activeIssues = new Set(atomic);
      toolExchangeDiagnostics = { activeIssueCount: atomic.length,
        historicalIssueCount: branchIssues.filter((issue) => !activeIssues.has(issue)).length };
      if (atomic.length) throw new Error("pending-or-orphan-tool-exchange");
      const sourceHash = operation?.sourceHash ?? hashFileRange(sourceFile, 0, archive.fileSize);
      const sourceSize = operation?.sourceSize ?? archive.fileSize;
      checkPrefix(sourceFile, sourceSize, sourceHash);
      if (operation && operation.sourceSessionId !== header.id) throw new Error("operation-integrity");
      if (!operation) {
        const id = `rebase_${sha256(`${header.id}:${leaf}:${sourceHash}`).slice(0, 32)}`;
        const existing = journalPath(sourceFile, id);
        if (existsSync(existing)) throw new Error("operation-exists-use-recover");
        const targetSessionId = randomUUID();
        operation = { schemaVersion: 1, id, phase: "Prepared", projectPath: access.projectPath, sourceSessionId: String(header.id),
          sourceSessionFile: sourceFile, sourceLeafId: leaf, sourceSize, sourceHash, targetSessionId,
          targetSessionFile: join(dirname(sourceFile), `ds4-${id}.jsonl`), createdAt: Date.now(), updatedAt: Date.now() };
      }
      const phase = (value: RebasePhase): void => {
        operation!.phase = value; operation!.updatedAt = Date.now();
        writeDurable(journalPath(sourceFile, operation!.id), JSON.stringify(operation), true);
        try { access.database.rebase.projectOperation(operation!); } catch { /* Canonical journal is already durable; projection can rebuild. */ }
        access.afterPhase?.(value);
      };
      let checkpoint: RebaseCheckpoint;
      if (existsSync(operation.targetSessionFile)) {
        checkTargetPrefix(operation);
        if (readSessionHeaderRecord(operation.targetSessionFile).value.version !== 3) throw new Error("target-integrity");
        const state = loadRebaseState(operation.targetSessionFile, SessionManager.open(operation.targetSessionFile).getBranch(), access.projectPath, access.database);
        if (!state.checkpoint || state.warnings.length || state.checkpoint.id !== `checkpoint_${sha256(`${header.id}:${leaf}:${sourceHash}`).slice(0, 32)}`) throw new Error("target-integrity");
        checkpoint = state.checkpoint;
      } else {
        if (operation.sourceSize !== archive.fileSize || operation.sourceLeafId !== ctx.sessionManager.getLeafId()
          || ctx.sessionManager.getSessionId() !== header.id) throw new Error("source-moved-before-checkpoint");
        const snapshot = access.snapshotMemory();
        if (snapshot.pins.length > 1_000 || snapshot.memories.length > 1_000) throw new Error("checkpoint-memory-budget");
        const texts = contextEntries.map((entry) => JSON.stringify(entry));
        let classification: PrivacyClassification = access.config.privacy.defaultClassification;
        for (const value of texts) classification = highestClassification(classification, classifyMarkedContent(value) ?? classification);
        classification = highestClassification(classification, historyPrivacyClassification(contextEntries) ?? classification);
        // Whole entries are retained as quoted state; a giant live tail blocks rebase rather than silently discarding it.
        checkpoint = buildRebaseCheckpoint({ sourceSessionId: String(header.id), sourceLeafId: leaf, sourceSize, sourceHash,
          sourceCompactionCount: branch.filter((entry) => entry.type === "compaction").length, createdAt: operation.createdAt,
          canonicalContext: texts.join("\n"), targetTokens: access.config.sessionRebase.checkpointTargetTokens,
          classification, pins: snapshot.pins, memories: snapshot.memories });
        if (JSON.stringify(checkpoint).length > 1024 * 1024) throw new Error("checkpoint-memory-budget");
      }
      const result: RebaseResult = { status: options.dryRun ? "preview" : "verified", operationId: operation.id, checkpointId: checkpoint.id,
        sourceEntries: archive.records.length - 1, sourceBytes: sourceSize, checkpointTokens: estimateTextTokens(checkpoint.handoff),
        preservedPins: checkpoint.pins.length, preservedMemories: checkpoint.memories.length, warnings: [...checkpoint.limitations], toolExchangeDiagnostics };
      if (options.dryRun) return result;
      if (!existsSync(operation.targetSessionFile)) {
        phase("Prepared"); phase("ArchiveVerified");
        const link: RebaseLink = { schemaVersion: 1, operationId: operation.id, checkpointId: checkpoint.id,
          checkpointHash: sha256(JSON.stringify(checkpoint)), sourceSessionId: operation.sourceSessionId, sourceSessionFile: sourceFile,
          sourceLeafId: leaf, sourceSize, sourceHash, projectPath: access.projectPath, targetSessionId: operation.targetSessionId };
        const target = SessionManager.create(access.projectPath, dirname(sourceFile));
        target.appendCustomEntry(REBASE_CHECKPOINT_TYPE, checkpoint);
        target.appendCustomEntry(REBASE_LINK_TYPE, link);
        target.appendCustomMessageEntry("ds4-rebase-handoff-v1", `[ds4:${checkpoint.classification}]${checkpoint.handoff}[/ds4:${checkpoint.classification}]`, false);
        const bytes = [{ ...target.getHeader(), id: operation.targetSessionId, parentSession: sourceFile }, ...target.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
        operation.targetHash = sha256(bytes);
        operation.targetSize = Buffer.byteLength(bytes, "utf8");
        // Persist the staged fingerprint BEFORE installation: a crash between install and
        // TargetCreated must still leave enough durable metadata to verify the target.
        phase("CheckpointReady");
        // Atomic no-overwrite install. Unlike Pi setup metadata alone, this canonical JSONL exists before switchSession.
        writeDurable(operation.targetSessionFile, bytes, false);
        phase("TargetCreated");
      }
      checkPrefix(sourceFile, sourceSize, sourceHash);
      checkTargetPrefix(operation);
      const verified = loadRebaseState(operation.targetSessionFile, SessionManager.open(operation.targetSessionFile).getBranch(), access.projectPath, access.database);
      if (!verified.checkpoint || verified.warnings.length) throw new Error("target-integrity");
      const replaced = await ctx.switchSession(operation.targetSessionFile, { withSession: async (fresh) => {
        if (fresh.sessionManager.getSessionId() !== operation!.targetSessionId) throw new Error("target-identity");
        activated = true;
        try {
          phase("Activated");
          const restored = loadRebaseState(operation!.targetSessionFile, fresh.sessionManager.getBranch(), access.projectPath, access.database);
          if (!restored.checkpoint || restored.warnings.length) throw new Error("target-integrity");
          checkPrefix(sourceFile, sourceSize, sourceHash);
          phase("Verified");
          fresh.ui.notify(`DS4 rebase verified: ${operation!.id}. Source preserved; historical verification remains unknown.`, "info");
        } catch (error) {
          fresh.ui.notify(`DS4 rebase recoverable: ${operation!.id}. Do not delete the source.`, "warning");
          throw error;
        }
      } });
      if (replaced.cancelled || !activated) throw new Error("activation-cancelled");
      return { ...result, phase: "Verified", sessionReplaced: true };
    } catch (error) {
      const code = error instanceof Error && /^[a-z-]{1,64}$/u.test(error.message) ? error.message : "rebase-unavailable";
      if (operation && !options.dryRun && release) {
        operation.phase = "Recoverable"; operation.errorCode = code; operation.updatedAt = Date.now();
        try { writeDurable(journalPath(operation.sourceSessionFile, operation.id), JSON.stringify(operation), true); } catch { /* Previous durable journal remains recoverable. */ }
        try { access.database.rebase.projectOperation(operation); } catch { /* Projection is optional. */ }
        return { status: "recoverable", operationId: operation.id, phase: "Recoverable", sessionReplaced: activated, warnings: [code],
          ...(toolExchangeDiagnostics ? { toolExchangeDiagnostics } : {}) };
      }
      return { status: "unavailable", warnings: [code], ...(toolExchangeDiagnostics ? { toolExchangeDiagnostics } : {}) };
    } finally { this.active = false; release?.(); }
  }
}
