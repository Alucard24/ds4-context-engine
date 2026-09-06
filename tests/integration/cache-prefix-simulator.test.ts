import { describe, expect, it } from "vitest";
import {
  commonMessagePrefixLength,
  estimateReusablePrefixTokens,
  estimateRequestCost,
  type CachePricing,
} from "ds4-context-core/planner/cache-policy";

/**
 * Synthetic prefix-cache simulator. Models the provider as a prefix cache:
 * a request is billed as `cacheRead` for the longest shared prefix with the
 * previous request and `input` (miss) for the remainder. All scenarios are
 * deterministic; no provider, no network, no credentials.
 */

// DeepSeek V4 Flash off-peak rates from the report (for the analysis only;
// the runtime policy never hardcodes prices).
const deepseek: CachePricing = {
  inputPerMillion: 0.22,
  cacheReadPerMillion: 0.007,
  cacheWritePerMillion: 0.22,
  outputPerMillion: 0.66,
};

interface Request {
  /** Serialized prompt parts: system, tools, then messages. */
  parts: string[];
  /** Fixed prefix (system + tools) in tokens. */
  fixedTokens: number;
  /** Message token estimates aligned with parts after the fixed prefix. */
  messageTokens: number[];
}

interface Usage {
  inputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  cost: number;
}

function simulate(previous: Request | undefined, current: Request, pricing: CachePricing): Usage {
  const previousHashes = previous?.parts.map((part) => hash(part)) ?? [];
  const currentHashes = current.parts.map((part) => hash(part));
  const common = commonMessagePrefixLength(previousHashes, currentHashes);
  // Parts are messages only; the system/tools prefix is stable across requests
  // in this model, so it is always reusable when the previous request exists.
  const fixedCommon = previous ? current.fixedTokens : 0;
  let messageReusable = 0;
  for (let index = 0; index < common; index++) {
    const tokens = current.messageTokens[index];
    if (tokens !== undefined && Number.isFinite(tokens) && tokens > 0) {
      messageReusable += tokens;
    }
  }
  const totalInputTokens = current.fixedTokens + current.messageTokens.reduce((sum, value) => sum + value, 0);
  const reusablePrefixTokens = Math.min(totalInputTokens, fixedCommon + messageReusable);
  const cost = estimateRequestCost({
    totalInputTokens,
    reusablePrefixTokens,
    outputTokens: 0,
  }, pricing);
  return {
    inputTokens: totalInputTokens - reusablePrefixTokens,
    cacheReadTokens: reusablePrefixTokens,
    totalTokens: totalInputTokens,
    cost: cost.total ?? 0,
  };
}

function hash(value: string): string {
  let output = 0;
  for (let index = 0; index < value.length; index++) {
    output = (output * 31 + value.charCodeAt(index)) | 0;
  }
  return `h${output}`;
}

function request(parts: string[], fixedTokens: number, messageTokens: number[]): Request {
  return { parts, fixedTokens, messageTokens };
}

/** Turn sequence generator: each turn appends a user+assistant pair. */
function conversation(turns: number, tokensPerTurn: number, seed = ""): Request {
  const parts: string[] = [];
  const messageTokens: number[] = [];
  for (let index = 0; index < turns; index++) {
    parts.push(`user:${seed}t${index}`);
    messageTokens.push(Math.floor(tokensPerTurn / 2));
    parts.push(`assistant:${seed}a${index}`);
    messageTokens.push(Math.ceil(tokensPerTurn / 2));
  }
  return request(parts, 2_000, messageTokens);
}

