import type { DatabaseSync } from "node:sqlite";
import type { ContextManifest } from "../../manifest/context-manifest.ts";

interface ManifestRow {
  manifest_json: string;
  actual_tokens: number | null;
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
        hard_input_limit, target_input_tokens, pi_reported_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(manifest_id) DO UPDATE SET
        estimated_tokens = excluded.estimated_tokens,
        actual_tokens = excluded.actual_tokens,
        manifest_json = excluded.manifest_json,
        prompt_hash = excluded.prompt_hash,
        pi_reported_tokens = excluded.pi_reported_tokens
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

  recordActualInput(manifestId: string, actualInputTokens: number, createdAt: number): ContextManifest | undefined {
    if (!Number.isSafeInteger(actualInputTokens) || actualInputTokens <= 0) return this.get(manifestId);

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

      const updated: ContextManifest = { ...manifest, actualInputTokens };
      this.database.prepare(`
        UPDATE context_manifests
        SET actual_tokens = ?, manifest_json = ?
        WHERE manifest_id = ?
      `).run(actualInputTokens, JSON.stringify(updated), manifestId);

      if (manifest.estimatedInputTokens > 0) {
        this.database.prepare(`
          INSERT INTO token_calibration(
            provider, model, estimated, actual, ratio, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          manifest.provider,
          manifest.model,
          manifest.estimatedInputTokens,
          actualInputTokens,
          actualInputTokens / manifest.estimatedInputTokens,
          createdAt,
        );
      }

      this.database.exec("COMMIT");
      return updated;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function parseManifest(value: string): ContextManifest {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || !("id" in parsed) || typeof parsed.id !== "string") {
    throw new Error("Stored Context Manifest is invalid");
  }
  return parsed as ContextManifest;
}
