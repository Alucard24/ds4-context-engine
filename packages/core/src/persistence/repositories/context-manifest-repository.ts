import type { DatabaseSync } from "node:sqlite";
import type { TokenCalibrationSample } from "../../core/model-awareness.ts";
import type {
  ContextManifest,
  ProviderUsageManifest,
} from "../../manifest/context-manifest.ts";

interface ManifestRow {
  manifest_json: string;
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

export interface ProviderTokenUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

function validTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
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

export class ContextManifestRepository {
  constructor(private readonly database: DatabaseSync) {}

  save(manifest: ContextManifest): void {
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
        estimated_tokens = excluded.estimated_tokens,
        actual_tokens = excluded.actual_tokens,
        manifest_json = excluded.manifest_json,
        prompt_hash = excluded.prompt_hash,
        pi_reported_tokens = excluded.pi_reported_tokens,
        input_tokens = excluded.input_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens
    `).run(
      manifest.id,
      manifest.sessionId,
      manifest.createdAt,
      manifest.provider,
      manifest.model,
      manifest.estimatedInputTokens,
      manifest.actualInputTokens ?? null,
      JSON.stringify(manifest),
      manifest.promptHash,
      manifest.policyVersion,
      manifest.plannerVersion,
      manifest.branchLeafId ?? null,
      manifest.contextWindow,
      manifest.outputReserve,
      manifest.hardInputLimit,
      manifest.targetInputTokens,
      manifest.piReportedContextTokens ?? null,
      manifest.providerUsage?.inputTokens ?? null,
      manifest.providerUsage?.cacheReadTokens ?? null,
      manifest.providerUsage?.cacheWriteTokens ?? null,
    );
  }

  get(manifestId: string): ContextManifest | undefined {
    const row = this.database.prepare(
      "SELECT manifest_json, actual_tokens FROM context_manifests WHERE manifest_id = ?",
    ).get(manifestId) as unknown as ManifestRow | undefined;
    return row ? parseManifest(row.manifest_json) : undefined;
  }

  getLatest(sessionId: string): ContextManifest | undefined {
    const row = this.database.prepare(`
      SELECT manifest_json, actual_tokens
      FROM context_manifests
      WHERE session_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(sessionId) as unknown as ManifestRow | undefined;
    return row ? parseManifest(row.manifest_json) : undefined;
  }

  recordProviderUsage(
    manifestId: string,
    usage: ProviderTokenUsage,
    createdAt: number,
  ): ContextManifest | undefined {
    if (!validTokenCount(usage.inputTokens)
      || !validTokenCount(usage.cacheReadTokens)
      || !validTokenCount(usage.cacheWriteTokens)
      || !Number.isSafeInteger(createdAt)
      || createdAt < 0) {
      return this.get(manifestId);
    }
    const recordedUsage = providerUsage(usage);
    if (recordedUsage.totalInputTokens <= 0) return this.get(manifestId);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT manifest_json, actual_tokens
        FROM context_manifests
        WHERE manifest_id = ?
      `).get(manifestId) as unknown as ManifestRow | undefined;
      if (!row) {
        this.database.exec("COMMIT");
        return undefined;
      }

      const manifest = parseManifest(row.manifest_json);
      if (row.actual_tokens !== null) {
        this.database.exec("COMMIT");
        return manifest;
      }

      const updated: ContextManifest = {
        ...manifest,
        actualInputTokens: recordedUsage.totalInputTokens,
        providerUsage: recordedUsage,
      };
      this.database.prepare(`
        UPDATE context_manifests
        SET actual_tokens = ?, input_tokens = ?, cache_read_tokens = ?,
          cache_write_tokens = ?, manifest_json = ?
        WHERE manifest_id = ?
      `).run(
        recordedUsage.totalInputTokens,
        recordedUsage.inputTokens,
        recordedUsage.cacheReadTokens,
        recordedUsage.cacheWriteTokens,
        JSON.stringify(updated),
        manifestId,
      );

      if (manifest.estimatedInputTokens > 0) {
        this.database.prepare(`
          INSERT INTO token_calibration(
            provider, model, estimated, actual, ratio, created_at,
            manifest_id, estimator_version, input_tokens, cache_read_tokens, cache_write_tokens
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          manifest.provider,
          manifest.model,
          manifest.estimatedInputTokens,
          recordedUsage.totalInputTokens,
          recordedUsage.totalInputTokens / manifest.estimatedInputTokens,
          createdAt,
          manifestId,
          manifest.modelAwareness?.calibration.estimator ?? "chars-v1",
          recordedUsage.inputTokens,
          recordedUsage.cacheReadTokens,
          recordedUsage.cacheWriteTokens,
        );
      }

      this.database.exec("COMMIT");
      return updated;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recordActualInput(manifestId: string, actualInputTokens: number, createdAt: number): ContextManifest | undefined {
    return this.recordProviderUsage(manifestId, {
      inputTokens: actualInputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }, createdAt);
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
}

function parseManifest(value: string): ContextManifest {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || !("id" in parsed) || typeof parsed.id !== "string") {
    throw new Error("Stored Context Manifest is invalid");
  }
  return parsed as ContextManifest;
}