describe("synthetic prefix-cache simulator", () => {
  it("append-only conversation under the tail limit: every request hits the shared prefix", () => {
    let previous: Request | undefined;
    const usages: Usage[] = [];
    for (let turn = 1; turn <= 20; turn++) {
      const current = conversation(turn, 2_000, "append");
      const usage = simulate(previous, current, deepseek);
      usages.push(usage);
      previous = current;
    }
    // Each request shares all but the last turn; the last turn is a miss.
    const last = usages.at(-1)!;
    expect(last.cacheReadTokens).toBeGreaterThan(0);
    // Append-only: almost everything is cached after the first request.
    const totalCache = usages.slice(1).reduce((sum, usage) => sum + usage.cacheReadTokens, 0);
    const totalInput = usages.slice(1).reduce((sum, usage) => sum + usage.inputTokens, 0);
    expect(totalCache).toBeGreaterThan(totalInput * 10);
  });

  it("sliding window past the 64k tail cap invalidates the prefix", () => {
    // Simulate the planner truncating to a fixed 64k tail: as the window
    // slides, the first content part changes and the shared prefix collapses.
    const tokensPerTurn = 8_000;
    const tailCap = 64_000;
    let previous: Request | undefined;
    const usages: Usage[] = [];
    for (let turn = 1; turn <= 30; turn++) {
      const full = conversation(turn, tokensPerTurn, "slide");
      // Keep only the last `tailCap` tokens worth of parts, mimicking the
      // planner's contiguous recent tail.
      let budget = tailCap;
      const keptParts: string[] = [];
      const keptTokens: number[] = [];
      for (let index = full.messageTokens.length - 1; index >= 0 && budget > 0; index--) {
        const tokens = full.messageTokens[index] ?? 0;
        if (tokens > budget) continue;
        keptParts.unshift(full.parts[index + 1] ?? "");
        keptTokens.unshift(tokens);
        budget -= tokens;
      }
      const current = request([...keptParts], full.fixedTokens, keptTokens);
      const usage = simulate(previous, current, deepseek);
      usages.push(usage);
      previous = current;
    }
    // Once the window slides, the prefix drops to almost nothing: miss dominates.
    const late = usages.slice(10);
    const cacheShare = late.reduce((sum, usage) => sum + usage.cacheReadTokens, 0)
      / late.reduce((sum, usage) => sum + usage.totalTokens, 0);
    expect(cacheShare).toBeLessThan(0.35);
  });

  it("a stable wide tail keeps the prefix warm across many requests", () => {
    const tokensPerTurn = 16_000;
    const tailCap = 500_000; // wide tail, like the DeepSeek workaround override
    let previous: Request | undefined;
    const usages: Usage[] = [];
    for (let turn = 1; turn <= 30; turn++) {
      const current = conversation(turn, tokensPerTurn, "wide");
      const usage = simulate(previous, current, deepseek);
      usages.push(usage);
      previous = current;
    }
    const totalTokens = usages.reduce((sum, usage) => sum + usage.totalTokens, 0);
    const cacheTokens = usages.reduce((sum, usage) => sum + usage.cacheReadTokens, 0);
    expect(cacheTokens / totalTokens).toBeGreaterThan(0.9);
  });

  it("wide tail wins on an append-only session; small tail wins on a giant-turn stream", () => {
    const run = (cap: number, tokensPerTurn: number, turns: number) => {
      let previous: Request | undefined;
      const usages: Usage[] = [];
      for (let turn = 1; turn <= turns; turn++) {
        const full = conversation(turn, tokensPerTurn, `cmp-${cap}-${tokensPerTurn}`);
        let budget = cap;
        const keptParts: string[] = [];
        const keptTokens: number[] = [];
        for (let index = full.messageTokens.length - 1; index >= 0 && budget > 0; index--) {
          const tokens = full.messageTokens[index] ?? 0;
          if (tokens > budget) continue;
          keptParts.unshift(full.parts[index + 1] ?? "");
          keptTokens.unshift(tokens);
          budget -= tokens;
        }
        const current = request([...keptParts], full.fixedTokens, keptTokens);
        const usage = simulate(previous, current, deepseek);
        usages.push(usage);
        previous = current;
      }
      return usages.reduce((sum, usage) => sum + usage.cost, 0);
    };
    // Append-only session with 16k-turn average and 20 turns (~320k total):
    // the 64k cap starts sliding at turn 5 and pays a cold miss on every
    // subsequent request; the 500k tail never slides and keeps hits.
    const appendSmall = run(64_000, 16_000, 20);
    const appendWide = run(500_000, 16_000, 20);
    expect(appendWide).toBeLessThan(appendSmall);
    // Giant-turn stream (140k per turn, one response per prompt): even the
    // wide tail slides on every turn, and its reset is vastly more expensive.
    const giantSmall = run(64_000, 140_000, 8);
    const giantWide = run(500_000, 140_000, 8);
    expect(giantWide).toBeGreaterThan(giantSmall);
    // Both workloads are deterministic; pin the relative magnitudes so that
    // future changes to the simulator or the policy are visible.
    expect(appendWide / appendSmall).toBeLessThan(0.75);
    expect(giantWide / giantSmall).toBeGreaterThan(5);
  });

  it("five tool cycles on the same prefix amortize the initial cold transition", () => {
    let previous: Request | undefined;
    const firstTurn = conversation(10, 4_000, "tool");
    const usages: Usage[] = [];
    for (let cycle = 0; cycle < 5; cycle++) {
      // Same context, appended tool call/result pair.
      const current = request(
        [...firstTurn.parts, `tool-call:${cycle}`, `tool-result:${cycle}`],
        firstTurn.fixedTokens,
        [...firstTurn.messageTokens, 300, 600],
      );
      usages.push(simulate(previous, current, deepseek));
      previous = current;
    }
    const first = usages[0]!;
    const later = usages.slice(1);
    const laterCacheShare = later.reduce((sum, usage) => sum + usage.cacheReadTokens, 0)
      / later.reduce((sum, usage) => sum + usage.totalTokens, 0);
    expect(laterCacheShare).toBeGreaterThan(0.95);
    expect(first.inputTokens).toBeGreaterThan(later[0]!.inputTokens);
  });

  it("model switch invalidates the cached prefix", () => {
    const base = conversation(8, 2_000, "switch");
    const first = simulate(undefined, base, deepseek);
    const second = simulate(base, base, deepseek);
    // Same content, same model: prefix fully reused.
    expect(second.cacheReadTokens).toBe(first.totalTokens);
    // Model switched perspective: the provider cache key changes, but our
    // simulator has no provider identity; the runtime guards model switches
    // by clearing lastPlanMessageHashes. The core behavior is that an empty
    // previous hashes list yields zero reusable prefix:
    const cold = simulate(undefined, base, deepseek);
    expect(cold.cacheReadTokens).toBe(0);
    expect(cold.inputTokens).toBe(cold.totalTokens);
  });

  it("cost comparison across candidates uses the same pricing", () => {
    const nominal = estimateRequestCost({
      totalInputTokens: 80_000,
      reusablePrefixTokens: 10_000,
    }, deepseek);
    const cacheAware = estimateRequestCost({
      totalInputTokens: 500_000,
      reusablePrefixTokens: 460_000,
    }, deepseek);
    expect(nominal.total).toBeDefined();
    expect(cacheAware.total).toBeDefined();
    // 460k cached at 0.007 + 40k miss at 0.22 < 70k miss at 0.22.
    expect(cacheAware.total!).toBeLessThan(nominal.total!);
  });
});
