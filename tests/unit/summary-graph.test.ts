import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  parseDs4CompactionDetails,
  type Ds4CompactionDetails,
  type EmbeddedSummaryNode,
} from "../../src/compaction/compaction-record.ts";
import {
  createSummaryMetadata,
  recordsFromCompactionEntry,
  type SummaryBoundary,
} from "../../src/compaction/summary-graph.ts";

const boundary: SummaryBoundary = {
  firstKeptEntryId: "entry-kept",
  tokensBefore: 20_000,
  reason: "manual",
  isSplitTurn: false,
  messageCount: 1,
  provider: "test",
  model: "model",
};

function node(id: string, kind: EmbeddedSummaryNode["kind"], level: number): EmbeddedSummaryNode {
  return {
    id,
    kind,
    content: `content-${id}`,
    sourceHash: `hash-${id}`,
    sourceEntryIds: ["entry-source"],
    childSummaryIds: [],
    graphLevel: level,
    createdAt: 100 + level,
    validationStatus: "valid",
    validationIssueCodes: [],
    provider: "test",
    model: "model",
  };
}

describe("hierarchical summary graph metadata", () => {
  it("normalizes M4 schema-v1 details as a segment root", () => {
    const parsed = parseDs4CompactionDetails({
      readFiles: [],
      modifiedFiles: [],
      ds4ContextEngine: {
        schemaVersion: 1,
        contractVersion: 1,
        summaryId: "legacy-summary",
        sourceHash: "legacy-hash",
        sourceEntryIds: ["entry-source"],
        validationStatus: "valid",
        validationIssueCodes: [],
        firstKeptEntryId: "entry-kept",
        tokensBefore: 10,
        reason: "manual",
        isSplitTurn: false,
        messageCount: 1,
        generatedAt: 100,
        provider: "test",
        model: "model",
      },
    });

    expect(parsed?.ds4ContextEngine).toMatchObject({
      schemaVersion: 1,
      summaryKind: "segment",
      childSummaryIds: [],
      graphLevel: 0,
      segmentSummaryId: "legacy-summary",
      embeddedNodes: [],
    });
  });

  it("rebuilds embedded segment and active aggregate records from Pi details", () => {
    const first = node("segment-1", "segment", 0);
    const second = node("segment-2", "segment", 0);
    const aggregate: EmbeddedSummaryNode = {
      ...node("aggregate-1", "aggregate", 1),
      childSummaryIds: ["segment-1", "segment-2"],
    };
    const metadata = createSummaryMetadata({
      node: aggregate,
      boundary,
      segmentSummaryId: "segment-2",
      embeddedNodes: [second],
    });
    const details: Ds4CompactionDetails = {
      readFiles: [],
      modifiedFiles: [],
      ds4ContextEngine: metadata,
    };
    const entry: Extract<SessionEntry, { type: "compaction" }> = {
      type: "compaction",
      id: "compaction-1",
      parentId: "entry-kept",
      timestamp: "2026-08-24T00:00:00.000Z",
      summary: aggregate.content,
      firstKeptEntryId: boundary.firstKeptEntryId,
      tokensBefore: boundary.tokensBefore,
      details,
      fromHook: true,
    };

    const records = recordsFromCompactionEntry({
      sessionId: "session-1",
      entry,
      details,
      lifecycleStatus: "committed",
    });

    expect(records.map((record) => record.id)).toEqual(["segment-2", "aggregate-1"]);
    expect(records[0]).toMatchObject({ lifecycleStatus: "committed" });
    expect(records[0]?.piCompactionEntryId).toBeUndefined();
    expect(records[1]).toMatchObject({
      childSummaryIds: ["segment-1", "segment-2"],
      graphLevel: 1,
      piCompactionEntryId: "compaction-1",
    });
    expect(first.id).toBe("segment-1");
  });

  it("rejects malformed embedded graph nodes", () => {
    const metadata = createSummaryMetadata({
      node: node("segment-1", "segment", 0),
      boundary,
      segmentSummaryId: "segment-1",
    });
    const malformed = {
      readFiles: [],
      modifiedFiles: [],
      ds4ContextEngine: {
        ...metadata,
        embeddedNodes: [{ id: "bad" }],
      },
    };

    expect(parseDs4CompactionDetails(malformed)).toBeUndefined();
  });
});
