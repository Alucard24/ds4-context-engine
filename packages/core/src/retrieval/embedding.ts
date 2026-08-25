export type EmbeddingDestination = "local" | "remote";
export type EmbeddingSourceKind = "session-entry" | "project-snippet";

export interface EmbeddingModelIdentity {
  provider: string;
  model: string;
  dimensions: number;
  destination: EmbeddingDestination;
}

/**
 * Runtime-neutral synchronous embedding port.
 *
 * Core owns orchestration and validation only. A runtime supplies the local model,
 * remote client, WASM implementation, or deterministic test adapter.
 */
export interface EmbeddingPort {
  readonly identity: EmbeddingModelIdentity;
  embed(texts: readonly string[]): readonly (readonly number[])[];
}

export interface EmbeddingSource {
  kind: EmbeddingSourceKind;
  scopeId: string;
  sourceKey: string;
  sourceGroup: string;
  sourceHash: string;
  chunkingVersion: string;
  text: string;
}

export interface EmbeddingTextContext {
  purpose: "source" | "query";
  kind: EmbeddingSourceKind;
  scopeId: string;
  sourceKey?: string;
  destination: EmbeddingDestination;
  provider: string;
  model: string;
}

export type EmbeddingTextGate = (
  text: string,
  context: EmbeddingTextContext,
) => string | undefined;

export interface SemanticSearchHit {
  sourceKey: string;
  sourceHash: string;
  chunkingVersion: string;
  similarity: number;
  rank: number;
}

export interface SemanticSyncDiagnostics {
  enabled: boolean;
  provider?: string;
  model?: string;
  dimensions?: number;
  destination?: EmbeddingDestination;
  sourceKind?: EmbeddingSourceKind;
  scopeId?: string;
  sourceCount: number;
  cachedVectors: number;
  indexedVectors: number;
  skippedByPrivacy: number;
  embeddingCalls: number;
  corruptVectors: number;
  indexFresh: boolean;
  durationMs: number;
  warnings: string[];
  fallbackReason?: string;
}

export interface SemanticQueryDiagnostics {
  enabled: boolean;
  provider?: string;
  model?: string;
  dimensions?: number;
  destination?: EmbeddingDestination;
  lexicalCandidates: number;
  vectorCandidates: number;
  fusedCandidates: number;
  queryCacheHit: boolean;
  queryEmbeddingCalls: number;
  sourceEmbeddingCalls: number;
  indexedVectors: number;
  skippedByPrivacy: number;
  corruptVectors: number;
  indexFresh: boolean;
  durationMs: number;
  warnings: string[];
  fallbackReason?: string;
}

export function embeddingProfileKey(identity: EmbeddingModelIdentity): string {
  return `${identity.provider}/${identity.model}/${identity.dimensions}`;
}

export function validEmbeddingVector(
  vector: readonly number[],
  dimensions: number,
): vector is readonly number[] {
  return vector.length === dimensions
    && vector.every((value) => Number.isFinite(value))
    && vector.some((value) => value !== 0);
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number | undefined {
  if (left.length === 0 || left.length !== right.length) return undefined;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index++) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === undefined || rightValue === undefined
      || !Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return undefined;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return undefined;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

export function reciprocalRankFusion(
  channels: readonly { rank: number | undefined; weight: number }[],
  constant = 60,
): number {
  let score = 0;
  for (const channel of channels) {
    if (channel.rank === undefined || channel.rank < 0 || !Number.isFinite(channel.weight)) continue;
    score += channel.weight / (constant + channel.rank + 1);
  }
  return Math.round(score * 1_000_000_000) / 1_000_000_000;
}

export function disabledSemanticQueryDiagnostics(
  enabled = false,
  fallbackReason?: string,
): SemanticQueryDiagnostics {
  return {
    enabled,
    lexicalCandidates: 0,
    vectorCandidates: 0,
    fusedCandidates: 0,
    queryCacheHit: false,
    queryEmbeddingCalls: 0,
    sourceEmbeddingCalls: 0,
    indexedVectors: 0,
    skippedByPrivacy: 0,
    corruptVectors: 0,
    indexFresh: false,
    durationMs: 0,
    warnings: [],
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}
