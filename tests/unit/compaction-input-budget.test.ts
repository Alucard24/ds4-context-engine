import { describe, expect, it } from "vitest";
import { compactionInputBudget } from "ds4-context-core/compaction/input-budget";
import { calculateContextBudget } from "ds4-context-core/core/budget-manager";
import { createModelProfile } from "ds4-context-core/core/model-profile";
import { createDefaultConfig } from "ds4-context-core/config/config";

function budget(ratio = 1) {
  return calculateContextBudget(createModelProfile({
    provider: "test", id: "test", contextWindow: 128_000, maxTokens: 32_768,
  }), createDefaultConfig().context, { appliedRatio: ratio, acceptedSamples: 5, calibrated: true });
}

describe("compaction input budget", () => {
  it.each([0.75, 1, 1.5, 2])("uses calibrated hard limits rather than ordinary fill targets (ratio=%s)", (ratio) => {
    const resolved = budget(ratio);
    const input = compactionInputBudget(resolved, 12_000);
    expect(input).toBe(resolved.hardInputLimit);
    expect(input).toBeGreaterThan(resolved.activeInputBudget);
    expect(input * ratio + resolved.outputReserve + resolved.safetyMargin).toBeLessThanOrEqual(resolved.contextWindow);
    expect(compactionInputBudget(resolved, 12_000, "context")).toBe(resolved.activeInputBudget);
  });

  it("reserves actual requested output even when it exceeds ordinary output reserves", () => {
    const resolved = budget(1.5);
    const input = compactionInputBudget(resolved, 80_000);
    expect(input).toBe(Math.floor((128_000 - resolved.safetyMargin - 80_000) / 1.5));
    expect(input).toBeLessThan(resolved.activeInputBudget);
    expect(compactionInputBudget(resolved, 128_000)).toBe(0);
  });

  it("does not exceed a configured hard policy or an overridden model window", () => {
    const config = createDefaultConfig();
    config.context.hardLimitRatio = 0.5;
    const resolved = calculateContextBudget(createModelProfile({
      provider: "test", id: "test", contextWindow: 128_000, maxTokens: 1024,
    }, { contextWindow: 16_000, safetyMarginTokens: 4096 }), config.context);
    expect(compactionInputBudget(resolved, 512)).toBe(8000);
  });

  it("rejects invalid headroom rather than sending an unbounded request", () => {
    for (const value of [0, -1, NaN, Infinity]) expect(compactionInputBudget(budget(), value)).toBe(0);
    for (const value of [0, -1, NaN, Infinity]) {
      expect(compactionInputBudget({ ...budget(), calibrationRatio: value }, 100)).toBe(0);
    }
  });
});
