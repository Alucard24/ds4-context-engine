import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextManifest } from "ds4-context-core/manifest/context-manifest";
import { databasePathFingerprint } from "ds4-context-core/persistence/database-client-lease";
import { ContextDatabase } from "ds4-context-core/persistence/sqlite";
import {
  compactStorage,
  inspectStorage,
  recoverStorage,
  storageMaintenancePaths,
} from "ds4-context-core/persistence/storage-maintenance";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function manifest(id: string, createdAt: number, large = false): ContextManifest {
  return {
    schemaVersion: 1,
    id,
    sessionId: "session",
    provider: "test",
    model: "model",
    contextWindow: 128_000,
    outputReserve: 16_000,
    hardInputLimit: 110_000,
    targetInputTokens: 90_000,
    estimatedInputTokens: 1_000,
    included: [{ kind: "current", sourceId: "entry", tokens: 1, reason: "required" }],
    excluded: large
      ? Array.from({ length: 600 }, (_, index) => ({
          kind: "history" as const,
          sourceId: `excluded-${index}`,
          tokens: 1,
          reason: "x".repeat(600),
        }))
      : [],
    summaryIds: [],
    retrievedEventIds: [],
    projectSnippets: [],
    composition: { systemTokens: 1, toolTokens: 1, messageTokens: 1, messageCount: 1, toolCount: 0 },
    policyVersion: "policy",
    plannerVersion: "planner",
    promptHash: `hash-${id}`,
    createdAt,
  };
}

function populatedDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "ds4-maintenance-' quoted-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "context.db");
  const database = ContextDatabase.open(path);
  database.upsertSession({ sessionId: "session", sessionFile: "session.jsonl", indexedAt: 1 });
  database.close();

  const raw = new DatabaseSync(path);
  const insertManifest = raw.prepare(`
    INSERT INTO context_manifests(
      manifest_id, session_id, created_at, provider, model,
      estimated_tokens, manifest_json, prompt_hash, policy_version, planner_version
    ) VALUES (?, 'session', ?, 'test', 'model', 1000, ?, ?, 'policy', 'planner')
  `);
  for (let index = 0; index < 140; index++) {
    const item = manifest(`manifest-${index}`, index, index === 139);
    insertManifest.run(item.id, item.createdAt, JSON.stringify(item), item.promptHash);
  }
  const insertCalibration = raw.prepare(`
    INSERT INTO token_calibration(
      provider, model, estimated, actual, ratio, created_at,
      estimator_version, input_tokens, cache_read_tokens, cache_write_tokens
    ) VALUES ('test', 'model', 1000, 1000, 1, ?, 'chars-v1', 1000, 0, 0)
  `);
  for (let index = 0; index < 205; index++) insertCalibration.run(index);
  raw.prepare(`
    INSERT INTO project_memory_source_exclusions(project_path, session_id, excluded_at, reason)
    VALUES ('/project', 'historical-session', 1, 'local policy')
  `).run();
  raw.close();
  return path;
}

function scalar(path: string, sql: string): number {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare(sql).get();
    return Number(Object.values(row ?? {})[0]);
  } finally {
    database.close();
  }
}

function writeMaintenanceState(
  path: string,
  phase: "candidate-validated" | "source-retired" | "candidate-installed" | "completed",
): void {
  const paths = storageMaintenancePaths(path);
  writeFileSync(paths.state, JSON.stringify({
    protocol: "ds4-context-storage-maintenance-state-v1",
    phase,
    databaseFingerprint: databasePathFingerprint(paths.source),
    source: paths.source,
    candidate: paths.candidate,
    backup: paths.backup,
    work: paths.work,
    retired: paths.retired,
  }));
}

