import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compareHybridRetrievalCorpus,
  type SemanticQualityCorpus,
} from "ds4-context-core/retrieval/semantic-quality";
import { stableStringify } from "ds4-context-core/shared/stable-json";
import { LocalFeatureHashEmbedding } from "../../src/pi-adapter/local-embedding.ts";

describe("hybrid retrieval quality golden", () => {
  it("improves M14-compatible evidence recall without irrelevant-token regression", () => {
    const corpus = JSON.parse(
      readFileSync("quality/semantic-corpus-v1.json", "utf8"),
    ) as SemanticQualityCorpus;
    const report = compareHybridRetrievalCorpus(corpus, new LocalFeatureHashEmbedding(256));
    const expected = readFileSync(
      "tests/golden/hybrid-retrieval-comparison.json",
      "utf8",
    ).trim();

    expect(stableStringify(report)).toBe(expected);
    expect(report.aggregate.evidenceRecallDelta).toBeGreaterThan(0);
    expect(report.aggregate.irrelevantTokenRatioDelta).toBeLessThanOrEqual(0.05);
    expect(report.fixtures.find((fixture) => fixture.fixtureId === "exact-path-priority")
      ?.hybrid.selectedEvidenceIds).toEqual(["evidence:exact-path"]);
  });
});
