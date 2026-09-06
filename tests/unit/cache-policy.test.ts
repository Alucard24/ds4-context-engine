import { describe, expect, it } from "vitest";
import {
  commonMessagePrefixLength,
  DEFAULT_CACHE_AWARE_CONFIG,
  decideCacheAwareTail,
  estimateReusablePrefixTokens,
  estimateRequestCost,
} from "ds4-context-core/planner/cache-policy";

const deepseekPricing = {
  inputPerMillion: 0.22,
  cacheReadPerMillion: 0.007,
  cacheWritePerMillion: 0.22,
  outputPerMillion: 0.66,
};

describe("common message prefix", () => {
  it("counts identical leading hashes", () => {
    expect(commonMessagePrefixLength(["a", "b", "c"], ["a", "b", "c", "d"])).toBe(3);
    expect(commonMessagePrefixLength(["a", "b", "c"], ["a", "x", "c"])).toBe(1);
    expect(commonMessagePrefixLength([], ["a"])).toBe(0);
  });

  it("treats undefined hashes as distinct sentinels", () => {
    expect(commonMessagePrefixLength(["a", undefined], ["a", undefined])).toBe(1);
    expect(commonMessagePrefixLength(["a", "b"], ["a", undefined])).toBe(1);
  });
});

describe("reusable prefix tokens", () => {
  it("sums only the common prefix token estimates", () => {
    const tokens = estimateReusablePrefixTokens(["a", "b", "c"], ["a", "b", "x"], [100, 200, 300]);
    expect(tokens).toBe(300);
  });

  it("ignores invalid token estimates without breaking the sum", () => {
    const tokens = estimateReusablePrefixTokens(["a", "b"], ["a", "b"], [100, Number.NaN]);
    expect(tokens).toBe(100);
  });

  it("returns zero when there is no common prefix", () => {
    expect(estimateReusablePrefixTokens(["a"], ["b"], [100])).toBe(0);
  });
});

describe("estimate request cost", () => {
  it("computes split costs with per-million rates", () => {
    const cost = estimateRequestCost({
      totalInputTokens: 100_000,
      reusablePrefixTokens: 90_000,
      outputTokens: 2_000,
    }, deepseekPricing);
    expect(cost.inputTokens).toBe(10_000);
    expect(cost.cacheReadTokens).toBe(90_000);
    expect(cost.total).toBeCloseTo((10_000 * 0.22 + 90_000 * 0.007 + 2_000 * 0.66) / 1_000_000, 6);
  });

  it("clamps negative inputs and prefix larger than total", () => {
    const cost = estimateRequestCost({ totalInputTokens: 1_000, reusablePrefixTokens: 5_000 }, deepseekPricing);
    expect(cost.inputTokens).toBe(0);
    expect(cost.cacheReadTokens).toBe(1_000);
    expect(cost.total).toBeCloseTo(1_000 * 0.007 / 1_000_000, 9);
  });

  it("returns undefined total when a consumed rate is missing", () => {
    const missingRead = estimateRequestCost({ totalInputTokens: 1_000, reusablePrefixTokens: 500 }, {
      inputPerMillion: 0.22,
    });
    expect(missingRead.total).toBeUndefined();
    const allKnown = estimateRequestCost({ totalInputTokens: 1_000, reusablePrefixTokens: 0 }, {
      inputPerMillion: 0.22,
    });
    expect(allKnown.total).toBeCloseTo(1_000 * 0.22 / 1_000_000, 9);
  });
});

