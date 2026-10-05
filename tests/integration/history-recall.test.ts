import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { ContextDatabase } from "ds4-context-core/persistence/sqlite";
import { DEFAULT_CONFIG } from "ds4-context-core/config/config";
import { classifyMarkedContent, highestClassification, providerPrivacyPolicy, sanitizeClassifiedText } from "ds4-context-core/privacy/privacy-policy";
import { estimateTextTokens } from "ds4-context-core/core/token-estimator";
import { PiHistoryService, type HistoryAccess } from "../../src/pi-adapter/history-service.ts";
import { renderHistoryResult } from "../../src/extension/context-history-contract.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const clean of cleanup.splice(0).reverse()) clean(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ds4-recall-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = ContextDatabase.open(join(dir, "index.db")); cleanup.push(() => db.close());
  const sql = new DatabaseSync(db.path); sql.exec("PRAGMA foreign_keys = ON"); cleanup.push(() => sql.close());
  const file = join(dir, "current.jsonl");
  const records = [
    { type: "session", version: 3, id: "source", timestamp: "2026-01-01T00:00:00Z", cwd: dir },
    { type: "message", id: "old", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "Keep `LastExportUtc` nullable. Original constraint, not a summary.", timestamp: 1 } },
    { type: "compaction", id: "compact", parentId: "old", timestamp: "2026-01-01T00:00:02Z", summary: "Discussion compacted; historical constraint omitted.", firstKeptEntryId: "old", tokensBefore: 42 },
    ...Array.from({ length: 150 }, (_, i) => ({ type: "message", id: `sibling-${i}`, parentId: "old", timestamp: "2026-01-01T00:00:03Z", message: { role: "user", content: "LastExportUtc sibling branch wrong contract", timestamp: 3 } })),
    { type: "message", id: "recent", parentId: "compact", timestamp: "2026-01-01T00:00:04Z", message: { role: "user", content: "Continue on current branch", timestamp: 4 } },
  ];
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const manager = SessionManager.open(file);
  let provider = "openai", clock = 1;
  const config = structuredClone(DEFAULT_CONFIG); config.historyTools.enabled = true;
  config.privacy.defaultClassification = "normal";
  const access: HistoryAccess = { config, repository: db.sessionIndex, sessionManager: manager,
    projectPath: dir, projectTrusted: true, sanitize: (text, stored) => {
      const marked = classifyMarkedContent(text);
      const floor = stored && marked ? highestClassification(stored, marked) : stored ?? marked ?? "normal";
      const result = sanitizeClassifiedText(text, providerPrivacyPolicy(config.privacy, provider), floor, true);
      return { text: result.value, classification: result.classification, omitted: result.blockedBlocks > 0 };
    } };
  const service = new PiHistoryService(() => clock);
  return { access, service, db, sql, file, dir, records, manager, provider: (value: string) => { provider = value; }, clock: (value: number) => { clock = value; } };
}

