import { describe, expect, it } from "vitest";
import { buildCompactionAtomicGroups } from "ds4-context-core/compaction/segmentation";

describe("compaction atomic segmentation", () => {
  it("keeps each tool-call batch with all matching results", () => {
    const messages = [
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.ts" } },
          { type: "toolCall", id: "call-b", name: "read", arguments: { path: "b.ts" } },
        ],
      },
      { role: "toolResult", toolCallId: "call-a", content: [{ type: "text", text: "a" }] },
      { role: "toolResult", toolCallId: "call-b", content: [{ type: "text", text: "b" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];

    expect(buildCompactionAtomicGroups(messages)).toEqual([
      { messageIndices: [0], startIndex: 0, endIndex: 0, containsToolExchange: false },
      { messageIndices: [1, 2, 3], startIndex: 1, endIndex: 3, containsToolExchange: true },
      { messageIndices: [4], startIndex: 4, endIndex: 4, containsToolExchange: false },
    ]);
  });

  it("merges overlapping tool ranges and leaves unmatched messages indivisible", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "outer", name: "read", arguments: { path: "a.ts" } }],
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "inner", name: "read", arguments: { path: "b.ts" } }],
      },
      { role: "toolResult", toolCallId: "inner", content: [] },
      { role: "toolResult", toolCallId: "outer", content: [] },
      { role: "toolResult", toolCallId: "outside-source", content: [] },
    ];

    expect(buildCompactionAtomicGroups(messages)).toEqual([
      { messageIndices: [0, 1, 2, 3], startIndex: 0, endIndex: 3, containsToolExchange: true },
      { messageIndices: [4], startIndex: 4, endIndex: 4, containsToolExchange: false },
    ]);
  });
});
