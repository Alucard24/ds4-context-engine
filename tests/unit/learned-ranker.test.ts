import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRankingFeatures,
  createRankingFeedback,
  evaluateRankingPromotion,
  loadLearnedRankingModel,
  parseLearnedRankingModel,
  parseRankingFeedback,
  rankCandidates,
  rankingTrainingSample,
  saveLearnedRankingModel,
  trainLearnedRankingModel,
  withRankingPromotion,
  type RankingFeedbackEntry,
  type RankingFeatureVector,
  type RankingPromotionFixture,
  type RankingTrainingSample,
} from "ds4-context-core/ranking/learned-ranker";
import { sha256 } from "ds4-context-core/shared/hash";

function features(input: Partial<RankingFeatureVector> = {}): RankingFeatureVector {
  return createRankingFeatures({
    sourceKind: input.sourceKind ?? "retrieval",
    staticScore: input.staticScore ?? 0.5,
    exactScore: input.exactScore ?? 0,
    ftsScore: input.ftsScore ?? 0,
    vectorScore: input.vectorScore ?? 0,
    recency: input.recency ?? 0.5,
    branchRelation: input.branchRelation ?? 1,
    symbolRelation: input.symbolRelation ?? 0,
    classificationEligible: input.classificationEligible ?? 1,
    tokenCost: input.tokenCost ?? 0.1,
    priorSelected: input.priorSelected ?? 0,
  });
}

function sample(
  sampleId: string,
  label: "useful" | "irrelevant",
  candidateFeatures: RankingFeatureVector,
  repository = "repo-a",
): RankingTrainingSample {
  return {
    sampleId,
    repositoryHash: sha256(repository),
    candidateKeyHash: sha256(`candidate:${sampleId}`),
    labelSource: sampleId.startsWith("replay") ? "replay" : "feedback",
    label,
    classification: "internal",
    features: candidateFeatures,
  };
}

function trainedModel() {
  const samples = [
    sample("feedback-positive-a", "useful", features({ staticScore: 0.2, exactScore: 1 }), "repo-a"),
    sample("feedback-positive-b", "useful", features({ staticScore: 0.25, exactScore: 1 }), "repo-b"),
    sample("feedback-negative-a", "irrelevant", features({ staticScore: 0.9, exactScore: 0 }), "repo-a"),
    sample("feedback-negative-b", "irrelevant", features({ staticScore: 0.85, exactScore: 0 }), "repo-b"),
  ];
  return trainLearnedRankingModel(samples, { createdAt: 1_000, minimumSamples: 4 });
}

function promotionFixtures(): RankingPromotionFixture[] {
  return ["repo-a", "repo-b"].map((repository, fixtureIndex) => ({
    fixtureId: `fixture-${fixtureIndex}`,
    repositoryHash: sha256(repository),
    maxResults: 1,
    maxTokens: 100,
    candidates: [
      {
        id: `irrelevant-${fixtureIndex}`,
        groupId: `group-irrelevant-${fixtureIndex}`,
        tokens: 50,
        relevant: false,
        exactIdentifier: false,
        staticScore: 90,
        features: features({ staticScore: 0.9, exactScore: 0 }),
      },
      {
        id: `relevant-${fixtureIndex}`,
        groupId: `group-relevant-${fixtureIndex}`,
        tokens: 50,
        relevant: true,
        exactIdentifier: true,
        staticScore: 20,
        features: features({ staticScore: 0.2, exactScore: 1 }),
      },
    ],
  }));
}

