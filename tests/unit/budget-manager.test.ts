import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { calculateContextBudget } from "../../src/core/budget-manager.ts";
import { createModelProfile } from "../../src/core/model-profile.ts";

describe("calculateContextBudget", () => {
  it("reserves output and safety tokens before applying the preferred target", () => {
    const profile = createModelProfile({
      provider: "test",
      id: "model-200k",
      contextWindow: 200_000,
      maxTokens: 32_768,
      reasoning: true,
      input: ["text", "image"],
    });

    const budget = calculateContextBudget(profile, DEFAULT_CONFIG.context);

    expect(profile.safetyMarginTokens).toBe(4_000);
    expect(budget.outputReserve).toBe(32_768);
    expect(budget.modelInputHardLimit).toBe(163_232);
    expect(budget.hardInputLimit).toBe(163_232);
    expect(budget.softInputLimit).toBe(160_000);
    expect(budget.preferredInputTarget).toBe(140_000);
    expect(budget.activeInputBudget).toBe(140_000);
  });

  it("honors a model output ceiling below the configured minimum reserve", () => {
    const profile = createModelProfile({
      provider: "local",
      id: "small",
      contextWindow: 32_000,
      maxTokens: 4_096,
    });

    const budget = calculateContextBudget(profile, DEFAULT_CONFIG.context);

    expect(budget.outputReserve).toBe(4_096);
    expect(budget.activeInputBudget).toBeLessThanOrEqual(budget.hardInputLimit);
    expect(budget.hardInputLimit).toBeLessThan(budget.contextWindow);
  });
});
