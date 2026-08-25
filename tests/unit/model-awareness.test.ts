import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { calculateContextBudget } from "../../src/core/budget-manager.ts";
import {
  analyzeModelCalibration,
  resolveModelAwareness,
  type TokenCalibrationSample,
} from "../../src/core/model-awareness.ts";

function sample(
  ratio: number,
  createdAt: number,
  cacheReadTokens = 200,
  cacheWriteTokens = 100,
): TokenCalibrationSample {
  const estimatedTokens = 1_000;
  const actualInputTokens = Math.round(estimatedTokens * ratio);
  return {
    estimatedTokens,
    actualInputTokens,
    inputTokens: Math.max(0, actualInputTokens - cacheReadTokens - cacheWriteTokens),
    cacheReadTokens,
    cacheWriteTokens,
    createdAt,
  };
}

function model(id: string, contextWindow: number) {
  return {
    provider: "test",
    id,
    contextWindow,
    maxTokens: 4_096,
  };
}

describe("advanced model awareness", () => {
  it("derives adaptive limits for 32k, 128k, and 200k models", () => {
    const small = resolveModelAwareness(
      model("small", 32_000),
      DEFAULT_CONFIG.context,
      DEFAULT_CONFIG.modelAwareness,
    );
    const medium = resolveModelAwareness(
      model("medium", 128_000),
      DEFAULT_CONFIG.context,
      DEFAULT_CONFIG.modelAwareness,
    );
    const large = resolveModelAwareness(
      model("large", 200_000),
      DEFAULT_CONFIG.context,
      DEFAULT_CONFIG.modelAwareness,
    );

    expect(small.limits).toMatchObject({
      recentTailTokens: 12_000,
      maxRetrievedHistoryTokens: 4_000,
      maxProjectTokens: 4_000,
    });
    expect(medium.limits).toMatchObject({
      recentTailTokens: 24_000,
      maxRetrievedHistoryTokens: 8_000,
      maxProjectTokens: 12_000,
    });
    expect(large.limits).toMatchObject({
      recentTailTokens: 32_000,
      maxRetrievedHistoryTokens: 16_000,
      maxProjectTokens: 20_000,
    });
  });

  it("applies deterministic global, provider, and exact model overrides", () => {
    const resolved = resolveModelAwareness(
      model("large/model", 128_000),
      DEFAULT_CONFIG.context,
      {
        ...DEFAULT_CONFIG.modelAwareness,
        overrides: {
          "*": { safetyMarginTokens: 2_000, maxProjectTokens: 7_000 },
          "test/*": { contextWindow: 200_000, recentTailTokens: 30_000 },
          "test/large/model": { maxRetrievedHistoryTokens: 11_000 },
        },
      },
    );

    expect(resolved.overrideKeys).toEqual(["*", "test/*", "test/large/model"]);
    expect(resolved.profile).toMatchObject({ contextWindow: 200_000, safetyMarginTokens: 2_000 });
    expect(resolved.limits).toMatchObject({
      recentTailTokens: 30_000,
      maxRetrievedHistoryTokens: 11_000,
      maxProjectTokens: 7_000,
    });
  });

  it("uses a bounded robust window and rejects ratio outliers", () => {
    const analysis = analyzeModelCalibration([
      sample(1.2, 5, 300, 100),
      sample(1.22, 4, 250, 50),
      sample(1.18, 3, 200, 0),
      sample(1.8, 2, 100, 0),
      sample(3, 1, 0, 0),
    ], DEFAULT_CONFIG.modelAwareness);

    expect(analysis).toMatchObject({
      observedSamples: 5,
      boundedSamples: 4,
      acceptedSamples: 3,
      rejectedSamples: 2,
      outlierSamples: 1,
      medianRatio: 1.2,
      appliedRatio: 1.2,
      calibrated: true,
      cache: {
        sampleCount: 5,
        cacheReadTokens: 850,
        cacheWriteTokens: 150,
      },
    });
  });

  it("keeps the neutral ratio until enough accepted samples exist", () => {
    const analysis = analyzeModelCalibration(
      [sample(1.4, 2), sample(1.42, 1)],
      DEFAULT_CONFIG.modelAwareness,
    );

    expect(analysis).toMatchObject({
      acceptedSamples: 2,
      calibrated: false,
      appliedRatio: 1,
    });
  });

  it("shrinks estimator-unit budgets when actual provider usage is higher", () => {
    const resolved = resolveModelAwareness(
      model("calibrated", 128_000),
      DEFAULT_CONFIG.context,
      DEFAULT_CONFIG.modelAwareness,
      [sample(1.25, 3), sample(1.2, 2), sample(1.3, 1)],
    );
    const budget = calculateContextBudget(
      resolved.profile,
      resolved.contextConfig,
      resolved.calibration,
    );

    expect(budget.calibrationRatio).toBe(1.25);
    expect(budget.hardInputLimit).toBe(Math.floor((budget.nominalHardInputLimit ?? 0) / 1.25));
    expect(resolved.limits.recentTailTokens).toBe(Math.floor(24_000 / 1.25));
    expect(resolved.limits.maxRetrievedHistoryTokens).toBe(Math.floor(8_000 / 1.25));
  });
});
