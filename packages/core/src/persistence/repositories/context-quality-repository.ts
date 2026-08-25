import type { DatabaseSync } from "node:sqlite";
import { SqliteWriteCoordinator } from "../write-coordinator.ts";
import {
  aggregateContextQuality,
  isContextQualitySample,
  qualityTiming,
  type ContextQualityAggregate,
  type ContextQualitySample,
} from "../../quality/context-quality.ts";

interface QualitySampleRow {
  sample_json: string;
}

export interface StoredContextQualitySamples {
  samples: ContextQualitySample[];
  ignoredSamples: number;
}

export interface StoredContextQualityAggregate extends StoredContextQualitySamples {
  aggregate: ContextQualityAggregate;
  timing: ReturnType<typeof qualityTiming>;
}

function parseSample(value: string): ContextQualitySample | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isContextQualitySample(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export class ContextQualityRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly writes = new SqliteWriteCoordinator(database),
  ) {}

  save(sample: ContextQualitySample, recordedAt: number, maxSamples: number): boolean {
    if (!isContextQualitySample(sample)
      || !Number.isSafeInteger(recordedAt)
      || recordedAt < 0
      || !Number.isSafeInteger(maxSamples)
      || maxSamples <= 0) return false;
    return this.writes.transaction("context-quality-save", () => {
      this.database.prepare(`
        INSERT INTO context_quality_samples(
          sample_id, strategy_id, corpus_version, planner_version,
          profile_key, recorded_at, planning_duration_ms, sample_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sample_id, strategy_id) DO UPDATE SET
          corpus_version = excluded.corpus_version,
          planner_version = excluded.planner_version,
          profile_key = excluded.profile_key,
          recorded_at = excluded.recorded_at,
          planning_duration_ms = excluded.planning_duration_ms,
          sample_json = excluded.sample_json
      `).run(
        sample.sampleId,
        sample.strategyId,
        sample.corpusVersion,
        sample.plannerVersion,
        sample.profileKey,
        recordedAt,
        sample.timing?.planningDurationMs ?? null,
        JSON.stringify(sample),
      );
      this.database.prepare(`
        DELETE FROM context_quality_samples
        WHERE (sample_id, strategy_id) IN (
          SELECT sample_id, strategy_id FROM context_quality_samples
          ORDER BY recorded_at DESC, sample_id DESC, strategy_id DESC
          LIMIT -1 OFFSET ?
        )
      `).run(maxSamples);
      return true;
    });
  }

  list(limit = 10_000): StoredContextQualitySamples {
    if (!Number.isSafeInteger(limit) || limit <= 0) return { samples: [], ignoredSamples: 0 };
    const rows = this.database.prepare(`
      SELECT sample_json
      FROM context_quality_samples
      ORDER BY recorded_at ASC, sample_id ASC, strategy_id ASC
      LIMIT ?
    `).all(limit) as unknown as QualitySampleRow[];
    const samples: ContextQualitySample[] = [];
    let ignoredSamples = 0;
    for (const row of rows) {
      const sample = parseSample(row.sample_json);
      if (sample) samples.push(sample);
      else ignoredSamples++;
    }
    return { samples, ignoredSamples };
  }

  aggregate(limit = 10_000): StoredContextQualityAggregate {
    const stored = this.list(limit);
    return {
      ...stored,
      aggregate: aggregateContextQuality(stored.samples),
      timing: qualityTiming(stored.samples),
    };
  }

  clear(): void {
    this.writes.execute("context-quality-clear", () => this.database.exec("DELETE FROM context_quality_samples"));
  }
}
