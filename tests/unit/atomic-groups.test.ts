import { describe, expect, it } from "vitest";
import { buildAtomicGroups, validateAtomicSelection } from "ds4-context-core/planner/atomic-groups";

function request(content: string) { return { role: "user", content }; }
function call(id: string) {
  return { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: {} }] };
}
function result(id: string) {
  return { role: "toolResult", toolCallId: id, content: [{ type: "text", text: "synthetic result" }] };
}

describe("tool-call occurrence atomicity", () => {
  it("does not merge independent turns when a tool-call ID is reused", () => {
    const messages = [request("first"), call("reused"), result("reused"), request("second"), call("reused"), result("reused")];
    const groups = buildAtomicGroups(messages);
    expect(groups.map((group) => group.messageIndices)).toEqual([[0, 1, 2], [3, 4, 5]]);
    expect(groups.every((group) => group.containsToolExchange)).toBe(true);
    expect(validateAtomicSelection(messages, new Set([0, 1, 2]))).toEqual([]);
    expect(validateAtomicSelection(messages, new Set([3, 4, 5]))).toEqual([]);
  });

  it("does not borrow the later result to validate an earlier incomplete call with the same ID", () => {
    const messages = [request("first"), call("reused"), request("second"), call("reused"), result("reused")];
    expect(buildAtomicGroups(messages).map((group) => group.messageIndices)).toEqual([[0, 1], [2, 3, 4]]);
    expect(validateAtomicSelection(messages, new Set([0, 1]))).toEqual(["selected tool call reused has no result"]);
    expect(validateAtomicSelection(messages, new Set([2, 3, 4]))).toEqual([]);
  });

  it("does not attach an orphan result to a future call with the same ID", () => {
    const messages = [request("orphan"), result("reused"), request("valid"), call("reused"), result("reused")];
    expect(buildAtomicGroups(messages).map((group) => group.messageIndices)).toEqual([[0, 1], [2, 3, 4]]);
    expect(validateAtomicSelection(messages, new Set([0, 1]))).toEqual(["selected tool result reused has no selected call"]);
    expect(validateAtomicSelection(messages, new Set([2, 3, 4]))).toEqual([]);
  });

  it("still joins a real exchange across a user boundary when no ID is reused", () => {
    const messages = [request("first"), call("pending"), request("intervening"), result("pending")];
    expect(buildAtomicGroups(messages).map((group) => group.messageIndices)).toEqual([[0, 1, 2, 3]]);
    expect(validateAtomicSelection(messages, new Set([0, 1, 2, 3]))).toEqual([]);
    expect(validateAtomicSelection(messages, new Set([0, 1]))).toEqual(["selected tool call pending is missing one or more results"]);
    expect(validateAtomicSelection(messages, new Set([2, 3]))).toEqual(["selected tool result pending has no selected call"]);
  });

  it("does not inflate a long sequence of distinct exchanges sharing an ID into one oversized group", () => {
    const messages = Array.from({ length: 200 }, (_, index) => [request(`request ${index}`), call("local-id"), result("local-id")]).flat();
    const groups = buildAtomicGroups(messages);
    expect(groups).toHaveLength(200);
    expect(groups.every((group) => group.messageIndices.length === 3)).toBe(true);
    expect(validateAtomicSelection(messages, new Set(groups.at(-1)?.messageIndices))).toEqual([]);
  });
});
