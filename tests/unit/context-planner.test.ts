import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type ContextConfig } from "../../src/config/config.ts";
import { calculateContextBudget, type ContextBudget } from "../../src/core/budget-manager.ts";
import { createModelProfile } from "../../src/core/model-profile.ts";
import { estimateMessagesTokens } from "../../src/core/token-estimator.ts";
import {
  adaptiveRecentTailLimit,
  planManagedContext,
} from "../../src/planner/context-planner.ts";

function config(overrides: Partial<ContextConfig> = {}): ContextConfig {
  return { ...DEFAULT_CONFIG.context, ...overrides, mode: "managed" };
}

function budget(activeInputBudget: number, hardInputLimit: number, contextWindow = 128_000): ContextBudget {
  return {
    contextWindow,
    outputReserve: 4_096,
    safetyMargin: 1_024,
    modelInputHardLimit: hardInputLimit,
    hardInputLimit,
    softInputLimit: hardInputLimit,
    preferredInputTarget: activeInputBudget,
    activeInputBudget,
  };
}

function user(content: string) {
  return { role: "user", content };
}

function assistantText(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantTools(ids: string[]) {
  return {
    role: "assistant",
    content: ids.map((id) => ({ type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` } })),
  };
}

function toolResult(id: string, text: string) {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
  };
}

describe("managed context planner", () => {
  it("keeps a contiguous recent tail and the current request", () => {
    const messages = [
      user(`old ${"x".repeat(4_000)}`),
      assistantText("old response"),
      user("recent request"),
      assistantText("recent response"),
      user("current request"),
    ];

    const plan = planManagedContext({
      messages,
      fixedTokens: 100,
      budget: budget(500, 2_000),
      config: config({ recentTailTokens: 1_500 }),
    });

    expect(plan.mode).toBe("managed");
    expect(plan.selected.map((item) => item.originalIndex)).toEqual([2, 3, 4]);
    expect(plan.excluded.map((item) => item.originalIndex)).toEqual([0, 1]);
    expect(plan.selected.find((item) => item.originalIndex === 4)?.kind).toBe("current");
    expect(plan.messages).toEqual(messages.slice(2));
  });

  it("includes or excludes a multi-tool turn atomically", () => {
    const messages = [
      user("inspect files"),
      assistantTools(["call-a", "call-b"]),
      toolResult("call-a", "a".repeat(800)),
      toolResult("call-b", "b".repeat(800)),
      user("current request"),
    ];

    const constrained = planManagedContext({
      messages,
      fixedTokens: 100,
      budget: budget(300, 1_500),
      config: config({ recentTailTokens: 2_000 }),
    });
    expect(constrained.mode).toBe("managed");
    expect(constrained.selected.map((item) => item.originalIndex)).toEqual([4]);
    expect(constrained.excluded.map((item) => item.originalIndex)).toEqual([0, 1, 2, 3]);
    expect(new Set(constrained.excluded.map((item) => item.groupId)).size).toBe(1);

    const roomy = planManagedContext({
      messages,
      fixedTokens: 100,
      budget: budget(2_000, 2_500),
      config: config({ recentTailTokens: 2_000 }),
    });
    expect(roomy.mode).toBe("managed");
    expect(roomy.messages).toEqual(messages);
    expect(roomy.excluded).toEqual([]);
  });

  it("treats explicit pins as mandatory atomic groups", () => {
    const messages = [
      user(`pinned constraint ${"x".repeat(1_000)}`),
      assistantText("acknowledged"),
      user("current request"),
    ];

    const plan = planManagedContext({
      messages,
      fixedTokens: 100,
      budget: budget(200, 2_000),
      config: config({ recentTailTokens: 100 }),
      pinnedMessageIndices: [0],
    });

    expect(plan.mode).toBe("managed");
    expect(plan.messages).toEqual(messages);
    expect(plan.selected.filter((item) => item.kind === "pin").map((item) => item.originalIndex)).toEqual([0, 1]);
    expect(plan.selected.find((item) => item.originalIndex === 2)?.kind).toBe("current");
  });

  it("fails open when mandatory content exceeds the hard limit", () => {
    const messages = [user(`current ${"x".repeat(4_000)}`)];
    const plan = planManagedContext({
      messages,
      fixedTokens: 100,
      budget: budget(300, 500),
      config: config(),
    });

    expect(plan.mode).toBe("fallback");
    expect(plan.messages).toEqual(messages);
    expect(plan.planning.fallbackReason).toContain("mandatory current");
  });

  it("fails open for an incomplete selected tool exchange", () => {
    const messages = [user("run tool"), assistantTools(["missing-result"])];
    const plan = planManagedContext({
      messages,
      fixedTokens: 10,
      budget: budget(1_000, 1_500),
      config: config(),
    });

    expect(plan.mode).toBe("fallback");
    expect(plan.planning.fallbackReason).toContain("has no result");
  });

  it("adapts the recent tail ceiling to model size", () => {
    expect(adaptiveRecentTailLimit(32_000, 50_000)).toBe(12_000);
    expect(adaptiveRecentTailLimit(128_000, 50_000)).toBe(24_000);
    expect(adaptiveRecentTailLimit(200_000, 50_000)).toBe(32_000);
    expect(adaptiveRecentTailLimit(1_000_000, 100_000)).toBe(64_000);
    expect(adaptiveRecentTailLimit(200_000, 20_000)).toBe(20_000);
  });

  it("refits the same session when switching between 32k and 200k models", () => {
    const messages = Array.from({ length: 80 }, (_, index) => [
      user(`request ${index} ${"x".repeat(1_000)}`),
      assistantText(`response ${index} ${"y".repeat(1_000)}`),
    ]).flat();
    messages.push(user("current"));
    const fixedTokens = 4_000;
    const smallProfile = createModelProfile({
      provider: "test",
      id: "small",
      contextWindow: 32_000,
      maxTokens: 4_096,
    });
    const largeProfile = createModelProfile({
      provider: "test",
      id: "large",
      contextWindow: 200_000,
      maxTokens: 32_000,
    });
    const plannerConfig = config({ recentTailTokens: 50_000 });
    const smallBudget = calculateContextBudget(smallProfile, plannerConfig);
    const largeBudget = calculateContextBudget(largeProfile, plannerConfig);

    const small = planManagedContext({
      messages,
      fixedTokens,
      budget: smallBudget,
      config: plannerConfig,
    });
    const large = planManagedContext({
      messages,
      fixedTokens,
      budget: largeBudget,
      config: plannerConfig,
    });

    expect(small.mode).toBe("managed");
    expect(large.mode).toBe("managed");
    expect(small.planning.recentTailTokenLimit).toBe(12_000);
    expect(large.planning.recentTailTokenLimit).toBe(32_000);
    expect(large.messages.length).toBeGreaterThan(small.messages.length);
    expect(fixedTokens + estimateMessagesTokens(small.messages)).toBeLessThanOrEqual(smallBudget.hardInputLimit);
    expect(fixedTokens + estimateMessagesTokens(large.messages)).toBeLessThanOrEqual(largeBudget.hardInputLimit);
    expect(small.messages.at(-1)).toEqual(user("current"));
    expect(large.messages.at(-1)).toEqual(user("current"));
  });

  it("is deterministic for tool-heavy input", () => {
    const messages = Array.from({ length: 20 }, (_, index) => [
      user(`turn ${index}`),
      assistantTools([`call-${index}`]),
      toolResult(`call-${index}`, "result".repeat(100)),
    ]).flat();
    messages.push(user("current"));
    const input = {
      messages,
      fixedTokens: 2_000,
      budget: budget(8_000, 10_000, 32_000),
      config: config({ recentTailTokens: 12_000 }),
    };

    const first = planManagedContext(input);
    const second = planManagedContext(input);

    expect(first).toEqual(second);
    expect(first.planning.recentTailTokenLimit).toBe(12_000);
    expect(first.messages.at(-1)).toEqual(user("current"));
  });
});
