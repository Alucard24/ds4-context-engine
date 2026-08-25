import { bench, describe } from "vitest";
import { DEFAULT_CONFIG } from "ds4-context-core/config/config";
import {
  analyzeModelCalibration,
  resolveModelAwareness,
  type TokenCalibrationSample,
} from "ds4-context-core/core/model-awareness";

const samples: TokenCalibrationSample[] = Array.from({ length: 200 }, (_, index) => {
  const estimatedTokens = 40_000 + index * 17;
  const ratio = index % 37 === 0 ? 1.9 : 1.08 + (index % 7) * 0.01;
  const actualInputTokens = Math.round(estimatedTokens * ratio);
  const cacheReadTokens = Math.floor(actualInputTokens * 0.35);
  const cacheWriteTokens = Math.floor(actualInputTokens * 0.05);
  return {
    estimatedTokens,
    actualInputTokens,
    inputTokens: actualInputTokens - cacheReadTokens - cacheWriteTokens,
    cacheReadTokens,
    cacheWriteTokens,
    createdAt: 10_000 - index,
  };
});

const models = [
  { provider: "bench", id: "small-32k", contextWindow: 32_000, maxTokens: 4_096 },
  { provider: "bench", id: "medium-128k", contextWindow: 128_000, maxTokens: 16_384 },
  { provider: "bench", id: "large-200k", contextWindow: 200_000, maxTokens: 32_768 },
];

describe("advanced model awareness performance", () => {
  bench("analyze bounded 200-sample calibration window", () => {
    analyzeModelCalibration(samples, {
      ...DEFAULT_CONFIG.modelAwareness,
      calibrationWindow: 200,
    });
  }, { time: 1_000 });

  bench("resolve 32k/128k/200k adaptive profiles", () => {
    for (const model of models) {
      resolveModelAwareness(
        model,
        DEFAULT_CONFIG.context,
        DEFAULT_CONFIG.modelAwareness,
        samples,
      );
    }
  }, { time: 1_000 });
});
