import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { sha256 } from "ds4-context-core/shared/hash";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "ds4-context-core/config/config";
import { ContextDatabase } from "ds4-context-core/persistence/sqlite";
import { MemoryManager } from "ds4-context-core/memory/memory-manager";
import { MEMORY_CUSTOM_ENTRY_TYPE as MEMORY_MUTATION_ENTRY_TYPE, PIN_CUSTOM_ENTRY_TYPE as PIN_MUTATION_ENTRY_TYPE } from "ds4-context-core/memory/memory-types";
import { REBASE_CHECKPOINT_TYPE, REBASE_LINK_TYPE, type RebaseOperation, type RebasePhase } from "ds4-context-core/rebase/rebase-types";
import { PiSessionIndexer } from "../../src/pi-adapter/session-indexer.ts";
import { projectSessionMutations } from "../../src/pi-adapter/memory-adapter.ts";
import { PiSessionRebase, loadRebaseState, type RebaseAccess } from "../../src/pi-adapter/session-rebase.ts";
import { PiHistoryService } from "../../src/pi-adapter/history-service.ts";
import { acquireRebaseLock } from "../../src/pi-adapter/rebase-lock.ts";
import { HISTORY_RESULT_SCHEMA } from "ds4-context-core/retrieval/history-privacy";
import { providerPrivacyPolicy, sanitizeClassifiedText } from "ds4-context-core/privacy/privacy-policy";
import { sanitizeHistoryEgress } from "../../src/extension/context-history-egress.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const clean of cleanups.splice(0).reverse()) clean(); });
function fixture(withMemory = false) {
  const dir = mkdtempSync(join(tmpdir(), "ds4-rebase-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = ContextDatabase.open(join(dir, "index.db")); cleanups.push(() => db.close());
  const file = join(dir, "source.jsonl");
  writeFileSync(file, [
    { type: "session", version: 3, id: "source", cwd: dir, timestamp: "2026-01-01T00:00:00Z" },
    { type: "message", id: "old", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "LastExportUtc old original decision", timestamp: 1 } },
    { type: "message", id: "answer", parentId: "old", timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "Noted." }], timestamp: 2, stopReason: "stop", api: "openai-completions", model: "offline", provider: "local", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
    { type: "compaction", id: "compact", parentId: "answer", timestamp: "2026-01-01T00:00:03Z", summary: "Compact summary omitted the historical nullable decision.", firstKeptEntryId: "answer", tokensBefore: 100 },
    { type: "message", id: "task", parentId: "compact", timestamp: "2026-01-01T00:00:04Z", message: { role: "user", content: "Continue the implementation", timestamp: 4 } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n");
  let manager = SessionManager.open(file), seq = 0;
  const config = structuredClone(DEFAULT_CONFIG); config.historyTools.enabled = true; config.sessionRebase.enabled = true;
  const indexer = new PiSessionIndexer(db.sessionIndex);
  function sync(target: SessionManager, database = db) {
    new PiSessionIndexer(database.sessionIndex).sync({ sessionId: target.getSessionId(), sessionFile: target.getSessionFile()!,
      projectPath: dir, totalEntries: target.getEntries().length, branchEntries: target.getBranch().length });
  }
  function memory(target: SessionManager, database = db) {
    return new MemoryManager(database.memory, config.memory, 12000, 12000, target.getSessionId(), dir, true,
      () => Date.now(), () => `item-${++seq}`);
  }
  sync(manager); const sourceMemory = memory(manager);
  if (withMemory) {
    const ids = new Set(manager.getBranch().map((entry) => entry.id));
    const proposal = sourceMemory.proposePin({ content: "Keep the original confirmed constraint", scope: "branch", branchLeafId: "task", sourceEntryId: "old", activeEntryIds: ids });
    manager.appendCustomEntry(PIN_MUTATION_ENTRY_TYPE, proposal.mutation!);
    const mem = sourceMemory.proposeMemory({ claim: "LastExportUtc stays nullable", scope: "session", sourceEntryIds: ["old"], activeEntryIds: ids });
    manager.appendCustomEntry(MEMORY_MUTATION_ENTRY_TYPE, mem.mutation!);
    sync(manager); sourceMemory.reconcile(projectSessionMutations(manager.getEntries(), manager.getSessionId()));
  }
  const ctx = { cwd: dir, sessionManager: manager, ui: { notify: vi.fn() },
    isProjectTrusted: () => true, isIdle: () => true, hasPendingMessages: () => false, waitForIdle: async () => {},
    switchSession: async (target: string, options: { withSession?: (fresh: unknown) => Promise<void> }) => {
      // A persisted complete target must exist before any SDK replacement.
      expect(existsSync(target)).toBe(true);
      const parsed = SessionManager.open(target);
      expect(parsed.getEntries().some((entry) => entry.type === "custom" && entry.customType === REBASE_CHECKPOINT_TYPE)).toBe(true);
      manager = parsed;
      (ctx as unknown as { sessionManager: SessionManager }).sessionManager = parsed;
      await options.withSession?.({ sessionManager: parsed, ui: ctx.ui });
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;
  const access: RebaseAccess = { config, database: db, projectPath: dir, compactionActive: () => false,
    snapshotMemory: () => ({ pins: sourceMemory.listPins(true), memories: sourceMemory.listMemories(true) }) };
  return { dir, db, file, ctx, access, config, sourceMemory, indexer, sync, memory, manager: () => manager };
}

describe("recoverable canonical session rebase", () => {
  it("previews without journal/target creation, then activates a durable target preserving source bytes and original recall", async () => {
    const f = fixture(), original = readFileSync(f.file);
    const preview = await new PiSessionRebase().run(f.ctx, f.access, { dryRun: true });
    expect(preview.status).toBe("preview"); expect(existsSync(join(f.dir, ".ds4-rebase", "operations"))).toBe(false);
    const result = await new PiSessionRebase().run(f.ctx, f.access);
    expect(result.status).toBe("verified"); expect(result.sessionReplaced).toBe(true);
    expect(readFileSync(f.file)).toEqual(original);
    const target = f.manager(), state = loadRebaseState(target.getSessionFile()!, target.getBranch(), f.dir, f.db);
    expect(state.warnings).toEqual([]); expect(state.sources[0]?.sessionId).toBe("source");
    expect(state.checkpoint?.verificationState).toBe("unknown");
    expect(target.getHeader()?.parentSession).toBe(f.file);
    const recall = new PiHistoryService().recall({ config: f.config, repository: f.db.sessionIndex, sessionManager: target,
      projectPath: f.dir, projectTrusted: true, lineage: state.sources, sanitize: (text) => ({ text, omitted: false, classification: "normal" }) }, { query: "LastExportUtc", scope: "current-lineage" });
    expect(recall.hits?.some((hit) => hit.entryId === "old" && hit.relation === "lineage-ancestor")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(f.file);
    const journal = JSON.parse(readFileSync(join(f.dir, ".ds4-rebase", "operations", `${result.operationId}.json`), "utf8")) as RebaseOperation;
    expect(journal.phase).toBe("Verified");
  });
  it.each(["Prepared", "ArchiveVerified", "CheckpointReady", "TargetCreated", "Activated", "Verified"] as RebasePhase[])("recovers idempotently after interruption at %s without duplicate targets", async (cut) => {
    const f = fixture(), original = readFileSync(f.file);
    f.access.afterPhase = (phase) => { if (phase === cut) throw new Error("simulated-crash"); };
    const interrupted = await new PiSessionRebase().run(f.ctx, f.access);
    expect(interrupted.status).toBe("recoverable");
    delete f.access.afterPhase;
    const recovered = await new PiSessionRebase().run(f.ctx, f.access, { recover: interrupted.operationId! });
    expect(recovered.status).toBe("verified"); expect(recovered.operationId).toBe(interrupted.operationId);
    const again = await new PiSessionRebase().run(f.ctx, f.access, { recover: recovered.operationId! });
    expect(again.status).toBe("verified"); expect(readFileSync(f.file)).toEqual(original);
    const target = f.manager();
    expect(target.getEntries().filter((entry) => entry.type === "custom" && entry.customType === REBASE_CHECKPOINT_TYPE)).toHaveLength(1);
    expect(target.getEntries().filter((entry) => entry.type === "custom" && entry.customType === REBASE_LINK_TYPE)).toHaveLength(1);
  });
  it.each(["TargetCreated", "Verified"] as RebasePhase[])("rejects changed staged target bytes during recovery after %s even when lineage remains valid", async (cut) => {
    const f = fixture(), original = readFileSync(f.file);
    f.access.afterPhase = (phase) => { if (phase === cut) throw new Error("simulated-crash"); };
    const interrupted = await new PiSessionRebase().run(f.ctx, f.access);
    expect(interrupted.status).toBe("recoverable");
    delete f.access.afterPhase;
    const operation = JSON.parse(readFileSync(join(f.dir, ".ds4-rebase", "operations", `${interrupted.operationId}.json`), "utf8")) as RebaseOperation;
    const records = readFileSync(operation.targetSessionFile, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const checkpoint = records.find((entry) => entry.type === "custom" && entry.customType === REBASE_CHECKPOINT_TYPE)!;
    checkpoint.timestamp = "2000-01-01T00:00:00.000Z";
    writeFileSync(operation.targetSessionFile, records.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const target = SessionManager.open(operation.targetSessionFile);
    expect(loadRebaseState(operation.targetSessionFile, target.getBranch(), f.dir).warnings).toEqual([]);
    const recovered = await new PiSessionRebase().run(f.ctx, f.access, { recover: interrupted.operationId! });
    expect(recovered.status).toBe("recoverable");
    expect(recovered.warnings).toContain("target-integrity");
    expect(readFileSync(f.file)).toEqual(original);
  });
  it("recovers an installed target when the durable journal still says CheckpointReady", async () => {
    const f = fixture(), original = readFileSync(f.file);
    f.access.afterPhase = (phase) => { if (phase === "TargetCreated") throw new Error("simulated-crash"); };
    const interrupted = await new PiSessionRebase().run(f.ctx, f.access);
    delete f.access.afterPhase;
    const journal = join(f.dir, ".ds4-rebase", "operations", `${interrupted.operationId}.json`);
    const operation = JSON.parse(readFileSync(journal, "utf8")) as RebaseOperation;
    expect(operation.targetSize).toBe(readFileSync(operation.targetSessionFile).length);
    expect(operation.targetHash).toBe(sha256(readFileSync(operation.targetSessionFile)));
    operation.phase = "CheckpointReady";
    writeFileSync(journal, JSON.stringify(operation));
    const recovered = await new PiSessionRebase().run(f.ctx, f.access, { recover: interrupted.operationId! });
    expect(recovered.status).toBe("verified");
    expect(readFileSync(f.file)).toEqual(original);
  });
  it("permits idempotent recovery after legitimate append-only target continuation", async () => {
    const f = fixture(), original = readFileSync(f.file);
    const result = await new PiSessionRebase().run(f.ctx, f.access);
    expect(result.status).toBe("verified");
    const target = f.manager(), targetId = target.getSessionId();
    target.appendMessage({ role: "user", content: "Legitimate continuation after activation", timestamp: 5 });
    const targetBytes = readFileSync(target.getSessionFile()!);
    const recovered = await new PiSessionRebase().run(f.ctx, f.access, { recover: result.operationId! });
    expect(recovered.status).toBe("verified");
    expect(f.manager().getSessionId()).toBe(targetId);
    expect(readFileSync(f.manager().getSessionFile()!)).toEqual(targetBytes);
    expect(readFileSync(f.file)).toEqual(original);
  });
  it.each(["Prepared", "ArchiveVerified", "CheckpointReady", "TargetCreated", "Activated", "Verified"] as RebasePhase[])("recovers a real process exit at %s from canonical files after index loss", async (phase) => {
    const f = fixture(), original = readFileSync(f.file);
    const runner = fileURLToPath(new URL("../fixtures/rebase-crash-runner.mjs", import.meta.url));
    const crashed = spawnSync(process.execPath, [runner, f.file, phase], { encoding: "utf8", timeout: 15_000 });
    expect(crashed.stderr, "Crash harness must load the actual adapter offline").not.toMatch(/Error:/u);
    expect(crashed.status, crashed.stderr).toBe(91);
    const operations = join(f.dir, ".ds4-rebase", "operations");
    const path = join(operations, readdirSync(operations).find((name) => name.endsWith(".json"))!);
    const operation = JSON.parse(readFileSync(path, "utf8")) as RebaseOperation;
    expect(operation.phase).toBe(phase);
    if (["CheckpointReady", "TargetCreated", "Activated", "Verified"].includes(phase)) {
      expect(operation.targetSize).toBeGreaterThan(0);
      expect(operation.targetHash).toMatch(/^[a-f0-9]{64}$/u);
    }
    rmSync(join(f.dir, "crash-projection.db"), { force: true });
    const result = await new PiSessionRebase().run(f.ctx, f.access, { recover: operation.id });
    expect(result.status).toBe("verified"); expect(readFileSync(f.file)).toEqual(original);
  }, 20_000);

  it("rebuilds checkpoint/lineage from JSONL after the entire main index is lost and keeps inherited memory provenance/status local", async () => {
    const f = fixture(true), sourcePins = f.sourceMemory.listPins(true), sourceMemories = f.sourceMemory.listMemories(true);
    const result = await new PiSessionRebase().run(f.ctx, f.access);
    expect(result.status).toBe("verified");
    const target = f.manager(), original = readFileSync(f.file);
    const rebuilt = ContextDatabase.open(join(f.dir, "rebuilt.db")); cleanups.push(() => rebuilt.close());
    const state = loadRebaseState(target.getSessionFile()!, target.getBranch(), f.dir, rebuilt);
    expect(state.warnings).toEqual([]); expect(state.checkpoint?.pins).toEqual(sourcePins); expect(state.checkpoint?.memories).toEqual(sourceMemories);
    f.sync(target, rebuilt); const inherited = f.memory(target, rebuilt);
    inherited.reconcile(projectSessionMutations(target.getEntries(), target.getSessionId()));
    inherited.setInheritance(state.checkpoint!.pins, state.checkpoint!.memories, projectSessionMutations(target.getBranch(), target.getSessionId()));
    expect(inherited.listPins(true)).toEqual(sourcePins); expect(inherited.listMemories(true)).toEqual(sourceMemories);
    expect(inherited.select("LastExportUtc", new Set(target.getBranch().map((entry) => entry.id))).pins).toHaveLength(1);
    expect(inherited.listPinsPage(true, [], 1).items).toEqual(sourcePins);
    expect(inherited.scanMemoriesBounded(true, 1, 1)).toMatchObject({ items: sourceMemories, incomplete: false });
    target.appendCustomEntry(PIN_MUTATION_ENTRY_TYPE, inherited.proposeUnpin(sourcePins[0]!.id));
    target.appendCustomEntry(MEMORY_MUTATION_ENTRY_TYPE, inherited.proposeMemoryStatus(sourceMemories[0]!.id, "invalid"));
    f.sync(target, rebuilt); inherited.reconcile(projectSessionMutations(target.getEntries(), target.getSessionId()));
    inherited.setInheritance(state.checkpoint!.pins, state.checkpoint!.memories, projectSessionMutations(target.getBranch(), target.getSessionId()));
    expect(inherited.listPins(true)).toEqual([]); expect(inherited.listMemories(true)).toEqual([]);
    expect(f.sourceMemory.listPins(true)).toEqual(sourcePins); expect(f.sourceMemory.listMemories(true)).toEqual(sourceMemories);
    expect(readFileSync(f.file)).toEqual(original);
    // The canonical target mutation survives restart without rewriting its origin's rows.
    const reopened = SessionManager.open(target.getSessionFile()!);
    inherited.setInheritance(state.checkpoint!.pins, state.checkpoint!.memories, projectSessionMutations(reopened.getBranch(), reopened.getSessionId()));
    expect(inherited.listPins(true)).toEqual([]);
  });
  it("blocks incomplete archives, pending tools, budget overflow, untrusted/disabled/busy boundaries and source corruption", async () => {
    const f = fixture();
    f.access.compactionActive = () => true;
    expect((await new PiSessionRebase().run(f.ctx, f.access)).warnings).toContain("compaction-or-rebase-busy");
    f.access.compactionActive = () => false; f.config.sessionRebase.enabled = false;
    expect((await new PiSessionRebase().run(f.ctx, f.access)).warnings).toContain("disabled");
    f.config.sessionRebase.enabled = true;
    const before = readFileSync(f.file);
    appendFileSync(f.file, '{"partial":');
    expect((await new PiSessionRebase().run(f.ctx, f.access)).warnings).toContain("archive-incomplete");
    writeFileSync(f.file, before);
    f.manager().appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "pending", name: "read", arguments: { path: "not-opened" } }], stopReason: "toolUse", timestamp: Date.now(), api: "openai-completions", provider: "local", model: "offline", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    expect((await new PiSessionRebase().run(f.ctx, f.access)).warnings).toContain("pending-or-orphan-tool-exchange");
  });
  it("captures the active branch rather than the last physical sibling JSONL row", async () => {
    const f = fixture();
    f.manager().appendMessage({ role: "user", content: "WRONG_SIBLING_PAYLOAD", timestamp: Date.now() });
    f.manager().branch("task");
    const bytes = readFileSync(f.file);
    const result = await new PiSessionRebase().run(f.ctx, f.access);
    expect(result.status).toBe("verified");
    const state = loadRebaseState(f.manager().getSessionFile()!, f.manager().getBranch(), f.dir);
    expect(state.checkpoint?.sourceLeafId).toBe("task");
    expect(state.checkpoint?.handoff).not.toContain("WRONG_SIBLING_PAYLOAD");
    expect(readFileSync(f.file)).toEqual(bytes);
  });

  it("carries local-only classification from serialized history results into the canonical handoff", async () => {
    const f = fixture();
    const entry = f.manager().getEntries().find((value) => value.type === "message" && value.message.role === "assistant");
    if (!entry || entry.type !== "message" || entry.message.role !== "assistant") throw new Error("fixture-assistant-missing");
    f.manager().appendMessage({ ...entry.message, timestamp: Date.now(), stopReason: "toolUse",
      content: [{ type: "toolCall", id: "history-read", name: "context_history_read", arguments: { sourceRef: "hist_" + "a".repeat(32) } }] });
    f.manager().appendMessage({ role: "toolResult", toolCallId: "history-read", toolName: "context_history_read", timestamp: Date.now(), isError: false,
      content: [{ type: "text", text: JSON.stringify({ schema: HISTORY_RESULT_SCHEMA, quotedData: true,
        hits: [{ classification: "local-only", excerpt: "private-context-from-local" }] }) }] });
    const result = await new PiSessionRebase().run(f.ctx, f.access);
    expect(result.status).toBe("verified");
    const state = loadRebaseState(f.manager().getSessionFile()!, f.manager().getBranch(), f.dir);
    expect(state.checkpoint?.classification).toBe("local-only");
    const handoff = f.manager().getEntries().find((value) => value.type === "custom_message");
    const remote = sanitizeHistoryEgress(handoff, (text, floor) => {
      const safe = sanitizeClassifiedText(text, providerPrivacyPolicy(f.config.privacy, "openai"), floor ?? "normal", true);
      return { text: safe.value, omitted: safe.blockedBlocks > 0 };
    });
    expect(JSON.stringify(remote.value)).not.toContain("private-context-from-local");
  });

  it("blocks legacy-source migration, parent cycles, untrusted projects and oversized handoffs", async () => {
    const f = fixture();
    const initial = readFileSync(f.file, "utf8");
    writeFileSync(f.file, initial.replace('"version":3', '"version":2'));
    const legacy = readFileSync(f.file);
    expect((await new PiSessionRebase().run(f.ctx, f.access)).warnings).toContain("unsupported-source-version");
    expect(readFileSync(f.file)).toEqual(legacy);
    writeFileSync(f.file, initial.replace('"parentId":null', '"parentId":"old"'));
    expect((await new PiSessionRebase().run(f.ctx, f.access)).warnings).toContain("archive-branch-invalid");
    writeFileSync(f.file, initial);
    const untrusted = { ...f.ctx, isProjectTrusted: () => false };
    expect((await new PiSessionRebase().run(untrusted, f.access)).warnings).toContain("project-untrusted");
    f.manager().appendMessage({ role: "user", content: "x".repeat(4000), timestamp: Date.now() });
    f.config.sessionRebase.checkpointTargetTokens = 512;
    expect((await new PiSessionRebase().run(f.ctx, f.access, { dryRun: true })).warnings).toContain("checkpoint-budget");
  });

  it.skipIf(process.platform === "win32")("canonicalizes symlink aliases to the same lock/journal/target identity", async () => {
    const f = fixture(), original = readFileSync(f.file);
    mkdirSync(join(f.dir, "aliases"));
    const alias = join(f.dir, "aliases", "alias.jsonl"); symlinkSync(f.file, alias);
    Object.assign(f.ctx, { sessionManager: SessionManager.open(alias) });
    const first = await new PiSessionRebase().run(f.ctx, f.access);
    expect(first.status).toBe("verified");
    Object.assign(f.ctx, { sessionManager: SessionManager.open(f.file) });
    const again = await new PiSessionRebase().run(f.ctx, f.access);
    expect(again.warnings).toContain("operation-exists-use-recover");
    expect(readdirSync(f.dir).filter((name) => name.startsWith("ds4-rebase_") && name.endsWith(".jsonl"))).toHaveLength(1);
    expect(readFileSync(f.file)).toEqual(original);
  });

  it("does not infer lineage from parentSession alone and rejects edited handoffs or source headers", async () => {
    const f = fixture();
    await new PiSessionRebase().run(f.ctx, f.access);
    const target = f.manager(), bytes = readFileSync(target.getSessionFile()!, "utf8");
    writeFileSync(target.getSessionFile()!, bytes.replace("This is a deterministic handoff", "This is a malicious replacement"));
    expect(loadRebaseState(target.getSessionFile()!, SessionManager.open(target.getSessionFile()!).getBranch(), f.dir).warnings).toContain("lineage-integrity-unavailable");
    writeFileSync(target.getSessionFile()!, bytes);
    writeFileSync(f.file, readFileSync(f.file, "utf8").replace("LastExportUtc", "ChangedField"));
    expect(loadRebaseState(target.getSessionFile()!, target.getBranch(), f.dir).warnings).toContain("lineage-integrity-unavailable");
    expect(loadRebaseState(target.getSessionFile()!, [], f.dir).sources).toEqual([]);
  });
  it("uses a real inter-process lock released by process death, independently of the rebuildable index", async () => {
    const f = fixture();
    const release = acquireRebaseLock(f.file); release();
    const path = join(dirname(f.file), ".ds4-rebase", "locks", `${sha256(f.file)}.sqlite`);
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); console.log('ready'); setTimeout(()=>{},10000);`, path], { stdio: ["ignore", "pipe", "pipe"] });
    cleanups.push(() => child.kill());
    await once(child.stdout!, "data");
    expect(() => acquireRebaseLock(f.file)).toThrow("rebase-busy");
    child.kill("SIGKILL"); await once(child, "exit");
    const recovered = acquireRebaseLock(f.file); recovered();
  });
});
