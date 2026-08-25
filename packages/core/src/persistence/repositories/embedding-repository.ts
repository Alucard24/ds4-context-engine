import type { DatabaseSync } from "node:sqlite";
import {
  cosineSimilarity,
  type EmbeddingModelIdentity,
  type EmbeddingSourceKind,
  type SemanticSearchHit,
  validEmbeddingVector,
} from "../../retrieval/embedding.ts";

export interface StoredEmbedding {
  sourceKind: EmbeddingSourceKind;
  scopeId: string;
  sourceKey: string;
  sourceGroup: string;
  sourceHash: string;
  chunkingVersion: string;
  provider: string;
  model: string;
  dimensions: number;
  vector: readonly number[];
  indexedAt: number;
}

export interface EmbeddingSearchResult {
  hits: SemanticSearchHit[];
  scannedVectors: number;
  corruptVectors: number;
}

interface EmbeddingRow {
  source_key: string;
  source_hash: string;
  chunking_version: string;
  vector_json: string;
}

function parseVector(value: string, dimensions: number): readonly number[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const vector = parsed.filter((item): item is number => typeof item === "number");
    return validEmbeddingVector(vector, dimensions) ? vector : undefined;
  } catch {
    return undefined;
  }
}

export class EmbeddingRepository {
  constructor(private readonly database: DatabaseSync) {}

  getVector(
    kind: EmbeddingSourceKind,
    scopeId: string,
    sourceKey: string,
    sourceHash: string,
    chunkingVersion: string,
    identity: EmbeddingModelIdentity,
  ): readonly number[] | undefined {
    const row = this.database.prepare(`
      SELECT vector_json
      FROM derived_embeddings
      WHERE source_kind = ? AND scope_id = ? AND source_key = ?
        AND source_hash = ? AND chunking_version = ?
        AND embedding_provider = ? AND embedding_model = ? AND dimensions = ?
    `).get(
      kind,
      scopeId,
      sourceKey,
      sourceHash,
      chunkingVersion,
      identity.provider,
      identity.model,
      identity.dimensions,
    ) as { vector_json: string } | undefined;
    return row ? parseVector(row.vector_json, identity.dimensions) : undefined;
  }

  upsert(rows: readonly StoredEmbedding[]): void {
    if (rows.length === 0) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const statement = this.database.prepare(`
        INSERT INTO derived_embeddings(
          source_kind, scope_id, source_key, source_group, source_hash,
          chunking_version, embedding_provider, embedding_model, dimensions,
          vector_json, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(
          source_kind, scope_id, source_key, source_hash, chunking_version,
          embedding_provider, embedding_model, dimensions
        ) DO UPDATE SET
          source_group = excluded.source_group,
          vector_json = excluded.vector_json,
          indexed_at = excluded.indexed_at
      `);
      for (const row of rows) {
        if (!validEmbeddingVector(row.vector, row.dimensions)) continue;
        statement.run(
          row.sourceKind,
          row.scopeId,
          row.sourceKey,
          row.sourceGroup,
          row.sourceHash,
          row.chunkingVersion,
          row.provider,
          row.model,
          row.dimensions,
          JSON.stringify(row.vector),
          row.indexedAt,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Remove rows whose canonical source key/hash/chunk version is no longer current. */
  pruneSources(
    kind: EmbeddingSourceKind,
    scopeId: string,
    sources: readonly { sourceKey: string; sourceHash: string; chunkingVersion: string }[],
  ): number {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        CREATE TEMP TABLE IF NOT EXISTS ds4_current_embedding_sources (
          source_key TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          chunking_version TEXT NOT NULL,
          PRIMARY KEY(source_key, source_hash, chunking_version)
        ) WITHOUT ROWID, STRICT;
        DELETE FROM ds4_current_embedding_sources;
      `);
      const insert = this.database.prepare(`
        INSERT OR IGNORE INTO ds4_current_embedding_sources(
          source_key, source_hash, chunking_version
        ) VALUES (?, ?, ?)
      `);
      for (const source of sources) {
        insert.run(source.sourceKey, source.sourceHash, source.chunkingVersion);
      }
      const result = this.database.prepare(`
        DELETE FROM derived_embeddings
        WHERE source_kind = ? AND scope_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM ds4_current_embedding_sources AS current
            WHERE current.source_key = derived_embeddings.source_key
              AND current.source_hash = derived_embeddings.source_hash
              AND current.chunking_version = derived_embeddings.chunking_version
          )
      `).run(kind, scopeId);
      this.database.exec("COMMIT");
      return Number(result.changes);
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  searchSimilar(
    kind: EmbeddingSourceKind,
    scopeId: string,
    identity: EmbeddingModelIdentity,
    queryVector: readonly number[],
    limit: number,
    maximumRows: number,
  ): EmbeddingSearchResult {
    if (!validEmbeddingVector(queryVector, identity.dimensions)) {
      return { hits: [], scannedVectors: 0, corruptVectors: 0 };
    }
    const rows = this.database.prepare(`
      SELECT source_key, source_hash, chunking_version, vector_json
      FROM derived_embeddings
      WHERE source_kind = ? AND scope_id = ?
        AND embedding_provider = ? AND embedding_model = ? AND dimensions = ?
      ORDER BY source_key, source_hash, chunking_version
      LIMIT ?
    `).all(
      kind,
      scopeId,
      identity.provider,
      identity.model,
      identity.dimensions,
      maximumRows,
    ) as unknown as EmbeddingRow[];

    let corruptVectors = 0;
    const scored: Array<Omit<SemanticSearchHit, "rank">> = [];
    for (const row of rows) {
      const vector = parseVector(row.vector_json, identity.dimensions);
      if (!vector) {
        corruptVectors++;
        continue;
      }
      const similarity = cosineSimilarity(queryVector, vector);
      if (similarity === undefined || !Number.isFinite(similarity)) {
        corruptVectors++;
        continue;
      }
      scored.push({
        sourceKey: row.source_key,
        sourceHash: row.source_hash,
        chunkingVersion: row.chunking_version,
        similarity: Math.round(similarity * 1_000_000) / 1_000_000,
      });
    }
    scored.sort((left, right) =>
      right.similarity - left.similarity
      || left.sourceKey.localeCompare(right.sourceKey)
      || left.sourceHash.localeCompare(right.sourceHash)
      || left.chunkingVersion.localeCompare(right.chunkingVersion)
    );
    return {
      hits: scored.slice(0, Math.max(0, limit)).map((hit, rank) => ({ ...hit, rank })),
      scannedVectors: rows.length,
      corruptVectors,
    };
  }

  countProfile(
    kind: EmbeddingSourceKind,
    scopeId: string,
    identity: EmbeddingModelIdentity,
  ): number {
    const row = this.database.prepare(`
      SELECT count(*) AS count
      FROM derived_embeddings
      WHERE source_kind = ? AND scope_id = ?
        AND embedding_provider = ? AND embedding_model = ? AND dimensions = ?
    `).get(
      kind,
      scopeId,
      identity.provider,
      identity.model,
      identity.dimensions,
    ) as { count: number };
    return row.count;
  }
}
