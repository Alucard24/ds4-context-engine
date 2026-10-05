import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Ds4ContextConfig } from "ds4-context-core/config/config";
import type { SessionIndexRepository } from "ds4-context-core/persistence/repositories/session-index-repository";
import { HistoricalRetrievalEngine, excerptAroundTerms } from "ds4-context-core/retrieval/retrieval-engine";
import { historyPrivacyClassification } from "ds4-context-core/retrieval/history-privacy";
import { describeTask } from "ds4-context-core/retrieval/task-descriptor";
import { validateHistoryQuery, type HistoryRecallRequest, type HistoryScope } from "ds4-context-core/retrieval/history-query";
import type { PrivacyClassification } from "ds4-context-core/privacy/privacy-policy";
import { highestClassification } from "ds4-context-core/privacy/privacy-policy";
import { sha256 } from "ds4-context-core/shared/hash";
import { estimateTextTokens } from "ds4-context-core/core/token-estimator";
import { PiSessionIndexer } from "./session-indexer.ts";
import { listPiSessionFiles, readSessionHeaderRecord } from "./session-jsonl.ts";
import { historyProjectPath, readHistorySource, type HistorySource } from "./history-source-reader.ts";
import { HISTORY_RESULT_SCHEMA, historyUnavailable, renderHistoryResult, type HistoryHit, type HistoryResult } from "../extension/context-history-contract.ts";

export interface HistoryAccess {
  config: Ds4ContextConfig;
  repository: SessionIndexRepository;
  sessionManager: Pick<SessionManager, "getSessionId" | "getSessionFile" | "getLeafId" | "getBranch" | "getEntries">;
  projectPath: string;
  projectTrusted: boolean;
  sanitize: (text: string, classification?: PrivacyClassification) => { text?: string; classification: PrivacyClassification; omitted: boolean };
  /** Explicit validated rebase ancestors only; never inferred from arbitrary parentSession paths. */
  lineage?: { sessionId: string; sessionFile: string; allowedEntryIds: ReadonlySet<string> }[];
  excludedSessions?: ReadonlySet<string>;
  lineageWarnings?: string[];
}
interface Reference extends HistorySource {
  issuingSession: string;
  expires: number;
  scope: HistoryScope;
  kind: string;
  role?: string;
  timestamp?: number;
  relation: HistoryHit["relation"];
  classification: PrivacyClassification;
}
interface ScopedSource { sessionId: string; sessionFile: string; ids: ReadonlySet<string>; relation: HistoryHit["relation"] }
export class PiHistoryService {
  private readonly refs = new Map<string, Reference>();
  constructor(private readonly now: () => number = Date.now) {}

  status(access: HistoryAccess): HistoryResult {
    if (!access.config.historyTools.enabled) return historyUnavailable("disabled");
    const sessionFile = access.sessionManager.getSessionFile();
    if (!sessionFile || !existsSync(sessionFile)) return historyUnavailable("ephemeral-session");
    const state = access.repository.getState(access.sessionManager.getSessionId());
    return { schema: HISTORY_RESULT_SCHEMA, quotedData: true, status: state ? "complete" : "partial",
      coverage: state ? "complete" : "unknown", warnings: state ? [] : ["index-not-yet-synchronized"],
      effectiveScope: access.config.historyTools.defaultScope, indexedEntries: state?.indexedEntries ?? 0 };
  }

