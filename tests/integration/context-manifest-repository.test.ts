import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextManifest } from "ds4-context-core/manifest/context-manifest";
import {
  MAX_RETAINED_CALIBRATION_SAMPLES_PER_PROFILE,
  MAX_RETAINED_CONTEXT_MANIFESTS,
  RETENTION_PRUNE_BATCH_BYTES,
} from "ds4-context-core/persistence/repositories/context-manifest-repository";
import { HARD_PERSISTED_MANIFEST_BYTES } from "ds4-context-core/manifest/context-manifest-storage";
import { ContextDatabase } from "ds4-context-core/persistence/sqlite";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function manifest(id = "manifest-1", createdAt = 123): ContextManifest {
  return {
    schemaVersion: 1,
    id,
    sessionId: "session-1",
    branchLeafId: "leaf-1",
    provider: "test",
    model: "model",
    contextWindow: 128_000,
    outputReserve: 16_000,
    hardInputLimit: 110_000,
    targetInputTokens: 89_600,
    estimatedInputTokens: 1_000,
    piReportedContextTokens: 900,
    included: [{ kind: "current", sourceId: "entry-1", role: "user", tokens: 100, reason: "exact" }],
    excluded: [],
    summaryIds: [],
    retrievedEventIds: [],
    projectSnippets: [],
    composition: { systemTokens: 200, toolTokens: 300, messageTokens: 500, messageCount: 1, toolCount: 1 },
    policyVersion: "1",
    plannerVersion: "observer-v1",
    promptHash: `hash-${id}`,
    createdAt,
  };
}

