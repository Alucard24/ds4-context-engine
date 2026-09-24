import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "ds4-context-core/config/config";
import { calculateContextBudget } from "ds4-context-core/core/budget-manager";
import {
  analyzeModelCalibration,
  detectTokenDrift,
  resolveModelAwareness,
  tokenEstimatorVersion,
  type TokenCalibrationSample,
} from "ds4-context-core/core/model-awareness";
import { CHARS_ESTIMATOR } from "ds4-context-core/core/token-estimator";
import { planManagedContext } from "ds4-context-core/planner/context-planner";
import { O200K_ESTIMATOR } from "../../src/pi-adapter/bpe-token-estimator.ts";

const model = { provider: "openai", id: "gpt-test", contextWindow: 128_000, maxTokens: 4_096 };

function sample(ratio: number, createdAt: number, estimate = 1_000): TokenCalibrationSample {
  const actual = Math.round(estimate * ratio);
  return {
    estimatedTokens: estimate,
    actualInputTokens: actual,
    inputTokens: actual,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    createdAt,
  };
}

const samples = (ratio: number, count: number, estimate = 1_000): TokenCalibrationSample[] =>
  Array.from({ length: count }, (_, index) => sample(ratio, count - index, estimate));

describe("model-aware token estimation", () => {
  it("uses actual o200k BPE only for explicitly configured model profiles", () => {
    const text = "Hello world";
    expect(O200K_ESTIMATOR.estimateTextTokens(text)).toBe(2);
    expect(CHARS_ESTIMATOR.estimateTextTokens(text)).toBe(3);

    const config = {
      ...DEFAULT_CONFIG.modelAwareness,
      overrides: { "openai/*": { tokenEstimator: "o200k-base-v1" as const } },
    };
    expect(tokenEstimatorVersion(model, DEFAULT_CONFIG.modelAwareness)).toBe("chars-v1");
    expect(tokenEstimatorVersion(model, config)).toBe("o200k-base-v1");
    expect(tokenEstimatorVersion(model, { ...config, enabled: false })).toBe("chars-v1");
    expect(resolveModelAwareness(model, DEFAULT_CONFIG.context, config).calibration.estimator).toBe("o200k-base-v1");
  });

  it("uses the selected text estimator for message budgets and atomic planning", () => {
    const messages = [{ role: "user", content: "Hello world".repeat(200) }];
    const budget = calculateContextBudget(
      resolveModelAwareness(model, DEFAULT_CONFIG.context, DEFAULT_CONFIG.modelAwareness).profile,
      DEFAULT_CONFIG.context,
    );
    const input = {
      messages,
      fixedTokens: 0,
      budget,
      config: DEFAULT_CONFIG.context,
    };
    const chars = planManagedContext(input);
    const bpe = planManagedContext({ ...input, tokenEstimator: O200K_ESTIMATOR });
    expect(chars.planning.originalMessageTokens).toBe(CHARS_ESTIMATOR.estimateMessagesTokens(messages));
    expect(bpe.planning.originalMessageTokens).toBe(O200K_ESTIMATOR.estimateMessagesTokens(messages));
    expect(bpe.planning.originalMessageTokens).not.toBe(chars.planning.originalMessageTokens);
    expect(bpe.selected[0]?.tokens).toBe(O200K_ESTIMATOR.estimateMessageTokens(messages[0]));
  });

  it("reports persistent under/overestimates and many outliers, not single noisy samples", () => {
    const config = DEFAULT_CONFIG.modelAwareness;
    const detect = (values: TokenCalibrationSample[]) => detectTokenDrift(analyzeModelCalibration(values, config));
    expect(detect(samples(1.4, 2))).toBeUndefined();
    expect(detect(samples(1.05, 8))).toBeUndefined();
    expect(detect(samples(1.4, 3))).toMatchObject({ code: "persistent-underestimate", severity: "warning" });
    expect(detect(samples(0.6, 3))).toMatchObject({ code: "persistent-overestimate", severity: "critical" });
    expect(detect(samples(3, 3))).toMatchObject({ code: "calibration-outliers" });
    expect(detect(samples(1, 3).map((entry) => ({ ...entry, estimatedTokens: 0 })))).toBeUndefined();
    expect(detectTokenDrift(analyzeModelCalibration(samples(1.4, 8), { ...config, enabled: false }))).toBeUndefined();
  });

  it("gates auto-tuning on eight accepted samples and ample measured headroom", () => {
    const context = DEFAULT_CONFIG.context;
    const base = resolveModelAwareness(model, context, DEFAULT_CONFIG.modelAwareness);
    const config = { ...DEFAULT_CONFIG.modelAwareness, autoTune: true };
    const collecting = resolveModelAwareness(model, context, config, samples(1, 7));
    expect(collecting.autoTune?.status).toBe("insufficient-samples");
    expect(collecting.limits.recentTailTokens).toBe(base.limits.recentTailTokens);

    const expanded = resolveModelAwareness(model, context, config, samples(1, 8));
    expect(expanded.autoTune).toMatchObject({ status: "expanded", acceptedSamples: 8, boostFactor: 1.125 });
    expect(expanded.limits.recentTailTokens).toBeGreaterThan(base.limits.recentTailTokens);
    expect(expanded.limits.maxRetrievedHistoryTokens).toBeLessThanOrEqual(context.maxRetrievedHistoryTokens);
    expect(expanded.limits.maxProjectTokens).toBeLessThanOrEqual(context.maxProjectTokens);

    const explicit = resolveModelAwareness(model, context, {
      ...config,
      overrides: { "openai/*": { recentTailTokens: 20_000 } },
    }, samples(1, 8));
    expect(explicit.limits.recentTailTokens).toBe(20_000);

    const busy = resolveModelAwareness(model, context, config, samples(1, 8, 100_000));
    expect(busy.autoTune?.status).toBe("no-headroom");
    expect(busy.limits.recentTailTokens).toBe(base.limits.recentTailTokens);
  });

  it("keeps calibrated category limits within configured maxima even on strong overestimation", () => {
    const context = DEFAULT_CONFIG.context;
    const awareness = resolveModelAwareness(model, context, {
      ...DEFAULT_CONFIG.modelAwareness, autoTune: true,
    }, samples(0.5, 8));
    expect(awareness.calibration.appliedRatio).toBe(0.5);
    expect(awareness.limits.recentTailTokens).toBeLessThanOrEqual(context.recentTailTokens);
    expect(awareness.limits.maxRetrievedHistoryTokens).toBeLessThanOrEqual(context.maxRetrievedHistoryTokens);
    expect(awareness.limits.maxProjectTokens).toBeLessThanOrEqual(context.maxProjectTokens);
  });

  it("does not expand budgets when a recent high-usage sample is rejected as a ratio outlier", () => {
    const context = DEFAULT_CONFIG.context;
    const config = { ...DEFAULT_CONFIG.modelAwareness, autoTune: true };
    const baseline = resolveModelAwareness(model, context, DEFAULT_CONFIG.modelAwareness);
    const observed = resolveModelAwareness(model, context, config, [
      sample(100, 9), // 100k actual tokens near the 128k window; excluded from ratio calibration
      ...samples(1, 8),
    ]);
    expect(observed.calibration).toMatchObject({ acceptedSamples: 8, hardBoundSamples: 1 });
    expect(observed.autoTune?.status).toBe("no-headroom");
    expect(observed.limits.recentTailTokens).toBe(baseline.limits.recentTailTokens);
  });

  it.each(["openai/gpt-6-sol", "openai/gpt-6-luna", "openai/gpt-5.6-terra"])(
    "actually expands an opt-in native-window category, then withdraws after high provider usage for %s",
    (id) => {
      const target = { provider: "openrouter", id, contextWindow: 1_050_000, maxTokens: 64 };
      // Native-window defaults already cap the tail at 64k. Raise the
      // *configured* ceiling only for this opt-in safety scenario, so
      // expansion/withdrawal can be observed rather than inferred from status.
      const context = { ...DEFAULT_CONFIG.context,
        recentTailTokens: 80_000, maxRetrievedHistoryTokens: 40_000, maxProjectTokens: 40_000 };
      const config = { ...DEFAULT_CONFIG.modelAwareness, autoTune: true,
        overrides: { [`openrouter/${id}`]: { tokenEstimator: "o200k-base-v1" as const } },
      };
      const low = samples(1, 8, 24_000);
      const expanded = resolveModelAwareness(target, context, config, low);
      const lowBaseline = resolveModelAwareness(target, context, { ...config, autoTune: false }, low);
      expect(expanded.autoTune?.status).toBe("expanded");
      expect(expanded.limits.recentTailTokens).toBeGreaterThan(lowBaseline.limits.recentTailTokens);
      expect(expanded.limits.recentTailTokens).toBeLessThanOrEqual(context.recentTailTokens);
      const high = [sample(1, 9, 475_000), ...low];
      const withdrawn = resolveModelAwareness(target, context, config, high);
      const highBaseline = resolveModelAwareness(target, context, { ...config, autoTune: false }, high);
      expect(withdrawn.autoTune?.status).toBe("no-headroom");
      expect(withdrawn.limits.recentTailTokens).toBe(highBaseline.limits.recentTailTokens);
      expect(withdrawn.limits.recentTailTokens).toBeLessThan(expanded.limits.recentTailTokens);
    },
  );

  it.each(["openai/gpt-6-sol", "openai/gpt-6-luna", "openai/gpt-5.6-terra"])(
    "retains native-window budget limits and withdraws on high usage for %s (local samples)",
    (id) => {
      const target = { provider: "openrouter", id, contextWindow: 1_050_000, maxTokens: 128_000 };
      const context = DEFAULT_CONFIG.context;
      const config = { ...DEFAULT_CONFIG.modelAwareness, autoTune: true,
        overrides: { [`openrouter/${id}`]: { tokenEstimator: "o200k-base-v1" as const } },
      };
      expect(tokenEstimatorVersion(target, DEFAULT_CONFIG.modelAwareness)).toBe("chars-v1");
      const baseline = resolveModelAwareness(target, context, config);
      expect(baseline.calibration.estimator).toBe("o200k-base-v1");
      const budget = calculateContextBudget(baseline.profile, context);
      expect(budget.nominalPreferredInputTarget).toBe(735_000);
      expect(budget.hardInputLimit).toBeLessThanOrEqual(1_050_000 - budget.outputReserve);
      expect(budget.activeInputBudget).toBeLessThanOrEqual(budget.hardInputLimit);
      const expanded = resolveModelAwareness(target, context, config, samples(0.75, 8, 24_000));
      expect(expanded.autoTune?.status).toBe("expanded");
      // The native-window profile has already reached the configured category
      // caps: "expanded" means safe headroom, not that a ceiling actually grew.
      expect(expanded.limits.recentTailTokens).toBe(context.recentTailTokens);
      expect(expanded.limits.recentTailTokens).toBe(baseline.limits.recentTailTokens);
      const calibratedBudget = calculateContextBudget(expanded.profile, context, expanded.calibration);
      expect(calibratedBudget.hardInputLimit).toBe(budget.hardInputLimit);
      expect(calibratedBudget.preferredInputTarget).toBe(budget.preferredInputTarget);
      const busy = resolveModelAwareness(target, context, config, [
        sample(442, 9), // 442k provider tokens: ratio outlier but above 60% of the 735k target
        ...samples(0.75, 8, 24_000),
      ]);
      expect(busy.calibration).toMatchObject({ acceptedSamples: 8, hardBoundSamples: 1 });
      expect(busy.autoTune?.status).toBe("no-headroom");
      expect(busy.limits.recentTailTokens).toBeLessThanOrEqual(context.recentTailTokens);
      expect(busy.limits.maxRetrievedHistoryTokens).toBeLessThanOrEqual(context.maxRetrievedHistoryTokens);
      expect(busy.limits.maxProjectTokens).toBeLessThanOrEqual(context.maxProjectTokens);
    },
  );
});
