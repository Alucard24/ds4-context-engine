import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EmbeddedSummaryNode } from "ds4-context-core/compaction/compaction-record";
import { createSummaryMetadata } from "ds4-context-core/compaction/summary-graph";
import { computeAggregateSourceHash } from "ds4-context-core/compaction/summary-contract";

function segment(input: {
  id: string;
  content: string;
  sourceHash: string;
  sourceEntryId: string;
  createdAt: number;
}): EmbeddedSummaryNode {
  return {
    id: input.id,
    kind: "segment",
    content: input.content,
    sourceHash: input.sourceHash,
    sourceEntryIds: [input.sourceEntryId],
    childSummaryIds: [],
    graphLevel: 0,
    createdAt: input.createdAt,
    validationStatus: "valid",
    validationIssueCodes: [],
    provider: "test",
    model: "model",
  };
}

describe("hierarchical summary graph golden contract", () => {
  it("keeps ordered children and rebuildable embedded nodes stable", () => {
    const first = segment({
      id: "segment-1",
      content: "first",
      sourceHash: "hash-1",
      sourceEntryId: "entry-1",
      createdAt: 100,
    });
    const second = segment({
      id: "segment-2",
      content: "second",
      sourceHash: "hash-2",
      sourceEntryId: "entry-2",
      createdAt: 200,
    });
    const aggregate: EmbeddedSummaryNode = {
      id: "aggregate-1",
      kind: "aggregate",
      content: "aggregate",
      sourceHash: computeAggregateSourceHash([first, second]),
      sourceEntryIds: ["entry-1", "entry-2"],
      childSummaryIds: ["segment-1", "segment-2"],
      graphLevel: 1,
      createdAt: 300,
      validationStatus: "valid",
      validationIssueCodes: [],
      provider: "test",
      model: "model",
    };
    const metadata = createSummaryMetadata({
      node: aggregate,
      boundary: {
        firstKeptEntryId: "entry-3",
        tokensBefore: 30_000,
        reason: "manual",
        isSplitTurn: false,
        messageCount: 2,
        provider: "test",
        model: "model",
      },
      segmentSummaryId: "segment-2",
      embeddedNodes: [second],
    });
    const golden = JSON.parse(readFileSync(
      join(import.meta.dirname, "hierarchical-summary-graph.json"),
      "utf8",
    )) as unknown;

    expect(metadata).toEqual(golden);
  });
});