describe("cache-aware tail decision", () => {
  const config = { ...DEFAULT_CACHE_AWARE_CONFIG, mode: "auto" as const };

  it("is disabled in off mode", () => {
    const decision = decideCacheAwareTail({
      config: DEFAULT_CACHE_AWARE_CONFIG,
      pricing: deepseekPricing,
      observedCacheReadShare: 0.9,
      sampleCount: 10,
      nominalRecentTailTokens: 64_000,
      activeInputBudget: 500_000,
    });
    expect(decision.eligible).toBe(false);
    expect(decision.tailExtended).toBe(false);
    expect(decision.recentTailTokens).toBe(64_000);
  });

  it("extends the tail when miss/hit ratio and observed share both pass", () => {
    const decision = decideCacheAwareTail({
      config,
      pricing: deepseekPricing,
      observedCacheReadShare: 0.9,
      sampleCount: 10,
      nominalRecentTailTokens: 64_000,
      activeInputBudget: 1_000_000,
    });
    expect(decision.eligible).toBe(true);
    expect(decision.tailExtended).toBe(true);
    expect(decision.missHitRatio).toBeCloseTo(0.22 / 0.007, 3);
    expect(decision.recentTailTokens).toBe(500_000); // 50% of active input budget
  });

  it("keeps the nominal tail when the budget share is below it", () => {
    // 50% of 100k = 50k < nominal 64k: the budget share bounds the extension,
    // it never shrinks the configured tail below the nominal value.
    const decision = decideCacheAwareTail({
      config,
      pricing: deepseekPricing,
      observedCacheReadShare: 0.8,
      sampleCount: 5,
      nominalRecentTailTokens: 64_000,
      activeInputBudget: 100_000,
    });
    expect(decision.eligible).toBe(true);
    expect(decision.recentTailTokens).toBe(64_000);
    expect(decision.tailExtended).toBe(false);
  });

  it("extends to the budget share when it is larger than the nominal tail", () => {
    const decision = decideCacheAwareTail({
      config,
      pricing: deepseekPricing,
      observedCacheReadShare: 0.8,
      sampleCount: 5,
      nominalRecentTailTokens: 64_000,
      activeInputBudget: 400_000,
    });
    expect(decision.eligible).toBe(true);
    expect(decision.recentTailTokens).toBe(200_000); // 50% of 400k
    expect(decision.tailExtended).toBe(true);
  });

  it("stays nominal when the ratio is below the threshold", () => {
    const decision = decideCacheAwareTail({
      config,
      pricing: { ...deepseekPricing, inputPerMillion: 0.01, cacheReadPerMillion: 0.007 },
      observedCacheReadShare: 0.9,
      sampleCount: 10,
      nominalRecentTailTokens: 64_000,
      activeInputBudget: 1_000_000,
    });
    expect(decision.eligible).toBe(false);
    expect(decision.recentTailTokens).toBe(64_000);
    expect(decision.reasons.some((reason) => reason.startsWith("miss-hit-ratio-below-threshold"))).toBe(true);
  });

  it("stays nominal when the observed cache share is low", () => {
    const decision = decideCacheAwareTail({
      config,
      pricing: deepseekPricing,
      observedCacheReadShare: 0.1,
      sampleCount: 10,
      nominalRecentTailTokens: 64_000,
      activeInputBudget: 1_000_000,
    });
    expect(decision.eligible).toBe(false);
    expect(decision.tailExtended).toBe(false);
  });

  it("stays nominal with insufficient samples", () => {
    const decision = decideCacheAwareTail({
      config,
      pricing: deepseekPricing,
      observedCacheReadShare: 0.9,
      sampleCount: 1,
      nominalRecentTailTokens: 64_000,
      activeInputBudget: 1_000_000,
    });
    expect(decision.eligible).toBe(false);
    expect(decision.recentTailTokens).toBe(64_000);
  });

  it("degrades gracefully when pricing is incomplete", () => {
    const decision = decideCacheAwareTail({
      config,
      pricing: { inputPerMillion: 0.22 },
      observedCacheReadShare: 0.9,
      sampleCount: 10,
      nominalRecentTailTokens: 64_000,
      activeInputBudget: 1_000_000,
    });
    expect(decision.eligible).toBe(false);
    expect(decision.recentTailTokens).toBe(64_000);
    expect(decision.reasons).toContain("cache-pricing-incomplete");
  });
});
