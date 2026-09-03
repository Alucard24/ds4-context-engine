import type { DatabaseSync } from "node:sqlite";
import type { TokenCalibrationSample } from "../../core/model-awareness.ts";
import type {
  ContextManifest,
  ProviderUsageManifest,
} from "../../manifest/context-manifest.ts";
import {
  buildPersistedManifestProjection,
  storedManifestInventory,
  utf8ByteLength,
  type ManifestSaveResult,
  type StoredContextManifest,
} from "../../manifest/context-manifest-storage.ts";
import { SqliteWriteCoordinator } from "../write-coordinator.ts";

interface ManifestRow {
  manifest_json: string;
  actual_tokens: number | null;
  input_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
}

interface ProviderUsageRow {
  provider: string;
  model: string;
  estimated_tokens: number | null;
  actual_tokens: number | null;
}

interface CalibrationRow {
  estimated: number;
  actual: number;
  input_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  created_at: number;
}

interface CountRow {
  count: number;
}

interface StaleManifestRow {
  manifest_id: string;
  serialized_bytes: number;
}

interface CalibrationIdRow {
  calibration_id: number;
}

interface RetainedManifestRow {
  manifest_id: string;
  manifest_json: string;
}

export const MAX_RETAINED_CONTEXT_MANIFESTS = 128;
export const MAX_RETAINED_CALIBRATION_SAMPLES_PER_PROFILE = 200;
export const RETENTION_PRUNE_BATCH_ROWS = 32;
export const RETENTION_PRUNE_BATCH_BYTES = 8 * 1024 * 1024;
export const CALIBRATION_PRUNE_BATCH_ROWS = 32;

export interface ProviderTokenUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ManifestMaintenanceResult {
  prunedManifests: number;
  prunedManifestBytes: number;
  prunedCalibrationSamples: number;
  rewrittenManifests: number;
  rolledUpManifests: number;
  skippedOversizeManifests: number;
}

function validTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validEstimatorVersion(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,79}$/iu.test(value);
}

function providerUsage(input: ProviderTokenUsage): ProviderUsageManifest {
  const totalInputTokens = input.inputTokens + input.cacheReadTokens + input.cacheWriteTokens;
  const rounded = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
  return {
    ...input,
    totalInputTokens,
    cacheReadShare: totalInputTokens > 0 ? rounded(input.cacheReadTokens / totalInputTokens) : 0,
    cacheWriteShare: totalInputTokens > 0 ? rounded(input.cacheWriteTokens / totalInputTokens) : 0,
  };
}

function hydrateManifest(row: ManifestRow): ContextManifest {
  const manifest = parseManifest(row.manifest_json);
  if (row.actual_tokens === null) return manifest;
  const usage = providerUsage({
    inputTokens: row.input_tokens ?? row.actual_tokens,
    cacheReadTokens: row.cache_read_tokens ?? 0,
    cacheWriteTokens: row.cache_write_tokens ?? 0,
  });
  return {
    ...manifest,
    actualInputTokens: row.actual_tokens,
    providerUsage: usage,
  };
}

