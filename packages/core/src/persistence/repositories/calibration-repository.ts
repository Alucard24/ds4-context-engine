import type { DatabaseSync } from "node:sqlite";
import type { TokenCalibrationSample } from "../../core/model-awareness.ts";
import {
  CALIBRATION_PRUNE_BATCH_ROWS,
  MAX_RETAINED_CALIBRATION_SAMPLES_PER_PROFILE,
} from "./context-manifest-repository.ts";
import { SqliteWriteCoordinator } from "../write-coordinator.ts";

export interface CalibrationRecordInput {
  provider: string;
  model: string;
  estimatedTokens: number;
  actualInputTokens: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  createdAt: number;
  estimatorVersion: string;
  /**
   * Canonical manifest that produced the sample. Kept null when the manifest
   * lives in a different database (for example a per-project database).
   */
  manifestId?: string;
}

interface CalibrationRow {
  estimated: number;
  actual: number;
  input_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  created_at: number;
}

interface CalibrationIdRow {
  calibration_id: number;
}

/**
 * Token calibration samples are global learning: they are keyed by
 * provider/model/estimator and are shared across projects. With
 * `storage.scope: "project"` this repository is the only writer/reader in the
 * agent database, while manifests stay in the per-project database.
 */
export class CalibrationRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly writes = new SqliteWriteCoordinator(database),
  ) {}

  record(input: CalibrationRecordInput): boolean {
    if (!Number.isFinite(input.estimatedTokens) || input.estimatedTokens <= 0) return false;
    if (!Number.isFinite(input.actualInputTokens) || input.actualInputTokens <= 0) return false;

    this.writes.transaction("token-calibration-record", () => {
      this.database.prepare(`
        INSERT INTO token_calibration(
          provider, model, estimated, actual, ratio, created_at,
          manifest_id, estimator_version, input_tokens, cache_read_tokens, cache_write_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.provider,
        input.model,
        input.estimatedTokens,
        input.actualInputTokens,
        input.actualInputTokens / input.estimatedTokens,
        input.createdAt,
        input.manifestId ?? null,
        input.estimatorVersion,
        input.inputTokens ?? null,
        input.cacheReadTokens ?? null,
        input.cacheWriteTokens ?? null,
      );
      this.prune(input.provider, input.model, input.estimatorVersion);
    });
    return true;
  }

  list(
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

  private prune(provider: string, model: string, estimatorVersion: string): void {
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
