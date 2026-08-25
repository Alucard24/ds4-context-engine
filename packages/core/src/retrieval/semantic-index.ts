import type { EmbeddingRepository } from "../persistence/repositories/embedding-repository.ts";
import { sha256 } from "../shared/hash.ts";
import {
  disabledSemanticQueryDiagnostics,
  embeddingProfileKey,
  type EmbeddingModelIdentity,
  type EmbeddingPort,
  type EmbeddingSource,
  type EmbeddingSourceKind,
  type EmbeddingTextGate,
  type SemanticQueryDiagnostics,
  type SemanticSearchHit,
  type SemanticSyncDiagnostics,
  validEmbeddingVector,
} from "./embedding.ts";

export interface SemanticEmbeddingIndexOptions {
  maxSources: number;
  candidatePool: number;
  batchSize: number;
  queryCacheSize: number;
  timeoutMs: number;
  minimumSimilarity?: number;
}

export interface SemanticQueryResult {
  hits: SemanticSearchHit[];
  diagnostics: SemanticQueryDiagnostics;
}

function uniqueWarnings(values: readonly string[]): string[] {
  return [...new Set(values)].slice(0, 20);
}

function identityFields(identity: EmbeddingModelIdentity): Pick<
  SemanticQueryDiagnostics,
  "provider" | "model" | "dimensions" | "destination"
> {
  return {
    provider: identity.provider,
    model: identity.model,
    dimensions: identity.dimensions,
    destination: identity.destination,
  };
}

export class SemanticEmbeddingIndex {
  private readonly queryCache = new Map<string, readonly number[]>();
  private readonly syncByScope = new Map<string, SemanticSyncDiagnostics>();

  constructor(
    private readonly repository: EmbeddingRepository,
    private readonly port: EmbeddingPort,
    private readonly options: SemanticEmbeddingIndexOptions,
    private readonly gate: EmbeddingTextGate = (text) => text,
    private readonly now: () => number = () => performance.now(),
    private readonly indexedAt: () => number = Date.now,
  ) {}

  get identity(): EmbeddingModelIdentity {
    return this.port.identity;
  }

  get sourceLimit(): number {
    return this.options.maxSources;
  }

