import type { SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { Ds4CompactionDetails } from "ds4-context-core/compaction/compaction-record";
import { stableStringify } from "ds4-context-core/shared/stable-json";
import {
  findActiveBranchSummary,
  prepareCompactionSource,
  sliceCompactionSource,
} from "../../src/pi-adapter/compaction-adapter.ts";

vi.mock("ds4-context-core/shared/stable-json", async (importOriginal) => {
  const original = await importOriginal<typeof import("ds4-context-core/shared/stable-json")>();
  return { ...original, stableStringify: vi.fn(original.stableStringify) };
});

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

  it("slices contiguous source ranges with exact provenance and split-turn state", () => {
    const prepared = prepareCompactionSource(event());

    expect(sliceCompactionSource(prepared, [0])).toMatchObject({
      sourceEntryIds: ["entry-1"],
      isSplitTurn: false,
    });
    expect(sliceCompactionSource(prepared, [1])).toMatchObject({
      sourceEntryIds: ["entry-2"],
      isSplitTurn: true,
    });
    expect(() => sliceCompactionSource(prepared, [0, 2])).toThrow("unavailable source message");
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

  it("fingerprints each candidate and source once rather than once per comparison", () => {
    const input = event();
    const messages = Array.from({ length: 128 }, (_, index) => ({
      role: "user" as const,
      content: `Synthetic source ${index}: ${"x".repeat(512)}`,
      timestamp: index,
    }));
    input.branchEntries = messages.map((message, index) => ({
      type: "message" as const,
      id: `entry-${index}`,
      parentId: index === 0 ? null : `entry-${index - 1}`,
      timestamp: "2026-08-24T00:00:00.000Z",
      message,
    }));
    // Detached objects: identity matching must not replace canonical equality.
    input.preparation.messagesToSummarize = messages.slice(-8).map((message) => ({ ...message }));
    input.preparation.turnPrefixMessages = [];
    vi.mocked(stableStringify).mockClear();

    const prepared = prepareCompactionSource(input);
    const fingerprintSerializations = vi.mocked(stableStringify).mock.calls
      .filter(([value]) => value !== null && typeof value === "object" && "role" in value);

    expect(prepared.messageEntryIds).toEqual(Array.from({ length: 8 }, (_, index) => `entry-${120 + index}`));
    expect(fingerprintSerializations).toHaveLength(messages.length + 8);
  });

  it("consumes duplicate fingerprints in canonical entry order without reusing an occurrence", () => {
    const input = event();
    const duplicate = { role: "user" as const, content: "same source", timestamp: 1 };
    const other = { role: "user" as const, content: "other source", timestamp: 2 };
    // Same value with a different key insertion order must retain the same fingerprint.
    const reorderedDuplicate = { timestamp: 1, content: "same source", role: "user" as const };
    input.branchEntries = [duplicate, other, reorderedDuplicate].map((message, index) => ({
      type: "message" as const,
      id: `entry-${index}`,
      parentId: index === 0 ? null : `entry-${index - 1}`,
      timestamp: "2026-08-24T00:00:00.000Z",
      message,
    }));
    input.preparation.messagesToSummarize = [{ ...duplicate }, { ...other }];
    input.preparation.turnPrefixMessages = [{ ...duplicate }];

    expect(prepareCompactionSource(input).messageEntryIds).toEqual(["entry-0", "entry-1", "entry-2"]);

    input.preparation.turnPrefixMessages.push({ ...duplicate });
    expect(() => prepareCompactionSource(input)).toThrow("no exact canonical Pi session entry");
  });

  it("fails closed to Pi default when exact source provenance is unavailable", () => {
    const input = event();
    input.preparation.messagesToSummarize = [{ role: "user", content: "not canonical", timestamp: 9 }];

    expect(() => prepareCompactionSource(input)).toThrow("no exact canonical Pi session entry");
  });
});
