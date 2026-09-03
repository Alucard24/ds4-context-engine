import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { ArtifactStats } from "./repositories/artifact-repository.ts";
import {
  MAX_RETAINED_CALIBRATION_SAMPLES_PER_PROFILE,
  MAX_RETAINED_CONTEXT_MANIFESTS,
} from "./repositories/context-manifest-repository.ts";
import {
  HARD_PERSISTED_MANIFEST_BYTES,
  PREFERRED_PERSISTED_MANIFEST_BYTES,
} from "../manifest/context-manifest-storage.ts";

export const STORAGE_ALLOCATED_WARNING_BYTES = 1024 * 1024 * 1024;
export const STORAGE_MANIFEST_PAYLOAD_WARNING_BYTES = 128 * 1024 * 1024;
export const STORAGE_REUSABLE_WARNING_RATIO = 0.25;

export interface StorageDiagnostics {
  status: "ok" | "warning" | "unavailable";
  schemaVersion?: number;
  journalMode?: string;
  pageSize?: number;
  pageCount?: number;
  freePages?: number;
  allocatedBytes?: number;
  reusableBytes?: number;
  databaseBytes?: number;
  walBytes?: number;
  shmBytes?: number;
  manifests: {
    rows: number;
    serializedBytes: number;
    retainedLimit: number;
    preferredBytes: number;
    hardBytes: number;
    rolledUpRows: number;
  };
  calibration: {
    rows: number;
    profiles: number;
    retainedPerProfile: number;
  };
  sessions: number;
  activeProject?: {
    files: number;
    snippets: number;
    staleSnippets: number;
    indexedTokens: number;
  };
  artifacts: ArtifactStats;
  retention: {
    manifestExcess: number;
    calibrationExcess: number;
    converged: boolean;
  };
  maintenance: {
    recommended: boolean;
    reasons: string[];
  };
}

interface ScalarRow {
  value: number;
}

interface ManifestStatsRow {
  rows: number;
  serialized_bytes: number;
  rolled_up_rows: number;
}

interface CalibrationStatsRow {
  rows: number;
  profiles: number;
  excess: number;
}

interface ProjectStatsRow {
  files: number;
  snippets: number;
  stale_snippets: number;
  indexed_tokens: number;
}

function pragmaValue(database: DatabaseSync, pragma: string): string | number {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  if (!row || typeof row !== "object") throw new Error("Storage diagnostics unavailable");
  const value = Object.values(row)[0];
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("Storage diagnostics unavailable");
  }
  return value;
}

function fileBytes(path: string): number {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats.size : 0;
  } catch {
    return 0;
  }
}

function emptyArtifactStats(): ArtifactStats {
  return { objects: 0, references: 0, bytes: 0, missing: 0, corrupt: 0 };
}

export function unavailableStorageDiagnostics(): StorageDiagnostics {
  return {
    status: "unavailable",
    manifests: {
      rows: 0,
      serializedBytes: 0,
      retainedLimit: MAX_RETAINED_CONTEXT_MANIFESTS,
      preferredBytes: PREFERRED_PERSISTED_MANIFEST_BYTES,
      hardBytes: HARD_PERSISTED_MANIFEST_BYTES,
      rolledUpRows: 0,
    },
    calibration: {
      rows: 0,
      profiles: 0,
      retainedPerProfile: MAX_RETAINED_CALIBRATION_SAMPLES_PER_PROFILE,
    },
    sessions: 0,
    artifacts: emptyArtifactStats(),
    retention: { manifestExcess: 0, calibrationExcess: 0, converged: false },
    maintenance: { recommended: false, reasons: ["storage-diagnostics-unavailable"] },
  };
}

