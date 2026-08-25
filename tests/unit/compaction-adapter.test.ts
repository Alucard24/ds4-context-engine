import type { SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { Ds4CompactionDetails } from "ds4-context-core/compaction/compaction-record";
import {
  findActiveBranchSummary,
  prepareCompactionSource,
} from "../../src/pi-adapter/compaction-adapter.ts";

function details(): Ds4CompactionDetails {
  return {
    readFiles: ["old-read.ts"],
    modifiedFiles: ["old-write.ts"],
    ds4ContextEngine: {
      schemaVersion: 2,
      contractVersion: 1,
      summaryId: "summary-old",
      sourceHash: "old-hash",
      sourceEntryIds: ["old-entry"],
      validationStatus: "valid",
      validationIssueCodes: [],
      firstKeptEntryId: "entry-1",
      tokensBefore: 1_000,
      reason: "manual",
      isSplitTurn: false,
      messageCount: 1,
      generatedAt: 1,
      provider: "test",
      model: "model",
      summaryKind: "segment",
      childSummaryIds: [],
      graphLevel: 0,
      segmentSummaryId: "summary-old",
      embeddedNodes: [],
    },
  };
}

function event(): SessionBeforeCompactEvent {
  const first = { role: "user" as const, content: "first source", timestamp: 1 };
  const prefix = { role: "user" as const, content: "split prefix", timestamp: 2 };
  const branchEntries: SessionEntry[] = [
    {
      type: "compaction",
      id: "compaction-old",
      parentId: null,
      timestamp: "2026-08-24T00:00:00.000Z",
      summary: "previous summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 1_000,
      details: details(),
      fromHook: true,
    },
    {
      type: "message",
      id: "entry-1",
      parentId: "compaction-old",
      timestamp: "2026-08-24T00:00:01.000Z",
      message: first,
    },
    {
      type: "message",
      id: "entry-2",
      parentId: "entry-1",
      timestamp: "2026-08-24T00:00:02.000Z",
      message: prefix,
    },
  ];
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "entry-3",
      messagesToSummarize: [first],
      turnPrefixMessages: [prefix],
      isSplitTurn: true,
      tokensBefore: 2_000,
      previousSummary: "previous summary",
      fileOps: {
        read: new Set(["new-read.ts"]),
        written: new Set(["new-write.ts"]),
        edited: new Set(["new-edit.ts"]),
      },
      settings: { enabled: true, reserveTokens: 1_024, keepRecentTokens: 100 },
    },
    branchEntries,
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
  };
}

describe("Pi compaction adapter", () => {
  it("maps split-turn sources and carries cumulative file provenance", () => {
    const prepared = prepareCompactionSource(event());

    expect(prepared.sourceEntryIds).toEqual(["entry-1", "entry-2"]);
    expect(prepared.messages).toHaveLength(2);
    expect(prepared.previousSummary).toBe("previous summary");
    expect(prepared.previousNode).toMatchObject({ id: "summary-old", graphLevel: 0 });
    expect(prepared.segmentReadFiles).toEqual(["new-read.ts"]);
    expect(prepared.segmentModifiedFiles).toEqual(["new-edit.ts", "new-write.ts"]);
    expect(prepared.readFiles).toEqual(["new-read.ts", "old-read.ts"]);
    expect(prepared.modifiedFiles).toEqual(["new-edit.ts", "new-write.ts", "old-write.ts"]);
    expect(prepared.conversationText).toContain("first source");
    expect(prepared.conversationText).toContain("split prefix");
    expect(prepared.sourceHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("resolves the exact active branch summary instead of the newest sibling", () => {
    const input = event();
    const siblingDetails = details();
    siblingDetails.ds4ContextEngine.summaryId = "summary-sibling";
    const sibling: SessionEntry = {
      type: "compaction",
      id: "compaction-sibling",
      parentId: null,
      timestamp: "2026-08-24T00:00:09.000Z",
      summary: "sibling summary",
      firstKeptEntryId: "entry-x",
      tokensBefore: 1_000,
      details: siblingDetails,
      fromHook: true,
    };

    expect(findActiveBranchSummary([...input.branchEntries, sibling], "previous summary"))
      .toMatchObject({ id: "summary-old", content: "previous summary" });
    expect(findActiveBranchSummary([...input.branchEntries, sibling], "missing summary")).toBeUndefined();
  });

  it("fails closed to Pi default when exact source provenance is unavailable", () => {
    const input = event();
    input.preparation.messagesToSummarize = [{ role: "user", content: "not canonical", timestamp: 9 }];

    expect(() => prepareCompactionSource(input)).toThrow("no exact canonical Pi session entry");
  });
});