export class ContextManifestRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly writes = new SqliteWriteCoordinator(database),
  ) {}

  save(manifest: ContextManifest): ManifestSaveResult {
    const projection = buildPersistedManifestProjection(manifest);
    if (projection.status === "skipped-oversize") return projection;

    const pruned = this.writes.transaction("context-manifest-save", () => {
      this.database.prepare(`
        INSERT INTO context_manifests(
          manifest_id, session_id, created_at, provider, model,
          estimated_tokens, actual_tokens, manifest_json,
          prompt_hash, policy_version, planner_version,
          branch_leaf_id, context_window, output_reserve,
          hard_input_limit, target_input_tokens, pi_reported_tokens,
          input_tokens, cache_read_tokens, cache_write_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(manifest_id) DO UPDATE SET
          session_id = excluded.session_id,
          created_at = excluded.created_at,
          provider = excluded.provider,
          model = excluded.model,
          estimated_tokens = excluded.estimated_tokens,
          actual_tokens = COALESCE(excluded.actual_tokens, context_manifests.actual_tokens),
          manifest_json = excluded.manifest_json,
          prompt_hash = excluded.prompt_hash,
          policy_version = excluded.policy_version,
          planner_version = excluded.planner_version,
          branch_leaf_id = excluded.branch_leaf_id,
          context_window = excluded.context_window,
          output_reserve = excluded.output_reserve,
          hard_input_limit = excluded.hard_input_limit,
          target_input_tokens = excluded.target_input_tokens,
          pi_reported_tokens = excluded.pi_reported_tokens,
          input_tokens = COALESCE(excluded.input_tokens, context_manifests.input_tokens),
          cache_read_tokens = COALESCE(excluded.cache_read_tokens, context_manifests.cache_read_tokens),
          cache_write_tokens = COALESCE(excluded.cache_write_tokens, context_manifests.cache_write_tokens)
      `).run(
        projection.manifest.id,
        projection.manifest.sessionId,
        projection.manifest.createdAt,
        projection.manifest.provider,
        projection.manifest.model,
        projection.manifest.estimatedInputTokens,
        projection.manifest.actualInputTokens ?? null,
        projection.serialized,
        projection.manifest.promptHash,
        projection.manifest.policyVersion,
        projection.manifest.plannerVersion,
        projection.manifest.branchLeafId ?? null,
        projection.manifest.contextWindow,
        projection.manifest.outputReserve,
        projection.manifest.hardInputLimit,
        projection.manifest.targetInputTokens,
        projection.manifest.piReportedContextTokens ?? null,
        projection.manifest.providerUsage?.inputTokens ?? null,
        projection.manifest.providerUsage?.cacheReadTokens ?? null,
        projection.manifest.providerUsage?.cacheWriteTokens ?? null,
      );
      return this.pruneContextManifests();
    });

    return {
      status: "stored",
      completeness: projection.inventory.completeness,
      sourceBytes: projection.sourceBytes,
      storedBytes: projection.storedBytes,
      prunedManifests: pruned.rows,
      prunedBytes: pruned.bytes,
    };
  }

  get(manifestId: string): ContextManifest | undefined {
    return this.getStored(manifestId)?.manifest;
  }

  getStored(manifestId: string): StoredContextManifest | undefined {
    const row = this.database.prepare(`
      SELECT manifest_json, actual_tokens, input_tokens, cache_read_tokens, cache_write_tokens
      FROM context_manifests WHERE manifest_id = ?
    `).get(manifestId) as unknown as ManifestRow | undefined;
    return row ? storedManifest(row) : undefined;
  }

  getLatest(sessionId: string): ContextManifest | undefined {
    return this.getLatestStored(sessionId)?.manifest;
  }

  getLatestStored(sessionId: string): StoredContextManifest | undefined {
    const row = this.database.prepare(`
      SELECT manifest_json, actual_tokens, input_tokens, cache_read_tokens, cache_write_tokens
      FROM context_manifests
      WHERE session_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(sessionId) as unknown as ManifestRow | undefined;
    return row ? storedManifest(row) : undefined;
  }

  recordProviderUsage(
    manifestId: string,
    usage: ProviderTokenUsage,
    createdAt: number,
    estimatorVersion = "chars-v1",
  ): ContextManifest | undefined {
    if (!validTokenCount(usage.inputTokens)
      || !validTokenCount(usage.cacheReadTokens)
      || !validTokenCount(usage.cacheWriteTokens)
      || !Number.isSafeInteger(createdAt)
      || createdAt < 0
      || !validEstimatorVersion(estimatorVersion)) {
      return this.get(manifestId);
    }
    const recordedUsage = providerUsage(usage);
    if (recordedUsage.totalInputTokens <= 0) return this.get(manifestId);

    const outcome = this.writes.transaction("context-manifest-provider-usage", () => {
      const row = this.database.prepare(`
        SELECT provider, model, estimated_tokens, actual_tokens
        FROM context_manifests
        WHERE manifest_id = ?
      `).get(manifestId) as unknown as ProviderUsageRow | undefined;
      if (!row) return "missing" as const;
      if (row.actual_tokens !== null) return "already-recorded" as const;

      this.database.prepare(`
        UPDATE context_manifests
        SET actual_tokens = ?, input_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?
        WHERE manifest_id = ? AND actual_tokens IS NULL
      `).run(
        recordedUsage.totalInputTokens,
        recordedUsage.inputTokens,
        recordedUsage.cacheReadTokens,
        recordedUsage.cacheWriteTokens,
        manifestId,
      );

      if (row.estimated_tokens !== null && row.estimated_tokens > 0) {
        this.database.prepare(`
          INSERT INTO token_calibration(
            provider, model, estimated, actual, ratio, created_at,
            manifest_id, estimator_version, input_tokens, cache_read_tokens, cache_write_tokens
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          row.provider,
          row.model,
          row.estimated_tokens,
          recordedUsage.totalInputTokens,
          recordedUsage.totalInputTokens / row.estimated_tokens,
          createdAt,
          manifestId,
          estimatorVersion,
          recordedUsage.inputTokens,
          recordedUsage.cacheReadTokens,
          recordedUsage.cacheWriteTokens,
        );
        this.pruneCalibrationSamples(row.provider, row.model, estimatorVersion);
      }

      return "recorded" as const;
    });

    return outcome === "missing" ? undefined : this.get(manifestId);
  }

  recordActualInput(
    manifestId: string,
    actualInputTokens: number,
    createdAt: number,
    estimatorVersion = "chars-v1",
  ): ContextManifest | undefined {
    return this.recordProviderUsage(manifestId, {
      inputTokens: actualInputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }, createdAt, estimatorVersion);
  }

  /** Applies unbounded retention only to an explicitly selected offline working copy. */
  applyMaintenanceRetention(): ManifestMaintenanceResult {
    return this.writes.transaction("context-manifest-maintenance-prune", () => {
      const stale = this.database.prepare(`
        SELECT count(*) AS count,
          COALESCE(sum(length(CAST(manifest_json AS BLOB))), 0) AS bytes
        FROM context_manifests
        WHERE rowid NOT IN (
          SELECT rowid FROM context_manifests
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?
        )
      `).get(MAX_RETAINED_CONTEXT_MANIFESTS) as unknown as { count: number; bytes: number };

      this.database.prepare(`
        UPDATE token_calibration
        SET manifest_id = NULL
        WHERE manifest_id IN (
          SELECT manifest_id FROM context_manifests
          WHERE rowid NOT IN (
            SELECT rowid FROM context_manifests
            ORDER BY created_at DESC, rowid DESC
            LIMIT ?
          )
        )
      `).run(MAX_RETAINED_CONTEXT_MANIFESTS);
      this.database.prepare(`
        DELETE FROM context_manifests
        WHERE rowid NOT IN (
          SELECT rowid FROM context_manifests
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?
        )
      `).run(MAX_RETAINED_CONTEXT_MANIFESTS);

      const calibrationDelete = this.database.prepare(`
        DELETE FROM token_calibration
        WHERE calibration_id IN (
          SELECT calibration_id FROM (
            SELECT calibration_id,
              row_number() OVER (
                PARTITION BY provider, model, estimator_version
                ORDER BY created_at DESC, calibration_id DESC
              ) AS retention_rank
            FROM token_calibration
          ) WHERE retention_rank > ?
        )
      `).run(MAX_RETAINED_CALIBRATION_SAMPLES_PER_PROFILE);

      const retained = this.database.prepare(`
        SELECT manifest_id, manifest_json
        FROM context_manifests
        ORDER BY created_at DESC, rowid DESC
      `).all() as unknown as RetainedManifestRow[];
      const update = this.database.prepare(
        "UPDATE context_manifests SET manifest_json = ? WHERE manifest_id = ?",
      );
      const detach = this.database.prepare(
        "UPDATE token_calibration SET manifest_id = NULL WHERE manifest_id = ?",
      );
      const remove = this.database.prepare(
        "DELETE FROM context_manifests WHERE manifest_id = ?",
      );
      let rewrittenManifests = 0;
      let rolledUpManifests = 0;
      let skippedOversizeManifests = 0;

      for (const row of retained) {
        const projection = buildPersistedManifestProjection(parseManifest(row.manifest_json));
        if (projection.status === "skipped-oversize") {
          detach.run(row.manifest_id);
          remove.run(row.manifest_id);
          skippedOversizeManifests++;
          continue;
        }
        if (projection.serialized !== row.manifest_json) {
          update.run(projection.serialized, row.manifest_id);
          rewrittenManifests++;
        }
        if (projection.inventory.completeness === "excluded-rollup") rolledUpManifests++;
      }

      return {
        prunedManifests: stale.count,
        prunedManifestBytes: stale.bytes,
        prunedCalibrationSamples: Number(calibrationDelete.changes),
        rewrittenManifests,
        rolledUpManifests,
        skippedOversizeManifests,
      };
    });
  }

  listCalibrationSamples(
    provider: string,
    model: string,
    limit: number,
    estimatorVersion = "chars-v1",
  ): TokenCalibrationSample[] {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    const rows = this.database.prepare(`
      SELECT estimated, actual, input_tokens, cache_read_tokens, cache_write_tokens, created_at
      FROM token_calibration
      WHERE provider = ? AND model = ? AND estimator_version = ?
        AND estimated > 0 AND actual > 0
      ORDER BY created_at DESC, calibration_id DESC
      LIMIT ?
    `).all(provider, model, estimatorVersion, limit) as unknown as CalibrationRow[];
    return rows.map((row) => ({
      estimatedTokens: row.estimated,
      actualInputTokens: row.actual,
      inputTokens: row.input_tokens ?? row.actual,
      cacheReadTokens: row.cache_read_tokens ?? 0,
      cacheWriteTokens: row.cache_write_tokens ?? 0,
      createdAt: row.created_at,
    }));
  }

  private pruneContextManifests(): { rows: number; bytes: number } {
    const row = this.database.prepare(
      "SELECT count(*) AS count FROM context_manifests",
    ).get() as unknown as CountRow;
    const excess = Math.max(0, row.count - MAX_RETAINED_CONTEXT_MANIFESTS);
    if (excess === 0) return { rows: 0, bytes: 0 };

    const stale = this.database.prepare(`
      SELECT manifest_id, length(CAST(manifest_json AS BLOB)) AS serialized_bytes
      FROM context_manifests
      ORDER BY created_at ASC, rowid ASC
      LIMIT ?
    `).all(Math.min(RETENTION_PRUNE_BATCH_ROWS, excess)) as unknown as StaleManifestRow[];
    const selected: StaleManifestRow[] = [];
    let bytes = 0;
    for (const candidate of stale) {
      if (selected.length > 0 && bytes + candidate.serialized_bytes > RETENTION_PRUNE_BATCH_BYTES) break;
      selected.push(candidate);
      bytes += candidate.serialized_bytes;
    }
    if (selected.length === 0) return { rows: 0, bytes: 0 };

    const placeholders = selected.map(() => "?").join(", ");
    const manifestIds = selected.map((item) => item.manifest_id);
    this.database.prepare(`
      UPDATE token_calibration
      SET manifest_id = NULL
      WHERE manifest_id IN (${placeholders})
    `).run(...manifestIds);
    this.database.prepare(`
      DELETE FROM context_manifests
      WHERE manifest_id IN (${placeholders})
    `).run(...manifestIds);
    return { rows: selected.length, bytes };
  }

  private pruneCalibrationSamples(provider: string, model: string, estimatorVersion: string): void {
    const stale = this.database.prepare(`
      SELECT calibration_id FROM (
        SELECT calibration_id, created_at,
          row_number() OVER (
            ORDER BY created_at DESC, calibration_id DESC
          ) AS retention_rank
        FROM token_calibration
        WHERE provider = ? AND model = ? AND estimator_version = ?
      )
      WHERE retention_rank > ?
      ORDER BY created_at ASC, calibration_id ASC
      LIMIT ?
    `).all(
      provider,
      model,
      estimatorVersion,
      MAX_RETAINED_CALIBRATION_SAMPLES_PER_PROFILE,
      CALIBRATION_PRUNE_BATCH_ROWS,
    ) as unknown as CalibrationIdRow[];
    if (stale.length === 0) return;
    const placeholders = stale.map(() => "?").join(", ");
    this.database.prepare(`
      DELETE FROM token_calibration
      WHERE calibration_id IN (${placeholders})
    `).run(...stale.map((item) => item.calibration_id));
  }
}

function storedManifest(row: ManifestRow): StoredContextManifest {
  const manifest = hydrateManifest(row);
  return {
    manifest,
    inventory: storedManifestInventory(manifest, utf8ByteLength(row.manifest_json)),
  };
}

function parseManifest(value: string): ContextManifest {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || !("id" in parsed) || typeof parsed.id !== "string") {
    throw new Error("Stored Context Manifest is invalid");
  }
  return parsed as ContextManifest;
}
