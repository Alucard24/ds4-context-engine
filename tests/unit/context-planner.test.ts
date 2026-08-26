import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type ContextConfig } from "ds4-context-core/config/config";
import { calculateContextBudget, type ContextBudget } from "ds4-context-core/core/budget-manager";
import { createModelProfile } from "ds4-context-core/core/model-profile";
import { estimateMessagesTokens } from "ds4-context-core/core/token-estimator";
import {
  adaptiveRecentTailLimit,
  planManagedContext,
} from "ds4-context-core/planner/context-planner";

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

  it("fits retrieved evidence after recent turns and before the current request", () => {
    const messages = [user("recent request"), assistantText("recent response"), user("current LastExportUtc question")];
    const evidence = user("[DS4 HISTORICAL EVIDENCE] LastExportUtc stays nullable");
    const plan = planManagedContext({
      messages,
      fixedTokens: 100,
      budget: budget(2_000, 2_500),
      config: config({ recentTailTokens: 1_000, maxRetrievedHistoryTokens: 500 }),
      supplementalMessages: [{
        id: "retrieval:entry-old",
        message: evidence,
        kind: "retrieval",
        sourceIds: ["entry-old"],
        score: 185,
        reason: "exact identifier: LastExportUtc",
      }],
    });

    expect(plan.mode).toBe("managed");
    expect(plan.messages).toEqual([messages[0], messages[1], evidence, messages[2]]);
    expect(plan.selected.find((item) => item.kind === "retrieval")).toMatchObject({
      originalIndex: 2,
      sourceId: "entry-old",
      retrievedEventIds: ["entry-old"],
    });
    expect(plan.selected.find((item) => item.kind === "current")?.originalIndex).toBe(3);
  });

  it("fits project snippets after historical evidence and before summaries", () => {
    const messages = [user("recent request"), assistantText("recent response"), user("current TargetSymbol question")];
    const history = user("[DS4 HISTORICAL EVIDENCE] prior decision");
    const project = user("[DS4 PROJECT SOURCE] export function TargetSymbol() {}");
    const plan = planManagedContext({
      messages,
      fixedTokens: 100,
      budget: budget(2_000, 2_500),
      config: config({ recentTailTokens: 1_000, maxRetrievedHistoryTokens: 500, maxProjectTokens: 500 }),
      supplementalMessages: [
        {
          id: "retrieval:entry-old",
          message: history,
          kind: "retrieval",
          sourceIds: ["entry-old"],
          score: 85.5,
          reason: "historical match",
        },
        {
          id: "project:snippet-1",
          message: project,
          kind: "project",
          sourceIds: ["project:snippet-1"],
          score: 80.5,
          reason: "exact symbol TargetSymbol",
          projectSnippet: {
            snippetId: "snippet-1",
            path: "src/Target.ts",
            hash: "hash-1",
            startLine: 1,
            endLine: 10,
          },
        },
      ],
    });

    expect(plan.mode).toBe("managed");
    expect(plan.messages).toEqual([messages[0], messages[1], history, project, messages[2]]);
    expect(plan.selected.find((item) => item.kind === "project")).toMatchObject({
      sourceId: "project:snippet-1",
      projectSnippet: { snippetId: "snippet-1", path: "src/Target.ts" },
    });
  });

  it("excludes project snippets atomically when their dedicated budget is unavailable", () => {
    const messages = [user("current request")];
    const project = user("[DS4 PROJECT SOURCE] relevant source");
    const plan = planManagedContext({
      messages,
      fixedTokens: 100,
      budget: budget(1_000, 2_000),
      config: config({ maxProjectTokens: 0 }),
      supplementalMessages: [{
        id: "project:snippet-1",
        message: project,
        kind: "project",
        sourceIds: ["project:snippet-1"],
        score: 80,
        reason: "project match",
        projectSnippet: { snippetId: "snippet-1", path: "src/Target.ts", hash: "hash-1" },
      }],
    });

    expect(plan.mode).toBe("managed");
    expect(plan.messages).toEqual(messages);
    expect(plan.excluded.find((item) => item.kind === "project")).toMatchObject({
      sourceId: "project:snippet-1",
      projectSnippet: { snippetId: "snippet-1" },
    });
  });

  it("excludes retrieved evidence atomically when its dedicated budget is unavailable", () => {
    const messages = [user("current request")];
    const evidence = user(`evidence ${"x".repeat(1_000)}`);
    const plan = planManagedContext({
      messages,
      fixedTokens: 100,
      budget: budget(1_000, 2_000),
      config: config({ maxRetrievedHistoryTokens: 0 }),
      supplementalMessages: [{
        id: "retrieval:entry-old",
        message: evidence,
        kind: "retrieval",
        sourceIds: ["entry-old"],
        score: 100,
        reason: "historical match",
      }],
    });

    expect(plan.mode).toBe("managed");
    expect(plan.messages).toEqual(messages);
    expect(plan.excluded.find((item) => item.kind === "retrieval")).toMatchObject({
      sourceId: "entry-old",
      retrievedEventIds: ["entry-old"],
    });
  });

  it("fails open without leaking synthetic retrieval messages", () => {
    const messages = [user(`current ${"x".repeat(4_000)}`)];
    const plan = planManagedContext({
      messages,
      fixedTokens: 100,
      budget: budget(300, 500),
      config: config(),
      supplementalMessages: [
        {
          id: "retrieval:entry-old",
          message: user("historical evidence"),
          kind: "retrieval",
          sourceIds: ["entry-old"],
          score: 100,
          reason: "historical match",
        },
        {
          id: "project:snippet-1",
          message: user("project evidence"),
          kind: "project",
          sourceIds: ["project:snippet-1"],
          score: 80,
          reason: "project match",
          projectSnippet: { snippetId: "snippet-1", path: "src/Target.ts", hash: "hash-1" },
        },
      ],
    });

    expect(plan.mode).toBe("fallback");
    expect(plan.messages).toEqual(messages);
    expect(plan.messages).not.toContainEqual(user("historical evidence"));
    expect(plan.messages).not.toContainEqual(user("project evidence"));
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

  it("places persistent pins and durable memory ahead of other supplements", () => {
    const current = user("current request about ExportMode");
    const pin = user("persistent pin");
    const memory = user("durable memory");
    const retrieval = user("historical evidence");
    const project = user("project source");

    const plan = planManagedContext({
      messages: [current],
      fixedTokens: 100,
      budget: budget(4_000, 5_000),
      config: config({ recentTailTokens: 0 }),
      supplementalMessages: [
        { id: "pin:p1", message: pin, kind: "pin", sourceIds: ["p1"], score: 950, reason: "explicit pin" },
        { id: "memory:m1", message: memory, kind: "memory", sourceIds: ["m1"], score: 90, reason: "memory match" },
        { id: "retrieval:e1", message: retrieval, kind: "retrieval", sourceIds: ["e1"], score: 85, reason: "history" },
        { id: "project:s1", message: project, kind: "project", sourceIds: ["s1"], score: 80, reason: "project" },
      ],
    });

    expect(plan.mode).toBe("managed");
    expect(plan.messages).toEqual([pin, memory, retrieval, project, current]);
    expect(plan.selected.map((item) => item.kind)).toEqual(["pin", "memory", "retrieval", "project", "current"]);
    expect(plan.selected.find((item) => item.kind === "pin")?.sourceId).toBe("p1");
    expect(plan.selected.find((item) => item.kind === "memory")?.sourceId).toBe("m1");
  });

  it("applies a promoted supplemental order across source kinds without bypassing budgets", () => {
    const current = user("current");
    const memory = user(`memory ${"m".repeat(1_200)}`);
    const retrieval = user(`retrieval ${"r".repeat(1_200)}`);
    const project = user(`project ${"p".repeat(1_200)}`);
    const input = {
      messages: [current],
      fixedTokens: 0,
      budget: budget(400, 1_000),
      config: config({ recentTailTokens: 0 }),
      supplementalMessages: [
        { id: "memory:m1", message: memory, kind: "memory" as const, sourceIds: ["m1"], score: 90, reason: "memory" },
        { id: "retrieval:e1", message: retrieval, kind: "retrieval" as const, sourceIds: ["e1"], score: 85, reason: "retrieval" },
        { id: "project:s1", message: project, kind: "project" as const, sourceIds: ["s1"], score: 80, reason: "project" },
      ],
    };

    const staticPlan = planManagedContext(input);
    const learnedPlan = planManagedContext({
      ...input,
      supplementalSelectionOrder: ["project:s1", "retrieval:e1", "memory:m1"],
    });

    expect(staticPlan.selected.filter((item) => ["memory", "retrieval", "project"].includes(item.kind)))
      .toEqual([expect.objectContaining({ kind: "memory", sourceId: "m1" })]);
    expect(learnedPlan.selected.filter((item) => ["memory", "retrieval", "project"].includes(item.kind)))
      .toEqual([expect.objectContaining({ kind: "project", sourceId: "s1" })]);
    expect(learnedPlan.messages.at(-1)).toEqual(current);
  });

  it("enforces separate memory and mandatory pin budgets", () => {
    const current = user("current");
    const memory = user("memory candidate");
    const memoryExcluded = planManagedContext({
      messages: [current],
      fixedTokens: 0,
      budget: budget(2_000, 3_000),
      config: config({ maxMemoryTokens: 0 }),
      supplementalMessages: [
        { id: "memory:m1", message: memory, kind: "memory", sourceIds: ["m1"], score: 90, reason: "memory" },
      ],
    });
    expect(memoryExcluded.mode).toBe("managed");
    expect(memoryExcluded.messages).toEqual([current]);
    expect(memoryExcluded.excluded.some((item) => item.kind === "memory" && item.sourceId === "m1")).toBe(true);

    const pinOverflow = planManagedContext({
      messages: [current],
      fixedTokens: 0,
      budget: budget(2_000, 3_000),
      config: config({ maxPinnedTokens: 1 }),
      supplementalMessages: [
        { id: "pin:p1", message: user("mandatory pin"), kind: "pin", sourceIds: ["p1"], score: 950, reason: "pin" },
      ],
    });
    expect(pinOverflow.mode).toBe("fallback");
    expect(pinOverflow.messages).toEqual([current]);
    expect(pinOverflow.planning.fallbackReason).toContain("maxPinnedTokens");
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
