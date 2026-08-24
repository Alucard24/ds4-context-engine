import { appendFileSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextDatabase } from "../../src/persistence/sqlite.ts";
import { PiSessionIndexer } from "../../src/pi-adapter/session-indexer.ts";
import type { PiSessionSnapshot } from "../../src/pi-adapter/session-reader.ts";

const fixture = join(import.meta.dirname, "..", "fixtures", "pi-session-v3.jsonl");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function snapshot(sessionFile: string, sessionId = "session-fixture"): PiSessionSnapshot {
  return {
    sessionId,
    sessionFile,
    projectPath: "/workspace/demo",
    leafId: "0000000a",
    totalEntries: 10,
    branchEntries: 7,
  };
}

describe("PiSessionIndexer", () => {
  it("rebuilds, appends incrementally, indexes both branches, and becomes a no-op", () => {
    const directory = mkdtempSync(join(tmpdir(), "ds4-indexer-"));
    temporaryDirectories.push(directory);
    const sessionFile = join(directory, "session.jsonl");
    const lines = readFileSync(fixture, "utf8").trimEnd().split("\n");
    writeFileSync(sessionFile, `${lines.slice(0, 5).join("\n")}\n`);

    const database = ContextDatabase.open(join(directory, "context.db"));
    let now = 100;
    const indexer = new PiSessionIndexer(database.sessionIndex, {
      now: () => now++,
      monotonicNow: () => 0,
    });

    const initial = indexer.sync(snapshot(sessionFile));
    expect(initial).toMatchObject({ mode: "rebuild", totalEntries: 4, malformedLines: 0 });
    expect(database.sessionIndex.searchExact("session-fixture", "LastExportUtc", 10)).toHaveLength(1);
    expect(database.sessionIndex.searchExact("session-fixture", "Private chain of thought", 10)).toHaveLength(0);

    appendFileSync(sessionFile, `${lines.slice(5).join("\n")}\n`);
    const incremental = indexer.sync(snapshot(sessionFile));
    expect(incremental).toMatchObject({ mode: "incremental", processedEntries: 6, totalEntries: 10 });

    const alternative = database.sessionIndex.searchExact("session-fixture", "Alternative branch", 10);
    expect(alternative[0]).toMatchObject({ entryId: "00000008", parentId: "00000007" });
    expect(database.sessionIndex.searchFts("session-fixture", "OracleProvider", 10).length).toBeGreaterThan(0);
    expect(database.sessionIndex.searchExact("session-fixture", "must-not-be-indexed", 10)).toHaveLength(0);

    const unchanged = indexer.sync(snapshot(sessionFile));
    expect(unchanged).toMatchObject({ mode: "noop", totalEntries: 10 });
    const state = database.sessionIndex.getState("session-fixture");
    expect(state).toMatchObject({ indexedEntries: 10, checkpointOffset: readFileSync(sessionFile).length });

    const forced = indexer.sync(snapshot(sessionFile), true);
    expect(forced).toMatchObject({ mode: "rebuild", reason: "forced by user", totalEntries: 10 });
    database.close();
  });

  it("reconciles in-place edits and removes entries after truncation", () => {
    const directory = mkdtempSync(join(tmpdir(), "ds4-index-reconcile-"));
    temporaryDirectories.push(directory);
    const sessionFile = join(directory, "session.jsonl");
    const source = readFileSync(fixture, "utf8");
    writeFileSync(sessionFile, source);

    const database = ContextDatabase.open(join(directory, "context.db"));
    const indexer = new PiSessionIndexer(database.sessionIndex, { monotonicNow: () => 0 });
    indexer.sync(snapshot(sessionFile));

    writeFileSync(sessionFile, source.replace("MERGE", "PATCH"));
    utimesSync(sessionFile, new Date("2026-08-24T11:00:00.000Z"), new Date("2026-08-24T11:00:00.000Z"));
    const reconciled = indexer.sync(snapshot(sessionFile));
    expect(reconciled).toMatchObject({ mode: "rebuild", reason: "session file changed in place", totalEntries: 10 });
    expect(database.sessionIndex.searchExact("session-fixture", "PATCH", 5)).toHaveLength(1);
    expect(database.sessionIndex.searchExact("session-fixture", "MERGE", 5)).toHaveLength(0);

    const lines = source.trimEnd().split("\n");
    writeFileSync(sessionFile, `${lines.slice(0, 5).join("\n")}\n`);
    const truncated = indexer.sync(snapshot(sessionFile));
    expect(truncated).toMatchObject({ mode: "rebuild", reason: "session file was truncated", totalEntries: 4 });
    expect(database.getSessionStats("session-fixture").entries).toBe(4);
    expect(database.sessionIndex.searchExact("session-fixture", "Alternative branch", 5)).toHaveLength(0);
    database.close();
  });

  it("scopes short Pi entry ids by session", () => {
    const directory = mkdtempSync(join(tmpdir(), "ds4-index-scope-"));
    temporaryDirectories.push(directory);
    const firstFile = join(directory, "first.jsonl");
    const secondFile = join(directory, "second.jsonl");
    const source = readFileSync(fixture, "utf8");
    writeFileSync(firstFile, source);
    writeFileSync(secondFile, source.replace('"id":"session-fixture"', '"id":"session-other"'));

    const database = ContextDatabase.open(join(directory, "context.db"));
    const indexer = new PiSessionIndexer(database.sessionIndex, { monotonicNow: () => 0 });
    indexer.sync(snapshot(firstFile));
    indexer.sync(snapshot(secondFile, "session-other"));

    expect(database.getSessionStats("session-fixture").entries).toBe(10);
    expect(database.getSessionStats("session-other").entries).toBe(10);
    expect(database.sessionIndex.searchExact("session-other", "LastExportUtc", 5)).toHaveLength(1);
    database.close();
  });
});
