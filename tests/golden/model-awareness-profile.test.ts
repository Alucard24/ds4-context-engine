import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { calculateContextBudget } from "../../src/core/budget-manager.ts";
import {
  resolveModelAwareness,
  type TokenCalibrationSample,
} from "../../src/core/model-awareness.ts";

function sample(
  actualInputTokens: number,
  createdAt: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): TokenCalibrationSample {
  return {
    estimatedTokens: 1_000,
    actualInputTokens,
    inputTokens: actualInputTokens - cacheReadTokens - cacheWriteTokens,
    cacheReadTokens,
    cacheWriteTokens,
    createdAt,
  };
}

describe("advanced model-awareness golden contract", () => {
  it("keeps profile resolution, calibration, and adaptive budgets deterministic", () => {
    const resolved = resolveModelAwareness(
      {
        provider: "golden",
        id: "large-200k",
        contextWindow: 200_000,
        maxTokens: 32_768,
        reasoning: true,
        input: ["text", "image"],
      },
      DEFAULT_CONFIG.context,
      {
        ...DEFAULT_CONFIG.modelAwareness,
        overrides: {
          "golden/large-200k": {
            safetyMarginTokens: 5_000,
            maxRetrievedHistoryTokens: 12_000,
          },
        },
      },
      [
        sample(1_200, 4, 300, 100),
        sample(1_180, 3, 250, 50),
        sample(1_220, 2, 200, 20),
        sample(1_900, 1, 100, 0),
      ],
    );
    const actual = {
      profile: resolved.profile,
      overrideKeys: resolved.overrideKeys,
      calibration: resolved.calibration,
      limits: resolved.limits,
      budget: calculateContextBudget(
        resolved.profile,
        resolved.contextConfig,
        resolved.calibration,
      ),
    };
    const expected = JSON.parse(
      readFileSync(join(import.meta.dirname, "model-awareness-profile.json"), "utf8"),
    ) as unknown;

    expect(actual).toEqual(expected);
  });
});