describe("learned ranking", () => {
  it("creates classified hash-only feedback without persisting raw candidate text", () => {
    const feedback = createRankingFeedback({
      feedbackId: "feedback-1",
      createdAt: 123,
      repositoryIdentity: "/private/project-name",
      candidateKey: "retrieval:raw-entry-id",
      label: "useful",
      classification: "local-only",
      features: features({ exactScore: 1, tokenCost: 4 }),
    });

    expect(feedback.repositoryHash).toBe(sha256("/private/project-name"));
    expect(feedback.candidateKeyHash).toBe(sha256("retrieval:raw-entry-id"));
    expect(feedback.features.tokenCost).toBe(1);
    expect(JSON.stringify(feedback)).not.toContain("private/project-name");
    expect(JSON.stringify(feedback)).not.toContain("raw-entry-id");
    expect(parseRankingFeedback(feedback)).toEqual(feedback);
    expect(parseRankingFeedback({ ...feedback, rawText: "must not be accepted" })).toBeUndefined();
    expect(rankingTrainingSample(feedback)).toMatchObject({
      sampleId: "feedback-1",
      label: "useful",
      classification: "local-only",
    });
  });

  it("trains a deterministic checksummed model independent of sample order", () => {
    const original = trainedModel();
    const samples = [
      sample("feedback-negative-b", "irrelevant", features({ staticScore: 0.85, exactScore: 0 }), "repo-b"),
      sample("feedback-positive-b", "useful", features({ staticScore: 0.25, exactScore: 1 }), "repo-b"),
      sample("feedback-negative-a", "irrelevant", features({ staticScore: 0.9, exactScore: 0 }), "repo-a"),
      sample("feedback-positive-a", "useful", features({ staticScore: 0.2, exactScore: 1 }), "repo-a"),
    ];
    const reordered = trainLearnedRankingModel(samples, { createdAt: 1_000, minimumSamples: 4 });

    expect(reordered).toEqual(original);
    expect(parseLearnedRankingModel(original)).toEqual(original);
    expect(original.training).toEqual({
      sampleCount: 4,
      positiveSamples: 2,
      negativeSamples: 2,
      repositoryCount: 2,
    });
  });

  it("keeps static order in shadow mode and records aggregate disagreement only", () => {
    const model = trainedModel();
    const result = rankCandidates([
      { id: "irrelevant", staticScore: 90, features: features({ staticScore: 0.9 }), value: "static" },
      { id: "relevant", staticScore: 20, features: features({ staticScore: 0.2, exactScore: 1 }), value: "learned" },
    ], { mode: "shadow", model, now: () => 0 });

    expect(result.ranked.map((item) => item.id)).toEqual(["irrelevant", "relevant"]);
    expect(result.diagnostics).toMatchObject({
      status: "shadow",
      topChanged: true,
      pairwiseDisagreements: 1,
    });
    expect(JSON.stringify(result.diagnostics)).not.toContain("irrelevant");
    expect(JSON.stringify(result.diagnostics)).not.toContain("relevant");
  });

  it("falls back to static ranking for unpromoted or corrupt active models", () => {
    const model = trainedModel();
    const candidates = [
      { id: "a", staticScore: 2, features: features({ exactScore: 0 }), value: "a" },
      { id: "b", staticScore: 1, features: features({ exactScore: 1 }), value: "b" },
    ];
    const unpromoted = rankCandidates(candidates, { mode: "active", model, now: () => 0 });
    const corrupt = { ...model, checksum: "0".repeat(64) };
    const invalid = rankCandidates(candidates, { mode: "active", model: corrupt, now: () => 0 });

    expect(unpromoted.ranked.map((item) => item.id)).toEqual(["a", "b"]);
    expect(unpromoted.diagnostics.fallbackReason).toContain("promotion gate");
    expect(invalid.ranked.map((item) => item.id)).toEqual(["a", "b"]);
    expect(invalid.diagnostics.fallbackReason).toContain("corrupt or incompatible");
  });

  it("promotes only a deterministic held-out improvement and enables active order", () => {
    const model = trainedModel();
    const report = evaluateRankingPromotion(model, promotionFixtures(), {
      measuredP95LatencyMs: 2,
      latencyBudgetMs: 10,
    });
    const promoted = withRankingPromotion(model, report);
    const result = rankCandidates([
      { id: "irrelevant", staticScore: 90, features: features({ staticScore: 0.9 }), value: "static" },
      { id: "relevant", staticScore: 20, features: features({ staticScore: 0.2, exactScore: 1 }), value: "learned" },
    ], { mode: "active", model: promoted, now: () => 0 });

    expect(report).toMatchObject({
      heldOutRepositories: 2,
      exactIdentifierRecallDelta: 1,
      privacyViolationDelta: 0,
      atomicityFailureDelta: 0,
      overflowDelta: 0,
      deterministic: true,
      eligible: true,
    });
    expect(report.qualityScoreDelta).toBeGreaterThan(0);
    expect(result.ranked.map((item) => item.id)).toEqual(["relevant", "irrelevant"]);
    expect(result.diagnostics.status).toBe("active");

    const stricterRuntime = rankCandidates(result.ranked, {
      mode: "active",
      model: promoted,
      maxLatencyMs: 1,
      now: () => 0,
    });
    expect(stricterRuntime.ranked.map((item) => item.id)).toEqual(["irrelevant", "relevant"]);
    expect(stricterRuntime.diagnostics.fallbackReason).toContain("latency gate");
  });

  it("rejects promotion when latency or held-out coverage fails", () => {
    const model = trainedModel();
    const report = evaluateRankingPromotion(model, promotionFixtures().slice(0, 1), {
      measuredP95LatencyMs: 11,
      latencyBudgetMs: 10,
    });

    expect(report.eligible).toBe(false);
    expect(report.reasons).toEqual(expect.arrayContaining([
      "planner latency budget exceeded",
      "fewer than 2 held-out repositories",
    ]));
    expect(() => evaluateRankingPromotion(model, promotionFixtures(), {
      measuredP95LatencyMs: 1,
      latencyBudgetMs: 10,
      minimumHeldOutRepositories: 0,
    })).toThrow("must be a positive integer");
  });

  it("writes and reloads a private checksummed model artifact", () => {
    const directory = mkdtempSync(join(tmpdir(), "ds4-ranking-"));
    const path = join(directory, "nested", "ranking-model.json");
    const model = trainedModel();

    saveLearnedRankingModel(path, model);
    expect(loadLearnedRankingModel(path)).toEqual({ model });
    expect(readFileSync(path, "utf8")).toContain(model.checksum);

    const tampered = JSON.parse(readFileSync(path, "utf8")) as RankingFeedbackEntry & { checksum: string };
    tampered.checksum = "f".repeat(64);
    expect(parseLearnedRankingModel(tampered)).toBeUndefined();
    expect(parseLearnedRankingModel({ ...model, rawText: "must not be accepted" })).toBeUndefined();
  });
});