export function collectStorageDiagnostics(
  database: DatabaseSync,
  databasePath: string,
  activeProjectPath?: string,
): StorageDiagnostics {
  const pageSize = Number(pragmaValue(database, "page_size"));
  const pageCount = Number(pragmaValue(database, "page_count"));
  const freePages = Number(pragmaValue(database, "freelist_count"));
  const journalMode = String(pragmaValue(database, "journal_mode"));
  const schemaVersion = Number(pragmaValue(database, "user_version"));
  const allocatedBytes = pageSize * pageCount;
  const reusableBytes = pageSize * freePages;

  const manifests = database.prepare(`
    SELECT count(*) AS rows,
      COALESCE(sum(length(CAST(manifest_json AS BLOB))), 0) AS serialized_bytes,
      COALESCE((
        SELECT sum(CASE
          WHEN json_extract(recent.manifest_json, '$.persistedInventory.completeness') = 'excluded-rollup'
            THEN 1 ELSE 0 END)
        FROM (
          SELECT manifest_json FROM context_manifests
          ORDER BY created_at DESC, rowid DESC
          LIMIT ${MAX_RETAINED_CONTEXT_MANIFESTS}
        ) AS recent
      ), 0) AS rolled_up_rows
    FROM context_manifests
  `).get() as unknown as ManifestStatsRow;

  const calibration = database.prepare(`
    SELECT
      COALESCE(sum(profile_rows), 0) AS rows,
      count(*) AS profiles,
      COALESCE(sum(CASE WHEN profile_rows > ? THEN profile_rows - ? ELSE 0 END), 0) AS excess
    FROM (
      SELECT count(*) AS profile_rows
      FROM token_calibration
      GROUP BY provider, model, estimator_version
    )
  `).get(
    MAX_RETAINED_CALIBRATION_SAMPLES_PER_PROFILE,
    MAX_RETAINED_CALIBRATION_SAMPLES_PER_PROFILE,
  ) as unknown as CalibrationStatsRow;

  const sessions = (database.prepare(
    "SELECT count(*) AS value FROM sessions",
  ).get() as unknown as ScalarRow).value;

  const artifacts = database.prepare(`
    SELECT
      (SELECT count(*) FROM artifact_objects) AS objects,
      (SELECT count(*) FROM artifacts) AS refs,
      COALESCE((SELECT sum(size_bytes) FROM artifact_objects), 0) AS bytes,
      COALESCE((SELECT sum(status = 'missing') FROM artifact_objects), 0) AS missing,
      COALESCE((SELECT sum(status = 'corrupt') FROM artifact_objects), 0) AS corrupt
  `).get() as unknown as {
    objects: number;
    refs: number;
    bytes: number;
    missing: number;
    corrupt: number;
  };

  let activeProject: StorageDiagnostics["activeProject"];
  if (activeProjectPath) {
    const row = database.prepare(`
      SELECT
        (SELECT count(*) FROM project_files WHERE project_path = ? AND status = 'current') AS files,
        (SELECT count(*) FROM project_snippets WHERE project_path = ? AND stale = 0) AS snippets,
        (SELECT count(*) FROM project_snippets WHERE project_path = ? AND stale = 1) AS stale_snippets,
        (SELECT COALESCE(sum(token_estimate), 0) FROM project_snippets
          WHERE project_path = ? AND stale = 0) AS indexed_tokens
    `).get(
      activeProjectPath,
      activeProjectPath,
      activeProjectPath,
      activeProjectPath,
    ) as unknown as ProjectStatsRow;
    activeProject = {
      files: row.files,
      snippets: row.snippets,
      staleSnippets: row.stale_snippets,
      indexedTokens: row.indexed_tokens,
    };
  }

  const manifestExcess = Math.max(0, manifests.rows - MAX_RETAINED_CONTEXT_MANIFESTS);
  const calibrationExcess = Math.max(0, calibration.excess);
  const reasons = new Set<string>();
  if (manifestExcess > 0) reasons.add("manifest-retention-excess");
  if (calibrationExcess > 0) reasons.add("calibration-retention-excess");
  if (allocatedBytes >= STORAGE_ALLOCATED_WARNING_BYTES) reasons.add("database-high-water");
  if (allocatedBytes > 0 && reusableBytes / allocatedBytes >= STORAGE_REUSABLE_WARNING_RATIO) {
    reasons.add("reusable-space-high");
  }
  if (manifests.serialized_bytes > STORAGE_MANIFEST_PAYLOAD_WARNING_BYTES) {
    reasons.add("manifest-payload-high");
  }

  const maintenanceReasons = [...reasons];
  return {
    status: maintenanceReasons.length > 0 ? "warning" : "ok",
    schemaVersion,
    journalMode,
    pageSize,
    pageCount,
    freePages,
    allocatedBytes,
    reusableBytes,
    databaseBytes: databasePath === ":memory:" ? allocatedBytes : fileBytes(databasePath),
    walBytes: databasePath === ":memory:" ? 0 : fileBytes(`${databasePath}-wal`),
    shmBytes: databasePath === ":memory:" ? 0 : fileBytes(`${databasePath}-shm`),
    manifests: {
      rows: manifests.rows,
      serializedBytes: manifests.serialized_bytes,
      retainedLimit: MAX_RETAINED_CONTEXT_MANIFESTS,
      preferredBytes: PREFERRED_PERSISTED_MANIFEST_BYTES,
      hardBytes: HARD_PERSISTED_MANIFEST_BYTES,
      rolledUpRows: manifests.rolled_up_rows,
    },
    calibration: {
      rows: calibration.rows,
      profiles: calibration.profiles,
      retainedPerProfile: MAX_RETAINED_CALIBRATION_SAMPLES_PER_PROFILE,
    },
    sessions,
    ...(activeProject ? { activeProject } : {}),
    artifacts: {
      objects: artifacts.objects,
      references: artifacts.refs,
      bytes: artifacts.bytes,
      missing: artifacts.missing,
      corrupt: artifacts.corrupt,
    },
    retention: {
      manifestExcess,
      calibrationExcess,
      converged: manifestExcess === 0 && calibrationExcess === 0,
    },
    maintenance: {
      recommended: maintenanceReasons.length > 0,
      reasons: maintenanceReasons,
    },
  };
}
