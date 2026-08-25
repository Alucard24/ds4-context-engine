import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Ds4CompactionMetadata, SummaryRecord } from "ds4-context-core/compaction/compaction-record";
import { ContextDatabase } from "ds4-context-core/persistence/sqlite";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function metadata(): Ds4CompactionMetadata {
  return {
    schemaVersion: 2,
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
    summaryKind: "segment",
    childSummaryIds: [],
    graphLevel: 0,
    segmentSummaryId: "summary-1",
    embeddedNodes: [],
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
    childSummaryIds: [],
    graphLevel: 0,
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

function graphRecord(input: {
  id: string;
  kind: SummaryRecord["kind"];
  level: number;
  children?: string[];
  content?: string;
}): SummaryRecord {
  const childSummaryIds = input.children ?? [];
  const nodeMetadata: Ds4CompactionMetadata = {
    ...metadata(),
    summaryId: input.id,
    sourceHash: `hash-${input.id}`,
    sourceEntryIds: ["entry-1"],
    generatedAt: 123 + input.level,
    summaryKind: input.kind,
    childSummaryIds,
    graphLevel: input.level,
    segmentSummaryId: input.kind === "segment" ? input.id : "segment-2",
  };
  return {
    ...record(),
    id: input.id,
    kind: input.kind,
    content: input.content ?? `content-${input.id}`,
    sourceHash: nodeMetadata.sourceHash,
    childSummaryIds,
    graphLevel: input.level,
    createdAt: nodeMetadata.generatedAt,
    metadata: nodeMetadata,
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

  it("stores ordered graph edges and rejects mutation of immutable nodes", () => {
    const directory = mkdtempSync(join(tmpdir(), "ds4-summary-graph-"));
    temporaryDirectories.push(directory);
    const database = ContextDatabase.open(join(directory, "context.db"));
    seed(database);
    const first = graphRecord({ id: "segment-1", kind: "segment", level: 0 });
    const second = graphRecord({ id: "segment-2", kind: "segment", level: 0 });
    const aggregate = graphRecord({
      id: "aggregate-1",
      kind: "aggregate",
      level: 1,
      children: ["segment-1", "segment-2"],
    });

    database.summaries.saveGraph([first, second, aggregate]);
    expect(database.summaries.getById("aggregate-1")).toMatchObject({
      childSummaryIds: ["segment-1", "segment-2"],
      graphLevel: 1,
    });
    expect(database.summaries.listBySession("session-1")).toHaveLength(3);
    expect(() => database.summaries.save({ ...first, content: "mutated" }))
      .toThrow("immutable");
    expect(database.summaries.getById("segment-1")?.content).toBe("content-segment-1");
    database.close();
  });

  it("rolls back the complete graph batch when a child is unavailable", () => {
    const directory = mkdtempSync(join(tmpdir(), "ds4-summary-graph-rollback-"));
    temporaryDirectories.push(directory);
    const database = ContextDatabase.open(join(directory, "context.db"));
    seed(database);
    const segment = graphRecord({ id: "segment-new", kind: "segment", level: 0 });
    const aggregate = graphRecord({
      id: "aggregate-bad",
      kind: "aggregate",
      level: 1,
      children: ["segment-new", "missing-child"],
    });

    expect(() => database.summaries.saveGraph([segment, aggregate])).toThrow("child is missing");
    expect(database.summaries.getById("segment-new")).toBeUndefined();
    expect(database.summaries.getById("aggregate-bad")).toBeUndefined();
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
