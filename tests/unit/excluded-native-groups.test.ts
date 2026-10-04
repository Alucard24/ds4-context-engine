import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "ds4-context-core/config/config";
import { estimateMessagesTokens } from "ds4-context-core/core/token-estimator";
import { planManagedContext } from "ds4-context-core/planner/context-planner";

const user = (content: string) => ({ role: "user", content });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

function plan(messages: unknown[], overrides: { tail?: number; target?: number; hard?: number; rescue?: boolean } = {}) {
  return planManagedContext({
    messages,
    fixedTokens: 13_461,
    budget: {
      contextWindow: 1_050_000, outputReserve: 4_096, safetyMargin: 1_024,
      modelInputHardLimit: overrides.hard ?? 182_266,
      hardInputLimit: overrides.hard ?? 182_266, softInputLimit: overrides.hard ?? 182_266,
      preferredInputTarget: overrides.target ?? 148_437, activeInputBudget: overrides.target ?? 148_437,
    },
    config: {
      ...DEFAULT_CONFIG.context, mode: "managed", recentTailTokens: overrides.tail ?? 49_895,
      rescueImmediatePredecessor: overrides.rescue ?? true,
    },
  });
}

const oldTurn = () => [user(`oversized old turn ${"x".repeat(240_000)}`), assistant("old reply")];

describe("bounded excluded native-group diagnostics", () => {
  it("distinguishes background from a genuinely oversized older turn even below the global target", () => {
    const old = oldTurn();
    const messages = [assistant("unsectioned background"), ...old, user("recent request"), assistant("recent reply"), user("current request")];
    const result = plan(messages);
    expect(result.mode).toBe("managed");
    expect(result.planning.originalMessageTokens).toBeLessThan(result.planning.messageTargetTokens);
    expect(result.planning.oversizedTurnExclusions).toBe(1);
    expect(result.planning.excludedNativeGroups).toMatchObject({ total: 2, messageCount: 3 });
    expect(result.planning.excludedNativeGroups?.groups).toEqual([
      {
        groupId: "group:1-2", kind: "turn", startIndex: 1, endIndex: 2, messageCount: 2,
        tokens: estimateMessagesTokens(old), oversized: true, immediatePredecessor: false,
        reason: "recent-tail-limit", rescue: "not-immediate-predecessor",
      },
      {
        groupId: "group:0-0", kind: "prefix", startIndex: 0, endIndex: 0, messageCount: 1,
        tokens: estimateMessagesTokens([messages[0]]), oversized: false, immediatePredecessor: false,
        reason: "background-without-retrieval",
      },
    ]);
    expect(result.messages).toEqual(messages.slice(3));
    const diagnostics = JSON.stringify(result.planning.excludedNativeGroups);
    expect(diagnostics).not.toContain("oversized old turn");
    expect(diagnostics).not.toContain("unsectioned background");
  });

  it("reports a whole tool exchange's measured group cost without selecting an orphan result", () => {
    const exchange = [
      user("old inspection"),
      { role: "assistant", content: [{ type: "toolCall", id: "call-synthetic", name: "read", arguments: { path: "synthetic.txt" } }] },
      { role: "toolResult", toolCallId: "call-synthetic", toolName: "read", content: [{ type: "text", text: "z".repeat(240_000) }], isError: false },
    ];
    const recent = [user("recent request"), assistant("recent reply"), user("current request")];
    const result = plan([...exchange, ...recent]);
    expect(result.planning.excludedNativeGroups?.groups[0]).toMatchObject({
      groupId: "group:0-2", messageCount: 3, tokens: estimateMessagesTokens(exchange),
      oversized: true, immediatePredecessor: false, reason: "recent-tail-limit",
    });
    expect(result.messages).toEqual(recent);
    expect(JSON.stringify(result.planning.excludedNativeGroups)).not.toContain("synthetic.txt");
    expect(result.messages.some((message) => (message as { role?: string }).role === "toolResult")).toBe(false);
  });

  it("attributes a rejected immediate-predecessor rescue to the input budget", () => {
    const result = plan([...oldTurn(), user("current request")], { tail: 1_000, target: 30_000, hard: 40_000 });
    expect(result.planning.excludedNativeGroups?.groups[0]).toMatchObject({
      immediatePredecessor: true, oversized: true,
      reason: "recent-tail-and-input-budget", rescue: "input-budget",
    });
  });

  it("attributes a disabled rescue without confusing it with input pressure", () => {
    const result = plan([...oldTurn(), user("current request")], { tail: 1_000, rescue: false });
    expect(result.planning.excludedNativeGroups?.groups[0]).toMatchObject({
      immediatePredecessor: true, oversized: true, reason: "recent-tail-limit", rescue: "disabled",
    });
  });

  it("distinguishes a disabled tail from an oversized-turn exclusion", () => {
    const result = plan([...oldTurn(), user("current request")], { tail: 0 });
    expect(result.planning.oversizedTurnExclusions).toBeUndefined();
    expect(result.planning.excludedNativeGroups?.groups[0]).toMatchObject({
      immediatePredecessor: true, oversized: false, reason: "recent-tail-limit", rescue: "tail-disabled",
    });
  });

  it("marks older groups beyond the first gap as recent-tail-closed", () => {
    const messages = [user("ancestor"), assistant("ancestor reply"), ...oldTurn(), user("current request")];
    const result = plan(messages, { tail: 1_000, rescue: false });
    expect(result.planning.excludedNativeGroups?.groups.find((group) => group.startIndex === 0)).toMatchObject({
      oversized: false, reason: "recent-tail-closed", rescue: "not-immediate-predecessor",
    });
  });

  it("bounds details at 32 groups while retaining complete counts and prioritizing oversized groups", () => {
    const messages = [
      ...oldTurn(),
      ...Array.from({ length: 50 }, (_, index) => [user(`older-${index} ${"y".repeat(120)}`), assistant("reply")]).flat(),
      user("current request"),
    ];
    const result = plan(messages, { tail: 100, rescue: false });
    const details = result.planning.excludedNativeGroups;
    expect(details?.total).toBe(result.planning.excludedGroupCount);
    expect(details?.total).toBeGreaterThan(32);
    expect(details?.groups).toHaveLength(32);
    expect(details?.groups[0]).toMatchObject({ groupId: "group:0-1", oversized: true });
    expect(details?.messageCount).toBe(result.excluded.length);
    expect(result.planning.excludedNativeGroups).toEqual(plan(messages, { tail: 100, rescue: false }).planning.excludedNativeGroups);
  });

  it("does not change a successful rescue or the native message selection", () => {
    const messages = [...oldTurn(), user("current request")];
    const result = plan(messages, { tail: 1_000 });
    expect(result.planning.rescuedImmediatePredecessor).toBe(true);
    expect(result.planning.excludedNativeGroups).toEqual({ total: 0, messageCount: 0, groups: [] });
    expect(result.messages).toEqual(messages);
  });
});
