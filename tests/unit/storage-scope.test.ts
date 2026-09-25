import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findConfigField } from "ds4-context-core/config/config-catalog";
import { createDefaultConfig } from "ds4-context-core/config/config";
import {
  resolveProjectDatabasePath,
  validateConfigFile,
} from "ds4-context-core/config/config-loader";
import type { ContextManifest } from "ds4-context-core/manifest/context-manifest";
import { ContextDatabase } from "ds4-context-core/persistence/sqlite";

const temporaryDirectories: string[] = [];
const openDatabases: ContextDatabase[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "ds4-storage-scope-"));
  temporaryDirectories.push(directory);
  return directory;
}

function open(path: string): ContextDatabase {
  const database = ContextDatabase.open(path);
  openDatabases.push(database);
  return database;
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function manifest(id: string, estimatedInputTokens: number): ContextManifest {
  return {
    schemaVersion: 1,
    id,
    sessionId: `session-${id}`,
    provider: "test-provider",
    model: "test-model",
    contextWindow: 128_000,
    outputReserve: 16_000,
    hardInputLimit: 110_000,
    targetInputTokens: 90_000,
    estimatedInputTokens,
    included: [{ kind: "current", sourceId: "included", tokens: 100, reason: "required" }],
    excluded: [],
    summaryIds: [],
    retrievedEventIds: [],
    projectSnippets: [],
    composition: { systemTokens: 10, toolTokens: 20, messageTokens: 970, messageCount: 1, toolCount: 1 },
    policyVersion: "policy-v1",
    plannerVersion: "planner-v1",
    promptHash: "prompt-hash",
    createdAt: 1,
  };
}

describe("storage.scope configuration", () => {
  it("defaults to per-project databases and documents the opt-out", () => {
    const config = createDefaultConfig();
    expect(config.storage.scope).toBe("project");
    expect(findConfigField("storage.scope")).toMatchObject({
      kind: "enum",
      values: ["agent", "project"],
    });
  });

  it("accepts agent and project and rejects unknown scopes", () => {
    expect(validateConfigFile({ storage: { scope: "agent" } }).config.storage.scope).toBe("agent");
    expect(validateConfigFile({ storage: { scope: "project" } }).config.storage.scope).toBe("project");
    expect(() => validateConfigFile({ storage: { scope: "session" } }))
      .toThrow("storage.scope must be agent or project");
  });
});

describe("resolveProjectDatabasePath", () => {
  it("derives a stable per-project path next to the agent database", () => {
    const agentPath = join(temporaryDirectory(), "ds4-context", "context.db");
    const first = resolveProjectDatabasePath(agentPath, "/home/user/projects/alpha");
    const second = resolveProjectDatabasePath(agentPath, "/home/user/projects/beta");
    expect(dirname(first)).toBe(join(dirname(agentPath), "projects"));
    expect(first).toMatch(/[0-9a-f]{32}\.db$/u);
    expect(first).toBe(resolveProjectDatabasePath(agentPath, "/home/user/projects/alpha"));
    expect(first).not.toBe(second);
    expect(first).not.toBe(agentPath);
  });
});

describe("storage.scope project split", () => {
  it("keeps calibration shared while manifests stay per project", () => {
    const directory = temporaryDirectory();
    const agentPath = join(directory, "ds4-context", "context.db");
    const alphaPath = resolveProjectDatabasePath(agentPath, "/home/user/projects/alpha");
    const betaPath = resolveProjectDatabasePath(agentPath, "/home/user/projects/beta");
    const agent = open(agentPath);
    const alpha = open(alphaPath);
    const beta = open(betaPath);

    const record = manifest("manifest-alpha", 1_000);
    alpha.upsertSession({ sessionId: record.sessionId, sessionFile: "", indexedAt: 1 });
    expect(alpha.manifests.save(record).status).toBe("stored");
    expect(beta.manifests.get(record.id)).toBeUndefined();

    // Manifest and calibration live in different files: the manifest database
    // records usage only, while the agent database stores the shared sample.
    expect(alpha.manifests.recordProviderUsage(
      record.id,
      { inputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      10,
      "chars-v1",
      { writeCalibration: false },
    )?.actualInputTokens).toBe(2_000);
    expect(alpha.calibrations.list("test-provider", "test-model", 10)).toEqual([]);

    const source = alpha.manifests.calibrationSource(record.id);
    expect(source).toEqual({
      provider: "test-provider",
      model: "test-model",
      estimatedTokens: 1_000,
    });
    expect(agent.calibrations.record({
      ...source!,
      actualInputTokens: 2_000,
      createdAt: 10,
      estimatorVersion: "chars-v1",
    })).toBe(true);

    for (const database of [alpha, beta]) {
      // Project databases never store calibration samples: the runtime reads
      // the shared agent database instead.
      expect(database.calibrations.list("test-provider", "test-model", 10)).toEqual([]);
    }
    const samples = agent.calibrations.list("test-provider", "test-model", 10);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      estimatedTokens: 1_000,
      actualInputTokens: 2_000,
      createdAt: 10,
    });
  });

  it("reports duplicate usage so one manifest yields at most one sample", () => {
    const directory = temporaryDirectory();
    const agentPath = join(directory, "ds4-context", "context.db");
    const alpha = open(resolveProjectDatabasePath(agentPath, "/home/user/projects/alpha"));
    const record = manifest("manifest-once", 1_000);
    alpha.upsertSession({ sessionId: record.sessionId, sessionFile: "", indexedAt: 1 });
    alpha.manifests.save(record);
    const usage = { inputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(alpha.manifests.recordProviderUsageOutcome(
      record.id,
      usage,
      10,
      "chars-v1",
      { writeCalibration: false },
    ).outcome).toBe("recorded");
    expect(alpha.manifests.recordProviderUsageOutcome(
      record.id,
      usage,
      11,
      "chars-v1",
      { writeCalibration: false },
    ).outcome).toBe("already-recorded");
  });
});
