import { readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateQualityPlan,
  staticRankingStrategy,
  type QualityReplayCorpus,
} from "ds4-context-core/quality/context-quality";
import { ContextDatabase } from "ds4-context-core/persistence/sqlite";
import { stableStringify } from "ds4-context-core/shared/stable-json";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "ds4-quality-repository-"));
  temporaryDirectories.push(directory);
  return join(directory, "context.db");
}

function replaySample(index = 0) {
  const corpus = JSON.parse(readFileSync("quality/corpus-v1.json", "utf8")) as QualityReplayCorpus;
  const fixture = corpus.fixtures[index];
  if (!fixture) throw new Error("Missing quality fixture");
  const strategy = staticRankingStrategy();
  return evaluateQualityPlan(fixture, strategy.id, strategy.plan(fixture), 1.25 + index);
}

describe("ContextQualityRepository", () => {
  it("rebuilds byte-stable aggregates from versioned replay inputs", () => {
    const path = temporaryDatabase();
    const first = ContextDatabase.open(path, { now: 1 });
    for (let index = 0; index < 4; index++) {
      expect(first.quality.save(replaySample(index), 100 + index, 100)).toBe(true);
    }
    const firstAggregate = stableStringify(first.quality.aggregate().aggregate);
    first.close();

    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });

    const rebuilt = ContextDatabase.open(path, { now: 2 });
    for (let index = 0; index < 4; index++) rebuilt.quality.save(replaySample(index), 200 + index, 100);
    const rebuiltAggregate = stableStringify(rebuilt.quality.aggregate().aggregate);

    expect(rebuiltAggregate).toBe(firstAggregate);
    expect(rebuilt.quality.aggregate()).toMatchObject({
      ignoredSamples: 0,
      aggregate: { sampleCount: 4, labeledSampleCount: 3 },
      timing: { timedSamples: 4 },
    });
    rebuilt.close();
  });

  it("ignores corrupt or incomplete rows and bounds retained samples", () => {
    const path = temporaryDatabase();
    const database = ContextDatabase.open(path, { now: 1 });
    for (let index = 0; index < 4; index++) database.quality.save(replaySample(index), 100 + index, 2);
    database.close();

    const raw = new DatabaseSync(path);
    raw.prepare(`
      INSERT INTO context_quality_samples(
        sample_id, strategy_id, corpus_version, planner_version,
        profile_key, recorded_at, planning_duration_ms, sample_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("corrupt-json", "strategy", "corpus", "planner", "profile", 200, null, "{not json");
    raw.prepare(`
      INSERT INTO context_quality_samples(
        sample_id, strategy_id, corpus_version, planner_version,
        profile_key, recorded_at, planning_duration_ms, sample_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("incomplete", "strategy", "corpus", "planner", "profile", 201, null, "{\"schemaVersion\":1}");
    raw.close();

    const reopened = ContextDatabase.open(path, { now: 2 });
    const stored = reopened.quality.aggregate();
    expect(stored.samples).toHaveLength(2);
    expect(stored.ignoredSamples).toBe(2);
    expect(stored.aggregate.sampleCount).toBe(2);
    reopened.close();
  });
});
