import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Ds4CompactionMetadata, SummaryRecord } from "../../src/compaction/compaction-record.ts";
import { ContextDatabase } from "../../src/persistence/sqlite.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function metadata(): Ds4CompactionMetadata {
  return {
    schemaVersion: 1,
    contractVersion: 1,
    summaryId: "summary-1",
    sourceHash: "source-hash",
    sourceEntryIds: ["entry-1"],
    validationStatus: "valid",
    validationIssueCodes: [],
    firstKeptEntryId: "entry-2",
    tokensBefore: 10_000,
    reason: "manual",
    isSplitTurn: false,
    messageCount: 1,
    generatedAt: 123,
    provider: "test",
    model: "model",
  };
}

function record(): SummaryRecord {
  return {
    id: "summary-1",
    sessionId: "session-1",
    kind: "segment",
    content: "structured summary",
    sourceHash: "source-hash",
    sourceEntryIds: ["entry-1"],
    createdAt: 123,
    validationStatus: "valid",
    provider: "test",
    model: "model",
    firstKeptEntryId: "entry-2",
    tokensBefore: 10_000,
    reason: "manual",
    lifecycleStatus: "prepared",
    metadata: metadata(),
  };
}

function seed(database: ContextDatabase): void {
  const identity = { sessionId: "session-1", sessionFile: "/tmp/session.jsonl", indexedAt: 1 };
  database.sessionIndex.append(
    identity,
    [{
      entryKey: "session-1:entry-1",
      entryId: "entry-1",
      sessionId: "session-1",
      parentId: null,
      entryType: "message",
      role: "user",
      createdAt: 1,
      contentHash: "hash",
      searchableText: "source",
      tokenEstimate: 1,
      indexedAt: 1,
    }],
    {
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      headerHash: "header",
      fileSize: 1,
      fileMtimeMs: 1,
      checkpointOffset: 1,
      checkpointHashStart: 0,
      checkpointHash: "checkpoint",
      malformedLines: 0,
      indexedAt: 1,
    },
  );
}

describe("SummaryRepository", () => {
  it("persists prepared provenance and commits it to a Pi compaction entry", () => {
    const directory = mkdtempSync(join(tmpdir(), "ds4-summary-"));
    temporaryDirectories.push(directory);
    const database = ContextDatabase.open(join(directory, "context.db"));
    seed(database);

    database.summaries.save(record());
    expect(database.summaries.getLatest("session-1")).toMatchObject({
      id: "summary-1",
      lifecycleStatus: "prepared",
      sourceEntryIds: ["entry-1"],
    });
    expect(database.summaries.markCommitted("summary-1", "compaction-1")).toBe(true);
    expect(database.summaries.getById("summary-1")).toMatchObject({
      lifecycleStatus: "committed",
      piCompactionEntryId: "compaction-1",
    });
    database.close();
  });

  it("rolls back when a source entry is not indexed", () => {
    const directory = mkdtempSync(join(tmpdir(), "ds4-summary-missing-"));
    temporaryDirectories.push(directory);
    const database = ContextDatabase.open(join(directory, "context.db"));
    database.upsertSession({ sessionId: "session-1", sessionFile: "/tmp/session.jsonl", indexedAt: 1 });

    expect(() => database.summaries.save(record())).toThrow("Summary source entry is not indexed");
    expect(database.summaries.getLatest("session-1")).toBeUndefined();
    database.close();
  });
});