describe("ContextManifestRepository", () => {
  it("persists the latest manifest and calibrates it with actual provider input", () => {
    const directory = mkdtempSync(join(tmpdir(), "ds4-manifest-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "context.db");
    const database = ContextDatabase.open(path);
    database.upsertSession({ sessionId: "session-1", sessionFile: "", indexedAt: 1 });

    database.manifests.save(manifest());
    const beforeUsage = new DatabaseSync(path, { readOnly: true });
    const serializedBefore = (beforeUsage.prepare(
      "SELECT manifest_json FROM context_manifests WHERE manifest_id = 'manifest-1'",
    ).get() as { manifest_json: string }).manifest_json;
    beforeUsage.close();
    const initial = database.manifests.getLatest("session-1");
    expect(initial?.id).toBe("manifest-1");
    expect(initial?.actualInputTokens).toBeUndefined();

    const updated = database.manifests.recordProviderUsage("manifest-1", {
      inputTokens: 700,
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
    }, 456);
    expect(updated).toMatchObject({
      id: "manifest-1",
      actualInputTokens: 1_200,
      providerUsage: {
        inputTokens: 700,
        cacheReadTokens: 400,
        cacheWriteTokens: 100,
        totalInputTokens: 1_200,
        cacheReadShare: 0.333333,
        cacheWriteShare: 0.083333,
      },
    });
    const afterUsage = new DatabaseSync(path, { readOnly: true });
    const serializedAfter = (afterUsage.prepare(
      "SELECT manifest_json FROM context_manifests WHERE manifest_id = 'manifest-1'",
    ).get() as { manifest_json: string }).manifest_json;
    afterUsage.close();
    expect(serializedAfter).toBe(serializedBefore);

    database.manifests.recordProviderUsage("manifest-1", {
      inputTokens: 1_300,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }, 789);
    expect(database.manifests.listCalibrationSamples("test", "model", 10)).toEqual([{
      estimatedTokens: 1_000,
      actualInputTokens: 1_200,
      inputTokens: 700,
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
      createdAt: 456,
    }]);
    database.close();

    const raw = new DatabaseSync(path, { readOnly: true });
    const calibration = raw.prepare(`
      SELECT estimated, actual, ratio, estimator_version, input_tokens,
        cache_read_tokens, cache_write_tokens
      FROM token_calibration WHERE provider = 'test' AND model = 'model'
    `).all() as unknown as Array<Record<string, unknown>>;
    expect(calibration).toEqual([{
      estimated: 1_000,
      actual: 1_200,
      ratio: 1.2,
      estimator_version: "chars-v1",
      input_tokens: 700,
      cache_read_tokens: 400,
      cache_write_tokens: 100,
    }]);
    raw.close();
  });

  it("bounds global manifests and per-profile calibration without losing recent samples", () => {
    const directory = mkdtempSync(join(tmpdir(), "ds4-manifest-retention-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "context.db");
    const database = ContextDatabase.open(path);
    database.upsertSession({ sessionId: "session-1", sessionFile: "", indexedAt: 1 });

    const total = MAX_RETAINED_CALIBRATION_SAMPLES_PER_PROFILE + 5;
    for (let index = 0; index < total; index++) {
      const item = manifest(`manifest-${index}`, 1_000 + index);
      database.manifests.save(item);
      database.manifests.recordProviderUsage(item.id, {
        inputTokens: 1_000 + index,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }, 2_000 + index);
    }

    expect(database.manifests.get("manifest-0")).toBeUndefined();
    expect(database.manifests.getLatest("session-1")?.id).toBe(`manifest-${total - 1}`);
    const samples = database.manifests.listCalibrationSamples("test", "model", total);
    expect(samples).toHaveLength(MAX_RETAINED_CALIBRATION_SAMPLES_PER_PROFILE);
    expect(samples[0]?.createdAt).toBe(2_000 + total - 1);
    expect(samples.at(-1)?.createdAt).toBe(2_005);
    database.close();

    const raw = new DatabaseSync(path, { readOnly: true });
    expect(raw.prepare("SELECT count(*) AS count FROM context_manifests").get())
      .toMatchObject({ count: MAX_RETAINED_CONTEXT_MANIFESTS });
    expect(raw.prepare("SELECT count(*) AS count FROM token_calibration").get())
      .toMatchObject({ count: MAX_RETAINED_CALIBRATION_SAMPLES_PER_PROFILE });
    expect(raw.prepare("SELECT count(*) AS count FROM token_calibration WHERE manifest_id IS NULL").get())
      .toMatchObject({
        count: MAX_RETAINED_CALIBRATION_SAMPLES_PER_PROFILE - MAX_RETAINED_CONTEXT_MANIFESTS,
      });
    raw.close();
  });

  it("stores an explicit bounded rollup while keeping schema-v1 JSON parseable", () => {
    const directory = mkdtempSync(join(tmpdir(), "ds4-manifest-rollup-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "context.db");
    const database = ContextDatabase.open(path);
    database.upsertSession({ sessionId: "session-1", sessionFile: "", indexedAt: 1 });
    const large = manifest("manifest-large", 1);
    large.excluded = Array.from({ length: 600 }, (_, index) => ({
      kind: "history" as const,
      sourceId: `source-${index}`,
      tokens: 1,
      reason: "x".repeat(600),
    }));

    const outcome = database.manifests.save(large);
    expect(outcome).toMatchObject({ status: "stored", completeness: "excluded-rollup" });
    const stored = database.manifests.getStored(large.id);
    expect(stored?.inventory).toMatchObject({
      completeness: "excluded-rollup",
      included: { complete: true, retained: 1 },
      excluded: { total: 600, retained: 256, omitted: 344 },
    });
    expect(stored?.manifest.excluded).toHaveLength(256);
    expect(database.manifests.get(large.id)?.persistedInventory?.completeness).toBe("excluded-rollup");

    const raw = new DatabaseSync(path, { readOnly: true });
    const persisted = raw.prepare(`
      SELECT manifest_json, length(CAST(manifest_json AS BLOB)) AS bytes
      FROM context_manifests WHERE manifest_id = ?
    `).get(large.id) as { manifest_json: string; bytes: number };
    const schemaV1View = JSON.parse(persisted.manifest_json) as ContextManifest;
    expect(persisted.bytes).toBeLessThanOrEqual(HARD_PERSISTED_MANIFEST_BYTES);
    expect(schemaV1View.schemaVersion).toBe(1);
    expect(schemaV1View.excluded).toHaveLength(256);
    expect(schemaV1View.persistedInventory).toMatchObject({
      completeness: "excluded-rollup",
      excluded: { total: 600, retained: 256 },
    });
    raw.close();
    database.close();
  });

  it("skips an irreducible oversize row and isolates estimator profiles", () => {
    const directory = mkdtempSync(join(tmpdir(), "ds4-manifest-oversize-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "context.db");
    const database = ContextDatabase.open(path);
    database.upsertSession({ sessionId: "session-1", sessionFile: "", indexedAt: 1 });

    const oversize = manifest("oversize", 1);
    oversize.included[0] = {
      ...oversize.included[0]!,
      reason: "x".repeat(HARD_PERSISTED_MANIFEST_BYTES + 1),
    };
    expect(database.manifests.save(oversize)).toMatchObject({ status: "skipped-oversize" });
    expect(database.manifests.get(oversize.id)).toBeUndefined();

    const profiled = manifest("profiled", 2);
    database.manifests.save(profiled);
    database.manifests.recordProviderUsage(profiled.id, {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }, 3, "estimator-v2");
    expect(database.manifests.listCalibrationSamples("test", "model", 10, "estimator-v2")).toEqual([]);
    database.manifests.recordProviderUsage(profiled.id, {
      inputTokens: 1_100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }, 4, "estimator-v2");
    expect(database.manifests.listCalibrationSamples("test", "model", 10, "chars-v1")).toEqual([]);
    expect(database.manifests.listCalibrationSamples("test", "model", 10, "estimator-v2"))
      .toHaveLength(1);
    database.close();
  });

  it("allows one individually oversized oldest row so online retention always progresses", () => {
    const directory = mkdtempSync(join(tmpdir(), "ds4-manifest-oversized-prune-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "context.db");
    const database = ContextDatabase.open(path);
    database.upsertSession({ sessionId: "session-1", sessionFile: "", indexedAt: 1 });
    database.close();

    const raw = new DatabaseSync(path);
    const insert = raw.prepare(`
      INSERT INTO context_manifests(
        manifest_id, session_id, created_at, provider, model,
        estimated_tokens, manifest_json, policy_version, planner_version
      ) VALUES (?, 'session-1', ?, 'test', 'model', 1, ?, 'policy', 'planner')
    `);
    insert.run("oversized-oldest", 0, JSON.stringify({
      id: "oversized-oldest",
      padding: "x".repeat(RETENTION_PRUNE_BATCH_BYTES + 1),
    }));
    for (let index = 1; index <= 128; index++) {
      insert.run(`legacy-${index}`, index, JSON.stringify({ id: `legacy-${index}` }));
    }
    raw.close();

    const reopened = ContextDatabase.open(path);
    const result = reopened.manifests.save(manifest("newest", 10_000));
    expect(result).toMatchObject({ status: "stored", prunedManifests: 1 });
    if (result.status === "stored") {
      expect(result.prunedBytes).toBeGreaterThan(RETENTION_PRUNE_BATCH_BYTES);
    }
    expect(reopened.manifests.get("oversized-oldest")).toBeUndefined();
    reopened.close();
  });

  it("bounds one online retention transaction by rows and serialized bytes", () => {
    const directory = mkdtempSync(join(tmpdir(), "ds4-manifest-byte-retention-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "context.db");
    const database = ContextDatabase.open(path);
    database.upsertSession({ sessionId: "session-1", sessionFile: "", indexedAt: 1 });
    database.close();

    const raw = new DatabaseSync(path);
    const insert = raw.prepare(`
      INSERT INTO context_manifests(
        manifest_id, session_id, created_at, provider, model,
        estimated_tokens, manifest_json, policy_version, planner_version
      ) VALUES (?, 'session-1', ?, 'test', 'model', 1, ?, 'policy', 'planner')
    `);
    for (let index = 0; index < 148; index++) {
      const payload = index < 12
        ? JSON.stringify({ id: `legacy-${index}`, padding: "x".repeat(900_000) })
        : JSON.stringify({ id: `legacy-${index}` });
      insert.run(`legacy-${index}`, index, payload);
    }
    raw.close();

    const reopened = ContextDatabase.open(path);
    const result = reopened.manifests.save(manifest("newest", 10_000));
    expect(result.status).toBe("stored");
    if (result.status === "stored") {
      expect(result.prunedManifests).toBeGreaterThan(0);
      expect(result.prunedManifests).toBeLessThan(12);
      expect(result.prunedBytes).toBeLessThanOrEqual(RETENTION_PRUNE_BATCH_BYTES);
    }
    reopened.close();
  });
});