  syncSources(
    kind: EmbeddingSourceKind,
    scopeId: string,
    inputSources: readonly EmbeddingSource[],
    complete: boolean,
  ): SemanticSyncDiagnostics {
    const startedAt = this.now();
    const warnings: string[] = [];
    const seen = new Set<string>();
    const sources: EmbeddingSource[] = [];
    for (const source of inputSources) {
      if (source.kind !== kind || source.scopeId !== scopeId || !source.text.trim()) continue;
      const key = `${source.sourceKey}\0${source.sourceHash}\0${source.chunkingVersion}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push(source);
    }
    sources.sort((left, right) =>
      left.sourceKey.localeCompare(right.sourceKey)
      || left.sourceHash.localeCompare(right.sourceHash)
      || left.chunkingVersion.localeCompare(right.chunkingVersion)
    );
    const sourceLimitExceeded = sources.length > this.options.maxSources;
    sources.splice(this.options.maxSources);

    let cachedVectors = 0;
    let indexedVectors = 0;
    let skippedByPrivacy = 0;
    let embeddingCalls = 0;
    let corruptVectors = 0;
    let failed = false;
    let fallbackReason: string | undefined;

    try {
      if (complete && !sourceLimitExceeded) {
        this.repository.pruneSources(kind, scopeId, sources);
      }
      const pending: Array<{ source: EmbeddingSource; text: string }> = [];
      for (const source of sources) {
        const existing = this.repository.getVector(
          kind,
          scopeId,
          source.sourceKey,
          source.sourceHash,
          source.chunkingVersion,
          this.port.identity,
        );
        if (existing) {
          cachedVectors++;
          continue;
        }
        const text = this.gate(source.text, {
          purpose: "source",
          kind,
          scopeId,
          sourceKey: source.sourceKey,
          destination: this.port.identity.destination,
          provider: this.port.identity.provider,
          model: this.port.identity.model,
        });
        if (text === undefined) {
          skippedByPrivacy++;
          continue;
        }
        pending.push({ source, text });
      }

      for (let offset = 0; offset < pending.length; offset += this.options.batchSize) {
        const batch = pending.slice(offset, offset + this.options.batchSize);
        const callStartedAt = this.now();
        let vectors: readonly (readonly number[])[];
        try {
          embeddingCalls++;
          vectors = this.port.embed(batch.map((item) => item.text));
        } catch (error) {
          failed = true;
          fallbackReason = `embedding provider failure: ${error instanceof Error ? error.message : String(error)}`;
          break;
        }
        const elapsed = Math.max(0, this.now() - callStartedAt);
        if (elapsed > this.options.timeoutMs) {
          failed = true;
          fallbackReason = `embedding timeout after ${Math.round(elapsed)} ms`;
          break;
        }
        if (vectors.length !== batch.length) {
          failed = true;
          fallbackReason = "embedding provider returned an unexpected batch size";
          break;
        }
        const rows = [];
        for (let index = 0; index < batch.length; index++) {
          const item = batch[index];
          const vector = vectors[index];
          if (!item || !vector || !validEmbeddingVector(vector, this.port.identity.dimensions)) {
            corruptVectors++;
            continue;
          }
          rows.push({
            sourceKind: kind,
            scopeId,
            sourceKey: item.source.sourceKey,
            sourceGroup: item.source.sourceGroup,
            sourceHash: item.source.sourceHash,
            chunkingVersion: item.source.chunkingVersion,
            provider: this.port.identity.provider,
            model: this.port.identity.model,
            dimensions: this.port.identity.dimensions,
            vector,
            indexedAt: this.indexedAt(),
          });
        }
        this.repository.upsert(rows);
        indexedVectors += rows.length;
      }
    } catch (error) {
      failed = true;
      fallbackReason = `embedding index failure: ${error instanceof Error ? error.message : String(error)}`;
    }

    if (fallbackReason) warnings.push(fallbackReason);
    const diagnostics: SemanticSyncDiagnostics = {
      enabled: true,
      ...identityFields(this.port.identity),
      sourceKind: kind,
      scopeId,
      sourceCount: sources.length,
      cachedVectors,
      indexedVectors,
      skippedByPrivacy,
      embeddingCalls,
      corruptVectors,
      indexFresh: complete && !failed && corruptVectors === 0,
      durationMs: Math.max(0, this.now() - startedAt),
      warnings: uniqueWarnings(warnings),
      ...(fallbackReason ? { fallbackReason } : {}),
    };
    this.syncByScope.set(`${kind}\0${scopeId}`, diagnostics);
    return diagnostics;
  }

  query(
    kind: EmbeddingSourceKind,
    scopeId: string,
    text: string,
    lexicalCandidates: number,
  ): SemanticQueryResult {
    const startedAt = this.now();
    const sync = this.syncByScope.get(`${kind}\0${scopeId}`);
    const base: SemanticQueryDiagnostics = {
      ...disabledSemanticQueryDiagnostics(true),
      ...identityFields(this.port.identity),
      lexicalCandidates,
      sourceEmbeddingCalls: sync?.embeddingCalls ?? 0,
      indexedVectors: (sync?.cachedVectors ?? 0) + (sync?.indexedVectors ?? 0),
      skippedByPrivacy: sync?.skippedByPrivacy ?? 0,
      corruptVectors: sync?.corruptVectors ?? 0,
      indexFresh: sync?.indexFresh ?? false,
      warnings: [...(sync?.warnings ?? [])],
    };
    const prepared = this.gate(text, {
      purpose: "query",
      kind,
      scopeId,
      destination: this.port.identity.destination,
      provider: this.port.identity.provider,
      model: this.port.identity.model,
    });
    if (prepared === undefined) {
      const fallbackReason = "embedding query excluded by privacy policy";
      return {
        hits: [],
        diagnostics: {
          ...base,
          durationMs: Math.max(0, this.now() - startedAt),
          fallbackReason,
          warnings: uniqueWarnings([...base.warnings, fallbackReason]),
        },
      };
    }

    const cacheKey = sha256(`${embeddingProfileKey(this.port.identity)}\0${prepared}`);
    let vector = this.queryCache.get(cacheKey);
    let queryCacheHit = Boolean(vector);
    let queryEmbeddingCalls = 0;
    let fallbackReason: string | undefined;
    if (!vector) {
      const callStartedAt = this.now();
      try {
        queryEmbeddingCalls = 1;
        const vectors = this.port.embed([prepared]);
        const elapsed = Math.max(0, this.now() - callStartedAt);
        if (elapsed > this.options.timeoutMs) {
          fallbackReason = `embedding timeout after ${Math.round(elapsed)} ms`;
        } else if (vectors.length !== 1 || !vectors[0]
          || !validEmbeddingVector(vectors[0], this.port.identity.dimensions)) {
          fallbackReason = "embedding provider returned a corrupt query vector";
        } else {
          vector = vectors[0];
          this.queryCache.set(cacheKey, vector);
          while (this.queryCache.size > this.options.queryCacheSize) {
            const oldest = this.queryCache.keys().next().value as string | undefined;
            if (!oldest) break;
            this.queryCache.delete(oldest);
          }
        }
      } catch (error) {
        fallbackReason = `embedding provider failure: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    if (!vector) {
      return {
        hits: [],
        diagnostics: {
          ...base,
          queryCacheHit,
          queryEmbeddingCalls,
          durationMs: Math.max(0, this.now() - startedAt),
          ...(fallbackReason ? { fallbackReason } : {}),
          warnings: uniqueWarnings([...base.warnings, ...(fallbackReason ? [fallbackReason] : [])]),
        },
      };
    }

    try {
      const searched = this.repository.searchSimilar(
        kind,
        scopeId,
        this.port.identity,
        vector,
        this.options.candidatePool,
        this.options.maxSources,
      );
      const minimumSimilarity = this.options.minimumSimilarity ?? 0.1;
      const hits = searched.hits.filter((hit) => hit.similarity >= minimumSimilarity);
      if (searched.corruptVectors > 0 && hits.length === 0) {
        fallbackReason = "all matching embedding vectors were corrupt";
      }
      return {
        hits,
        diagnostics: {
          ...base,
          vectorCandidates: hits.length,
          queryCacheHit,
          queryEmbeddingCalls,
          corruptVectors: searched.corruptVectors,
          durationMs: Math.max(0, this.now() - startedAt),
          ...(fallbackReason ? { fallbackReason } : {}),
          warnings: uniqueWarnings([
            ...base.warnings,
            ...(searched.corruptVectors > 0 ? [`${searched.corruptVectors} corrupt embedding vector(s) ignored`] : []),
          ]),
        },
      };
    } catch (error) {
      fallbackReason = `vector search failure: ${error instanceof Error ? error.message : String(error)}`;
      return {
        hits: [],
        diagnostics: {
          ...base,
          queryCacheHit,
          queryEmbeddingCalls,
          durationMs: Math.max(0, this.now() - startedAt),
          fallbackReason,
          warnings: uniqueWarnings([...base.warnings, fallbackReason]),
        },
      };
    }
  }
}
