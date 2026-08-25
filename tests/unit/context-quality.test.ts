import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  aggregateContextQuality,
  compareQualityStrategies,
  evaluateManifestQuality,
  evaluateQualityPlan,
  staticRankingStrategy,
  taskWeightedCandidateStrategy,
  type QualityReplayCorpus,
  type QualityReplayFixture,
} from "ds4-context-core/quality/context-quality";
import type { ContextManifest } from "ds4-context-core/manifest/context-manifest";
import { stableStringify } from "ds4-context-core/shared/stable-json";

function corpus(): QualityReplayCorpus {
  return JSON.parse(readFileSync("quality/corpus-v1.json", "utf8")) as QualityReplayCorpus;
}

function fixture(): QualityReplayFixture {
  return {
    schemaVersion: 1,
    corpusVersion: "test-corpus-v1",
    sampleId: "fixture:metrics",
    plannerVersion: "managed-v1",
    profileKey: "test/model",
    task: { taskId: "task:metrics", taskType: "test", queryTags: ["atomic"] },
    expectedEvidenceSourceIds: ["entry:expected", "entry:missing"],
    candidates: [
      {
        id: "candidate:current",
        kind: "current",
        tokens: 20,
        groupId: "group:current",
        sourceIds: ["entry:request"],
        staticScore: 1000,
        currentRequest: true,
      },
      {
        id: "candidate:call",
        kind: "retrieval",
        tokens: 30,
        groupId: "group:tool",
        sourceIds: ["entry:expected"],
        staticScore: 90,
      },
      {
        id: "candidate:result",
        kind: "retrieval",
        tokens: 40,
        groupId: "group:tool",
        sourceIds: ["entry:expected"],
        staticScore: 90,
      },
      {
        id: "candidate:irrelevant",
        kind: "recent",
        tokens: 10,
        groupId: "group:irrelevant",
        sourceIds: [],
        staticScore: 10,
      },
    ],
    totalBudgetTokens: 100,
    categoryBudgets: { retrieval: 80, recent: 10 },
    outcomeLabels: ["expected:test"],
  };
}

describe("context quality metrics", () => {
  it("replays the versioned corpus byte-stably and compares strategies", () => {
    const first = compareQualityStrategies(corpus(), [
      staticRankingStrategy(),
      taskWeightedCandidateStrategy(),
    ]);
    const second = compareQualityStrategies(corpus(), [
      staticRankingStrategy(),
      taskWeightedCandidateStrategy(),
    ]);

    expect(stableStringify(first)).toBe(stableStringify(second));
    expect(first.fixtureCount).toBe(4);
    expect(first.strategies[0]?.aggregate.labeledSampleCount).toBe(3);
    expect(first.deltasFromBaseline[0]?.qualityScore).toBeGreaterThan(0);
    expect(first.deltasFromBaseline[0]?.evidenceRecall).toBeGreaterThan(0);
    expect(first.deltasFromBaseline[0]?.irrelevantTokenRatio).toBeLessThan(0);
  });

  it("measures recall, irrelevant tokens, duplicates, provenance, current requests and atomicity", () => {
    const sample = evaluateQualityPlan(fixture(), "strategy:test", {
      selectedCandidateIds: ["candidate:call", "candidate:irrelevant"],
      selectionReasons: {
        "candidate:call": "selected-evidence",
        "candidate:irrelevant": "selected-recent",
      },
      dropReasons: {
        "candidate:current": "incorrect-drop",
        "candidate:result": "partial-atomic-drop",
      },
      fallback: false,
      overflow: false,
    }, 2.5);

    expect(sample.metrics.evidenceRecall).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(sample.metrics.irrelevantTokenRatio).toEqual({ numerator: 10, denominator: 40, rate: 0.25 });
    expect(sample.metrics.duplicateEvidence).toEqual({ duplicateReferences: 0, selectedReferences: 1 });
    expect(sample.metrics.provenanceCoverage).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(sample.metrics.currentRequestRetention).toEqual({ numerator: 0, denominator: 1, rate: 0 });
    expect(sample.metrics.atomicGroupValidity).toEqual({ numerator: 0, denominator: 1, rate: 0 });
    expect(sample.metrics.budgetUtilization).toMatchObject({
      retrieval: { limitTokens: 80, selectedTokens: 30, droppedTokens: 40 },
      recent: { limitTokens: 10, selectedTokens: 10, droppedTokens: 0 },
    });
    expect(sample.metrics.selectionReasons).toEqual({ "selected-evidence": 1, "selected-recent": 1 });
    expect(sample.timing).toEqual({ planningDurationMs: 2.5 });
  });

  it("keeps live samples metadata-only and leaves unlabeled recall explicit", () => {
    const sensitiveSource = "project:/private/customer/secret.ts#apiKey";
    const manifest: ContextManifest = {
      schemaVersion: 1,
      id: "manifest-sensitive",
      sessionId: "session-sensitive",
      provider: "test",
      model: "model",
      contextWindow: 1000,
      outputReserve: 100,
      hardInputLimit: 800,
      targetInputTokens: 700,
      estimatedInputTokens: 70,
      included: [{
        kind: "current",
        sourceId: sensitiveSource,
        role: "user",
        groupId: "group:0-0",
        tokens: 50,
        reason: "private prompt text must not survive",
      }],
      excluded: [{
        kind: "project",
        sourceId: sensitiveSource,
        tokens: 20,
        reason: "private project path must not survive",
      }],
      summaryIds: [],
      retrievedEventIds: [],
      projectSnippets: [],
      composition: { systemTokens: 0, toolTokens: 0, messageTokens: 50, messageCount: 1, toolCount: 0 },
      planning: {
        mode: "managed",
        originalMessageTokens: 70,
        originalMessageCount: 2,
        fixedTokens: 0,
        messageTargetTokens: 700,
        messageHardLimitTokens: 800,
        recentTailTokenLimit: 100,
        selectedGroupCount: 1,
        excludedGroupCount: 1,
        durationMs: 1,
      },
      policyVersion: "policy-v1",
      plannerVersion: "managed-v1",
      promptHash: "prompt-hash",
      createdAt: 1,
    };

    const sample = evaluateManifestQuality(manifest, { project: 100, recent: 100 });
    const serialized = JSON.stringify(sample);
    expect(sample.metrics.evidenceRecall).toEqual({ numerator: 0, denominator: 0, rate: null });
    expect(sample.metrics.currentRequestRetention.rate).toBe(1);
    expect(serialized).not.toContain("private/customer");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("private prompt text");
    expect(serialized).not.toContain("manifest-sensitive");
  });

  it("aggregates counts rather than averaging per-sample ratios", () => {
    const first = evaluateQualityPlan(fixture(), "strategy:test", {
      selectedCandidateIds: ["candidate:current", "candidate:call", "candidate:result"],
      selectionReasons: {},
      dropReasons: {},
      fallback: false,
      overflow: false,
    });
    const secondFixture = { ...fixture(), sampleId: "fixture:metrics-2", expectedEvidenceSourceIds: [] };
    const second = evaluateQualityPlan(secondFixture, "strategy:test", {
      selectedCandidateIds: ["candidate:current"],
      selectionReasons: {},
      dropReasons: {},
      fallback: false,
      overflow: false,
    });
    const aggregate = aggregateContextQuality([first, second]);

    expect(aggregate.sampleCount).toBe(2);
    expect(aggregate.labeledSampleCount).toBe(1);
    expect(aggregate.evidenceRecall).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(aggregate.strategyIds).toEqual(["strategy:test"]);
  });
});