describe("explicit canonical history recall (real Pi SessionManager, offline)", () => {
  it("recovers pre-compaction originals despite 150 higher-ranking sibling rows, and reads only opaque refs", () => {
    const f = fixture(), bytes = readFileSync(f.file);
    const recall = f.service.recall(f.access, { query: "`LastExportUtc`" });
    expect(recall.status).toBe("complete");
    expect(recall.hits?.map((hit) => hit.entryId)).toEqual(["old"]);
    const sourceRef = recall.hits![0]!.sourceRef;
    const read = f.service.read(f.access, { sourceRef });
    expect(read.text).toContain("Original constraint");
    expect(read.source?.entryId).toBe("old");
    expect(JSON.stringify(read)).not.toContain(f.file);
    expect(readFileSync(f.file)).toEqual(bytes);
    expect(f.service.read(f.access, { sourceRef: f.file }).status).toBe("unavailable");
    expect(f.service.recall(f.access, { query: "`LastExportUtc`", scope: "current-session" }).hits?.some((hit) => hit.relation === "other-branch")).toBe(true);
  });
  it("rebuilds locators/index from JSONL, imports idempotently, and expires references at restart", () => {
    const f = fixture();
    const first = f.service.recall(f.access, { query: "LastExportUtc" });
    const count = f.db.sessionIndex.getState("source")?.indexedEntries;
    expect(f.service.recall(f.access, { query: "LastExportUtc" }).hits?.map((h) => h.entryId)).toEqual(first.hits?.map((h) => h.entryId));
    expect(f.db.sessionIndex.getState("source")?.indexedEntries).toBe(count);
    f.sql.exec("DELETE FROM sessions");
    const restarted = new PiHistoryService();
    const restored = restarted.recall(f.access, { query: "LastExportUtc" });
    expect(restored.hits?.map((h) => h.entryId)).toEqual(["old"]);
    expect(restarted.read(f.access, { sourceRef: first.hits![0]!.sourceRef }).warnings).toContain("reference-expired");
    // DBs upgraded from v16 also force source-locator reconstruction without rewriting JSONL.
    f.sql.exec("DELETE FROM entry_source_locations");
    expect(f.service.recall(f.access, { query: "LastExportUtc" }).hits).toHaveLength(1);
  });
  it("enforces same-project trusted opt-in scope without fallback and marks summaries as derived", () => {
    const f = fixture();
    const sibling = (name: string, cwd: string, text: string) => writeFileSync(join(f.dir, name + ".jsonl"), [
      { type: "session", version: 3, id: name, cwd, timestamp: "2026-01-01T00:00:00Z" },
      { type: "message", id: name + "-entry", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: text, timestamp: 1 } },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    sibling("same", f.dir, "LastExportUtc accepted same project");
    sibling("cross", join(f.dir, "different"), "LastExportUtc forbidden cross project");
    expect(f.service.recall(f.access, { query: "LastExportUtc", scope: "project" }).warnings).toContain("project-scope-disabled");
    f.access.config.historyTools.allowProjectScope = true;
    f.access.projectTrusted = false;
    expect(f.service.recall(f.access, { query: "LastExportUtc", scope: "project" }).warnings).toContain("project-untrusted");
    f.access.projectTrusted = true;
    const result = f.service.recall(f.access, { query: "LastExportUtc", scope: "project" });
    expect(result.hits?.some((hit) => hit.sessionId === "same")).toBe(true);
    expect(result.hits?.some((hit) => hit.sessionId === "cross")).toBe(false);
    expect(f.service.recall(f.access, { query: "omitted" }).hits).toEqual([]);
    expect(f.service.recall(f.access, { query: "omitted", includeSummaries: true }).hits?.[0]?.kind).toBe("compaction");
    f.access.excludedSessions = new Set(["same"]);
    expect(f.service.recall(f.access, { query: "LastExportUtc", scope: "project" }).hits?.some((h) => h.sessionId === "same")).toBe(false);
  });
  it("revalidates refs after fork, provider switch, source edit, expiry and source deletion", () => {
    const f = fixture();
    const ref = f.service.recall(f.access, { query: "LastExportUtc" }).hits![0]!.sourceRef;
    // Reusing the same process in a different branch cannot authorize an old reference.
    f.manager.branch("sibling-1");
    expect(f.service.read(f.access, { sourceRef: ref }).status).toBe("complete"); // common ancestor still authorized
    f.manager.resetLeaf();
    expect(f.service.read(f.access, { sourceRef: ref }).warnings).toContain("reference-out-of-scope");
    f.manager.branch("recent");
    f.clock(601_000);
    expect(f.service.read(f.access, { sourceRef: ref }).warnings).toContain("reference-expired");
    f.clock(1);
    const current = f.service.recall(f.access, { query: "LastExportUtc" }).hits![0]!.sourceRef;
    writeFileSync(f.file, readFileSync(f.file, "utf8").replace("Original constraint", "Modified constraint"));
    expect(f.service.read(f.access, { sourceRef: current }).status).toBe("unavailable");
    rmSync(f.file);
    expect(f.service.read(f.access, { sourceRef: current }).status).toBe("unavailable");
  });
  it("classifies the whole source, redacts secrets, and caps serialized output/read range", () => {
    const f = fixture();
    f.records[1]!.message!.content = "LastExportUtc public beginning " + "x".repeat(2000) + "[ds4:local-only]private[/ds4:local-only]";
    writeFileSync(f.file, f.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    expect(f.service.recall(f.access, { query: "LastExportUtc" }).hits).toEqual([]);
    f.provider("local");
    f.access.config.privacy.localProviders.push("local");
    const local = f.service.recall(f.access, { query: "LastExportUtc" });
    expect(local.hits?.[0]?.classification).toBe("local-only");
    f.provider("openai");
    expect(f.service.read(f.access, { sourceRef: local.hits![0]!.sourceRef }).warnings).toContain("privacy-omitted");
    f.records[1]!.message!.content = "LastExportUtc\n" + Array.from({ length: 200 }, (_, i) => "line " + i).join("\n");
    writeFileSync(f.file, f.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const small = f.service.recall(f.access, { query: "LastExportUtc", maxOutputTokens: 256 });
    expect(estimateTextTokens(renderHistoryResult(small)) + 64).toBeLessThanOrEqual(256);
    const next = f.service.recall(f.access, { query: "LastExportUtc" });
    const read = f.service.read(f.access, { sourceRef: next.hits![0]!.sourceRef, maxLines: 5, maxOutputTokens: 256 });
    expect(estimateTextTokens(renderHistoryResult(read)) + 64).toBeLessThanOrEqual(256);
    expect(read.truncated).toBe(true); expect(read.nextLine).toBe(6);
    expect(f.service.read(f.access, { sourceRef: next.hits![0]!.sourceRef, startLine: -1 }).status).toBe("unavailable");
  });
  it("preserves blank logical lines during original-source pagination", () => {
    const f = fixture(); f.records[1]!.message!.content = "\nLastExportUtc\n";
    writeFileSync(f.file, f.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const ref = f.service.recall(f.access, { query: "LastExportUtc" }).hits![0]!.sourceRef;
    const first = f.service.read(f.access, { sourceRef: ref, maxLines: 1 });
    expect(first.text).toBe(""); expect(first.nextLine).toBe(2); expect(first.status).toBe("partial");
    expect(f.service.read(f.access, { sourceRef: ref, startLine: 2 }).text).toBe("LastExportUtc\n");
  });

  it("fails open on disabled/ephemeral/malformed/unavailable sources without creating new memory or pins", () => {
    const f = fixture();
    f.access.config.historyTools.enabled = false;
    expect(f.service.recall(f.access, { query: "anything" }).warnings).toEqual(["disabled"]);
    f.access.config.historyTools.enabled = true;
    expect(f.service.recall(f.access, { query: "" }).warnings).toEqual(["invalid-query"]);
    f.access.sessionManager = { ...f.access.sessionManager, getSessionFile: () => undefined };
    expect(f.service.recall(f.access, { query: "LastExportUtc" }).warnings).toContain("ephemeral-session");
    f.access.sessionManager = f.manager;
    appendFileSync(f.file, '{"incomplete":');
    const result = f.service.recall(f.access, { query: "LastExportUtc" });
    expect(result.hits).toHaveLength(1);
    expect(f.sql.prepare("SELECT COUNT(*) AS n FROM memory_items").get()).toMatchObject({ n: 0 });
    expect(f.sql.prepare("SELECT COUNT(*) AS n FROM pins").get()).toMatchObject({ n: 0 });
  });
});