  recall(access: HistoryAccess, request: HistoryRecallRequest): HistoryResult {
    if (!access.config.historyTools.enabled) return historyUnavailable("disabled");
    try {
      const query = validateHistoryQuery(request, access.config.historyTools);
      const { sources, warnings } = this.sources(access, query.scope);
      const hits: HistoryHit[] = [];
      const activeIds = new Set(access.sessionManager.getBranch().map((entry) => entry.id));
      const engine = new HistoricalRetrievalEngine(access.repository);
      // Explicit history uses existing lexical ranking, but not the automatic retrieval exclusion policy.
      for (const source of sources) {
        const retrieval = engine.retrieve({ sessionId: source.sessionId, activeBranchEntryIds: source.ids,
          activeContextEntryIds: new Set(), requestText: query.query, timestamp: this.now(), includeSummaries: query.includeSummaries,
          ...(query.roles ? { roles: query.roles } : {}), ...(query.before !== undefined ? { before: query.before } : {}),
          ...(query.after !== undefined ? { after: query.after } : {}), semantic: false,
          maxTokens: 100_000, maxResults: 12, exact: access.config.retrieval.exact, fts: access.config.retrieval.fts });
        warnings.push(...retrieval.warnings.map(() => "retrieval-degraded"));
        if (retrieval.status === "disabled") warnings.push("lexical-retrieval-disabled");
        for (const hit of retrieval.selected) {
          const record = access.repository.getEntriesByIds(source.sessionId, [hit.entryId])[0];
          if (!record) { warnings.push("index-source-missing"); continue; }
          const origin: HistorySource = { sessionId: source.sessionId, sessionFile: source.sessionFile,
            projectPath: access.projectPath, entryId: hit.entryId, contentHash: record.contentHash };
          try {
            const canonical = readHistorySource(access.repository, origin);
            // Classify the WHOLE original entry, not merely the excerpt. This prevents hidden-span leaks.
            const sourceFloor = historyPrivacyClassification(JSON.parse(canonical.raw));
            const rawPrivacy = access.sanitize(JSON.stringify(JSON.parse(canonical.raw)), sourceFloor
              ? highestClassification(access.config.privacy.defaultClassification, sourceFloor) : undefined);
            const textPrivacy = access.sanitize(canonical.text, rawPrivacy.classification);
            if (rawPrivacy.omitted || textPrivacy.omitted || textPrivacy.text === undefined) {
              warnings.push("privacy-omitted"); continue;
            }
            const classification = highestClassification(rawPrivacy.classification, textPrivacy.classification);
            const excerpt = excerptAroundTerms(textPrivacy.text, describeTask(query.query).queryTerms, 1_800);
            const relation = source.sessionId === access.sessionManager.getSessionId() && !activeIds.has(hit.entryId)
              ? "other-branch" as const : source.relation;
            const sourceRef = this.reference({ ...origin, issuingSession: access.sessionManager.getSessionId(),
              expires: this.now() + 10 * 60_000, scope: query.scope, kind: canonical.kind,
              ...(canonical.role ? { role: canonical.role } : {}), ...(canonical.timestamp !== undefined ? { timestamp: canonical.timestamp } : {}),
              relation, classification });
            hits.push({ sourceRef, projectId: sha256(historyProjectPath(access.projectPath)).slice(0, 20),
              sessionId: this.publicId(access, source.sessionId), entryId: this.publicId(access, hit.entryId), kind: canonical.kind,
              ...(canonical.role ? { role: canonical.role } : {}), ...(canonical.timestamp !== undefined ? { timestamp: canonical.timestamp } : {}),
              relation, classification, excerpt,
              matchReasons: [hit.reason.startsWith("exact identifier") ? "exact-identifier" : hit.reason.startsWith("exact phrase") ? "exact-phrase" : "lexical-match"],
              score: hit.score, truncated: excerpt !== textPrivacy.text });
          } catch { warnings.push("source-unavailable-or-changed"); }
        }
      }
      hits.sort((a, b) => b.score - a.score || (b.timestamp ?? 0) - (a.timestamp ?? 0) || a.sourceRef.localeCompare(b.sourceRef));
      const result: HistoryResult = { schema: HISTORY_RESULT_SCHEMA, quotedData: true,
        status: warnings.length ? "partial" : "complete", coverage: warnings.length ? "partial" : "complete",
        effectiveScope: query.scope, warnings: [...new Set(warnings)].slice(0, 12), hits: [] };
      const seen = new Set<string>();
      for (const hit of hits) {
        const key = `${hit.sessionId}:${hit.entryId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (result.hits!.length >= query.limit) break;
        result.hits!.push(hit);
        if (this.cost(result) > query.maxOutputTokens) {
          result.hits!.pop(); result.warnings = [...new Set([...result.warnings, "output-budget"])];
          result.status = "partial"; result.coverage = "partial";
        }
      }
      return result;
    } catch (error) { return historyUnavailable(this.safeError(error)); }
  }

  read(access: HistoryAccess, input: { sourceRef: string; startLine?: number; maxLines?: number; maxOutputTokens?: number }): HistoryResult {
    if (!access.config.historyTools.enabled) return historyUnavailable("disabled");
    try {
      if (!input || typeof input.sourceRef !== "string" || !/^hist_[a-f0-9]{32}$/u.test(input.sourceRef)) throw new Error("invalid-reference");
      const ref = this.refs.get(input.sourceRef);
      if (!ref || ref.expires <= this.now() || ref.issuingSession !== access.sessionManager.getSessionId()) {
        this.refs.delete(input.sourceRef); throw new Error("reference-expired");
      }
      const { sources } = this.sources(access, ref.scope);
      if (!sources.some((source) => source.sessionId === ref.sessionId && source.sessionFile === ref.sessionFile && source.ids.has(ref.entryId))) {
        throw new Error("reference-out-of-scope");
      }
      const integer = (value: number, max: number): number => {
        if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error("invalid-range");
        return value;
      };
      if (input.maxOutputTokens !== undefined && input.maxOutputTokens < 256) throw new Error("invalid-range");
      const startLine = integer(input.startLine ?? 1, 1_000_000);
      const maxLines = integer(input.maxLines ?? 120, 200);
      const budget = Math.min(integer(input.maxOutputTokens ?? access.config.historyTools.maxOutputTokens, 6_000), access.config.historyTools.maxOutputTokens);
      const canonical = readHistorySource(access.repository, ref);
      const sourceFloor = historyPrivacyClassification(JSON.parse(canonical.raw));
      const raw = access.sanitize(JSON.stringify(JSON.parse(canonical.raw)), highestClassification(access.config.privacy.defaultClassification,
        sourceFloor ? highestClassification(ref.classification, sourceFloor) : ref.classification));
      const text = access.sanitize(canonical.text, raw.classification);
      if (raw.omitted || text.omitted || text.text === undefined) return historyUnavailable("privacy-omitted");
      ref.classification = highestClassification(ref.classification, text.classification);
      const lines = text.text.split(/\r?\n/u);
      if (startLine > lines.length) throw new Error("range-out-of-bounds");
      const source = { sourceRef: input.sourceRef, projectId: sha256(historyProjectPath(access.projectPath)).slice(0, 20),
        sessionId: this.publicId(access, ref.sessionId), entryId: this.publicId(access, ref.entryId), kind: ref.kind, ...(ref.role ? { role: ref.role } : {}),
        ...(ref.timestamp !== undefined ? { timestamp: ref.timestamp } : {}), relation: ref.relation, classification: ref.classification };
      const result: HistoryResult = { schema: HISTORY_RESULT_SCHEMA, quotedData: true, status: "complete", coverage: "complete", warnings: [],
        source, text: "", startLine, truncated: false };
      const end = Math.min(lines.length, startLine - 1 + maxLines);
      let next = startLine - 1, includedLines = 0;
      for (; next < end; next++) {
        const previous = result.text!;
        result.text += (includedLines > 0 ? "\n" : "") + lines[next]!;
        result.truncated = next + 1 < lines.length;
        result.nextLine = next + 2;
        if (this.cost(result) > budget) { result.text = previous; break; }
        includedLines++;
      }
      if (!includedLines) return historyUnavailable("line-exceeds-output-budget");
      result.truncated = next < lines.length;
      if (result.truncated) { result.nextLine = next + 1; result.status = "partial"; result.warnings = ["more-lines"]; }
      else delete result.nextLine;
      return result;
    } catch (error) { return historyUnavailable(this.safeError(error)); }
  }

  private publicId(access: HistoryAccess, id: string): string {
    const safe = access.sanitize(id, "normal");
    return /^[A-Za-z0-9_.:-]{1,128}$/u.test(id) && !safe.omitted && safe.text === id
      ? id : `opaque_${sha256(id).slice(0, 24)}`;
  }
  private cost(value: HistoryResult): number {
    // Keep room for the tool-result envelope and metadata; budget covers serialized output, not only text.
    return estimateTextTokens(renderHistoryResult(value)) + 96;
  }
  private reference(ref: Reference): string {
    for (const [id, value] of this.refs) if (value.expires <= this.now()) this.refs.delete(id);
    while (this.refs.size >= 512) this.refs.delete(this.refs.keys().next().value!);
    const id = `hist_${randomBytes(16).toString("hex")}`;
    this.refs.set(id, ref); return id;
  }
  private safeError(error: unknown): string {
    const code = error instanceof Error ? error.message : "";
    return /^(invalid-[a-z-]+|source-[a-z-]+|reference-[a-z-]+|range-out-of-bounds|project-scope-disabled|project-untrusted|ephemeral-session)$/u.test(code)
      ? code : "history-unavailable";
  }
  private sources(access: HistoryAccess, scope: HistoryScope): { sources: ScopedSource[]; warnings: string[] } {
    const file = access.sessionManager.getSessionFile();
    if (!file || !existsSync(file)) throw new Error("ephemeral-session");
    const id = access.sessionManager.getSessionId();
    const indexer = new PiSessionIndexer(access.repository);
    const warnings: string[] = [];
    const sync = (sessionId: string, sessionFile: string): void => {
      const header = readSessionHeaderRecord(sessionFile).value;
      if (header.id !== sessionId || typeof header.cwd !== "string"
        || historyProjectPath(header.cwd) !== historyProjectPath(access.projectPath)) throw new Error("source-scope-mismatch");
      indexer.sync({ sessionId, sessionFile, projectPath: access.projectPath, totalEntries: 0, branchEntries: 0 });
      const state = access.repository.getState(sessionId);
      if (!state || state.malformedLines > 0 || state.checkpointOffset < state.fileSize) warnings.push("source-coverage-partial");
    };
    sync(id, file);
    const sources: ScopedSource[] = [{ sessionId: id, sessionFile: file,
      ids: new Set((scope === "current-session" || scope === "project" ? access.sessionManager.getEntries() : access.sessionManager.getBranch()).map((entry) => entry.id)),
      relation: "ancestor" }];
    if (scope === "current-lineage") {
      warnings.push(...access.lineageWarnings ?? []);
      for (const ancestor of access.lineage ?? []) {
        if (access.excludedSessions?.has(ancestor.sessionId)) { warnings.push("lineage-source-excluded"); continue; }
        try { sync(ancestor.sessionId, ancestor.sessionFile); sources.push({ ...ancestor, ids: ancestor.allowedEntryIds, relation: "lineage-ancestor" }); }
        catch { warnings.push("lineage-source-unavailable"); }
      }
    }
    if (scope === "project") {
      if (!access.config.historyTools.allowProjectScope) throw new Error("project-scope-disabled");
      if (!access.projectTrusted) throw new Error("project-untrusted");
      let candidates: string[];
      try { candidates = listPiSessionFiles(dirname(file)).filter((path) => path !== file); }
      catch { return { sources, warnings: ["project-discovery-unavailable"] }; }
      const limit = access.config.historyTools.maxProjectSessions;
      if (candidates.length > limit) warnings.push("project-discovery-limit");
      for (const sessionFile of candidates.slice(0, limit)) {
        try {
          const header = readSessionHeaderRecord(sessionFile).value;
          if (typeof header.id !== "string" || typeof header.cwd !== "string" || header.id === id
            || historyProjectPath(header.cwd) !== historyProjectPath(access.projectPath) || access.excludedSessions?.has(header.id)) continue;
          sync(header.id, sessionFile);
          sources.push({ sessionId: header.id, sessionFile,
            ids: access.repository.allEntryIds(header.id), relation: "other-branch" });
        } catch { warnings.push("project-source-unavailable"); }
      }
    }
    return { sources, warnings };
  }
}
