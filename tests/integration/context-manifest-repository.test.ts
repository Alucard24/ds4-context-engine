import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextManifest } from "ds4-context-core/manifest/context-manifest";
import { ContextDatabase } from "ds4-context-core/persistence/sqlite";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function manifest(): ContextManifest {
  return {
    schemaVersion: 1,
    id: "manifest-1",
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
    promptHash: "abc",
    createdAt: 123,
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
});
