import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  createRankingFeatures,
  createRankingFeedback,
  RANKING_FEEDBACK_CUSTOM_ENTRY_TYPE,
} from "ds4-context-core/ranking/learned-ranker";
import { projectRankingLabels } from "../../src/pi-adapter/ranking-adapter.ts";

function custom(id: string, data: unknown): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-08-26T00:00:00.000Z",
    customType: RANKING_FEEDBACK_CUSTOM_ENTRY_TYPE,
    data,
  };
}

function feedback(id: string, createdAt: number) {
  return createRankingFeedback({
    feedbackId: id,
    createdAt,
    repositoryIdentity: "/project",
    candidateKey: `retrieval:${id}`,
    label: id.includes("positive") ? "useful" : "irrelevant",
    classification: "internal",
    features: createRankingFeatures({
      sourceKind: "retrieval",
      staticScore: 0.5,
      classificationEligible: 1,
    }),
  });
}

describe("ranking custom-entry adapter", () => {
  it("replays bounded valid labels and diagnoses malformed and duplicate entries", () => {
    const first = feedback("positive-1", 1);
    const second = feedback("negative-2", 2);
    const third = feedback("positive-3", 3);
    const projection = projectRankingLabels([
      custom("entry-1", first),
      custom("entry-duplicate", first),
      custom("entry-malformed", { schemaVersion: 1, label: "useful", rawText: "must not train" }),
      custom("entry-2", second),
      custom("entry-3", third),
    ], 2);

    expect(projection.entries.map((entry) => entry.feedbackId)).toEqual(["negative-2", "positive-3"]);
    expect(projection.samples.map((sample) => sample.sampleId)).toEqual(["negative-2", "positive-3"]);
    expect(projection.malformedEntries).toBe(1);
    expect(projection.duplicateEntries).toBe(1);
    expect(projection.warnings.join("\n")).not.toContain("must not train");
  });
});
