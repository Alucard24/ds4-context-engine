import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compareQualityStrategies,
  staticRankingStrategy,
  taskWeightedCandidateStrategy,
  type QualityReplayCorpus,
} from "ds4-context-core/quality/context-quality";
import { stableStringify } from "ds4-context-core/shared/stable-json";

describe("context quality comparison golden", () => {
  it("keeps non-timing replay output byte-stable", () => {
    const corpus = JSON.parse(readFileSync("quality/corpus-v1.json", "utf8")) as QualityReplayCorpus;
    const expected = readFileSync("tests/golden/context-quality-comparison.json", "utf8").trim();
    const actual = stableStringify(compareQualityStrategies(corpus, [
      staticRankingStrategy(),
      taskWeightedCandidateStrategy(),
    ]));

    expect(actual).toBe(expected);
  });
});