describe("offline storage maintenance", { timeout: 60_000 }, () => {
  it("inspects, compacts a working copy, validates it, and keeps one standalone backup", { timeout: 60_000 }, async () => {
    const path = populatedDatabase();
    const inspection = inspectStorage(path);
    expect(inspection).toMatchObject({
      quickCheck: "ok",
      foreignKeyViolations: 0,
      schemaVersion: 15,
      manifestsToPrune: 12,
      calibrationToPrune: 5,
    });

    const result = await compactStorage(path, { availableBytes: Number.MAX_SAFE_INTEGER });
    expect(result.maintenance).toMatchObject({
      prunedManifests: 12,
      prunedCalibrationSamples: 5,
      rolledUpManifests: 1,
      skippedOversizeManifests: 0,
    });
    expect(existsSync(result.backupPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(result.backupPath).mode & 0o777).toBe(0o600);
    }
    expect(scalar(path, "SELECT count(*) FROM context_manifests")).toBe(128);
    expect(scalar(path, "SELECT count(*) FROM token_calibration")).toBe(200);
    expect(scalar(path, "SELECT count(*) FROM project_memory_source_exclusions")).toBe(1);
    expect(scalar(result.backupPath, "SELECT count(*) FROM context_manifests")).toBe(140);
    const verified = new DatabaseSync(path, { readOnly: true });
    expect(verified.prepare("PRAGMA quick_check").get()).toMatchObject({ quick_check: "ok" });
    verified.close();
    const paths = storageMaintenancePaths(path);
    expect(existsSync(paths.work)).toBe(false);
    expect(existsSync(paths.candidate)).toBe(false);
    expect(existsSync(paths.retired)).toBe(false);
    expect(existsSync(paths.state)).toBe(false);
    expect(existsSync(paths.maintenanceLock)).toBe(false);
    const reopened = ContextDatabase.open(path);
    expect(reopened.health()).toMatchObject({ ok: true, schemaVersion: 15 });
    reopened.close();
  });

  it("keeps CLI inspection metadata-only and refuses non-TTY mutation", () => {
    const path = populatedDatabase();
    const cli = join(process.cwd(), "scripts", "ds4-context-storage.mjs");
    const inspection = spawnSync(process.execPath, [cli, "inspect", "--database", path], {
      encoding: "utf8",
    });
    expect(inspection.status, inspection.stderr).toBe(0);
    const inspectionOutput = `${inspection.stdout}${inspection.stderr}`;
    expect(inspectionOutput).toContain("DS4 Context Storage Inspection");
    expect(inspectionOutput).toContain(path);
    expect(inspectionOutput).not.toContain("historical-session");
    expect(inspectionOutput).not.toContain("local policy");

    const before = readFileSync(path);
    const compact = spawnSync(process.execPath, [cli, "compact", "--database", path], {
      encoding: "utf8",
    });
    expect(compact.status).toBe(1);
    expect(`${compact.stdout}${compact.stderr}`).toContain("category=interactive-confirmation-required");
    expect(readFileSync(path)).toEqual(before);
    expect(existsSync(storageMaintenancePaths(path).backup)).toBe(false);
  });

  it("refuses insufficient disk space before creating a backup", async () => {
    const path = populatedDatabase();
    const sourceBefore = readFileSync(path);
    await expect(compactStorage(path, { availableBytes: 0 })).rejects.toMatchObject({
      category: "insufficient-disk-space",
      stage: "disk-preflight",
    });
    const paths = storageMaintenancePaths(path);
    expect(existsSync(paths.backup)).toBe(false);
    expect(readFileSync(path)).toEqual(sourceBefore);
    expect(scalar(path, "SELECT count(*) FROM context_manifests")).toBe(140);
  });

  it("refuses a pre-existing backup without overwriting it", async () => {
    const path = populatedDatabase();
    const paths = storageMaintenancePaths(path);
    writeFileSync(paths.backup, "existing-backup");
    await expect(compactStorage(path, { availableBytes: Number.MAX_SAFE_INTEGER })).rejects.toMatchObject({
      category: "stage-path-exists",
      stage: "path-preflight",
    });
    expect(readFileSync(paths.backup, "utf8")).toBe("existing-backup");
    expect(scalar(path, "SELECT count(*) FROM context_manifests")).toBe(140);
  });

  it("refuses a corrupt source without creating maintenance artifacts", async () => {
    const path = populatedDatabase();
    writeFileSync(path, "not-a-sqlite-database");
    await expect(compactStorage(path, { availableBytes: Number.MAX_SAFE_INTEGER })).rejects.toMatchObject({
      category: "database-validation-failed",
      stage: "database-validation",
    });
    const paths = storageMaintenancePaths(path);
    expect(readFileSync(path, "utf8")).toBe("not-a-sqlite-database");
    expect(existsSync(paths.backup)).toBe(false);
    expect(existsSync(paths.maintenanceLock)).toBe(false);
  });

  it("refuses a live cooperative database client with a categorical error", async () => {
    const path = populatedDatabase();
    const live = ContextDatabase.open(path, { clientId: "live-maintenance-test" });
    await expect(compactStorage(path, { availableBytes: Number.MAX_SAFE_INTEGER })).rejects.toMatchObject({
      category: "active-database-clients",
    });
    expect(scalar(path, "SELECT count(*) FROM context_manifests")).toBe(140);
    live.close();
  });

  it("rejects a candidate whose protected content changed without changing row counts", async () => {
    const path = populatedDatabase();
    const before = readFileSync(path);
    await expect(compactStorage(path, {
      availableBytes: Number.MAX_SAFE_INTEGER,
      onPhase: (phase) => {
        if (phase !== "before-candidate-validation") return;
        const candidate = new DatabaseSync(storageMaintenancePaths(path).candidate);
        candidate.prepare("UPDATE sessions SET session_file = 'tampered.jsonl'").run();
        candidate.close();
      },
    })).rejects.toMatchObject({
      category: "protected-digest-mismatch",
      stage: "candidate-validation",
    });
    expect(readFileSync(path)).toEqual(before);
    expect(scalar(path, "SELECT count(*) FROM sessions")).toBe(1);
    expect(existsSync(storageMaintenancePaths(path).candidate)).toBe(false);
  });

  it("clears an uninstalled candidate from the persisted candidate-validated phase", () => {
    const path = populatedDatabase();
    const paths = storageMaintenancePaths(path);
    copyFileSync(paths.source, paths.candidate);
    copyFileSync(paths.source, paths.work);
    writeMaintenanceState(path, "candidate-validated");

    expect(recoverStorage(path)).toEqual({ databasePath: paths.source, action: "staging-cleared" });
    expect(scalar(path, "SELECT count(*) FROM context_manifests")).toBe(140);
    expect(existsSync(paths.candidate)).toBe(false);
    expect(existsSync(paths.work)).toBe(false);
    expect(existsSync(paths.state)).toBe(false);
  });

  it("recovers deterministically from a persisted source-retired phase", () => {
    const path = populatedDatabase();
    const paths = storageMaintenancePaths(path);
    renameSync(paths.source, paths.retired);
    writeMaintenanceState(path, "source-retired");

    expect(recoverStorage(path)).toEqual({ databasePath: paths.source, action: "source-restored" });
    expect(scalar(path, "SELECT count(*) FROM context_manifests")).toBe(140);
    expect(existsSync(paths.retired)).toBe(false);
    expect(existsSync(paths.state)).toBe(false);
  });

  it.each(["candidate-installed", "completed"] as const)(
    "keeps a valid installed candidate from the persisted %s phase",
    (phase) => {
      const path = populatedDatabase();
      const paths = storageMaintenancePaths(path);
      renameSync(paths.source, paths.retired);
      copyFileSync(paths.retired, paths.source);
      writeMaintenanceState(path, phase);

      expect(recoverStorage(path)).toEqual({ databasePath: paths.source, action: "candidate-kept" });
      expect(scalar(path, "SELECT count(*) FROM context_manifests")).toBe(140);
      expect(existsSync(paths.retired)).toBe(false);
      expect(existsSync(paths.state)).toBe(false);
    },
  );

  it("restores the verified standalone backup when the retired source is unavailable", () => {
    const path = populatedDatabase();
    const paths = storageMaintenancePaths(path);
    copyFileSync(paths.source, paths.backup);
    unlinkSync(paths.source);
    writeMaintenanceState(path, "source-retired");

    expect(recoverStorage(path)).toEqual({ databasePath: paths.source, action: "source-restored" });
    expect(scalar(path, "SELECT count(*) FROM context_manifests")).toBe(140);
    expect(existsSync(paths.backup)).toBe(true);
  });

  it("fails closed when persisted maintenance paths do not match the selected database", () => {
    const path = populatedDatabase();
    const paths = storageMaintenancePaths(path);
    writeMaintenanceState(path, "candidate-validated");
    const state = JSON.parse(readFileSync(paths.state, "utf8")) as Record<string, unknown>;
    state.candidate = `${paths.candidate}.unexpected`;
    writeFileSync(paths.state, JSON.stringify(state));

    expect(() => recoverStorage(path)).toThrowError(expect.objectContaining({
      category: "maintenance-state-invalid",
      stage: "recover",
    }));
    expect(scalar(path, "SELECT count(*) FROM context_manifests")).toBe(140);
    expect(existsSync(paths.maintenanceLock)).toBe(false);
  });

  it("keeps the source byte-for-byte unchanged when fault injection stops before swap", async () => {
    const path = populatedDatabase();
    const before = readFileSync(path);
    await expect(compactStorage(path, {
      availableBytes: Number.MAX_SAFE_INTEGER,
      onPhase: (phase) => {
        if (phase === "before-source-rename") throw new Error("synthetic pre-swap fault");
      },
    })).rejects.toMatchObject({ category: "maintenance-failed" });
    expect(readFileSync(path)).toEqual(before);
    const paths = storageMaintenancePaths(path);
    expect(existsSync(paths.work)).toBe(false);
    expect(existsSync(paths.candidate)).toBe(false);
    expect(existsSync(paths.state)).toBe(false);
  });

  it.each(["source-retired", "candidate-installed", "before-final-validation"] as const)(
    "rolls back immediately when a fault occurs at %s",
    async (faultPhase) => {
      const path = populatedDatabase();
      await expect(compactStorage(path, {
        availableBytes: Number.MAX_SAFE_INTEGER,
        onPhase: (phase) => {
          if (phase === faultPhase) throw new Error("synthetic fault");
        },
      })).rejects.toMatchObject({ category: "maintenance-failed" });
      expect(scalar(path, "SELECT count(*) FROM context_manifests")).toBe(140);
      const paths = storageMaintenancePaths(path);
      expect(existsSync(paths.retired)).toBe(false);
      expect(existsSync(paths.candidate)).toBe(false);
      expect(existsSync(paths.state)).toBe(false);
      expect(existsSync(paths.maintenanceLock)).toBe(false);
    },
  );
});
