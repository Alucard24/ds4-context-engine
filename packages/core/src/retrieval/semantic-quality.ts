import {
  cosineSimilarity,
  reciprocalRankFusion,
  type EmbeddingPort,
  validEmbeddingVector,
} from "./embedding.ts";

export const HYBRID_RETRIEVAL_QUALITY_VERSION = "hybrid-retrieval-quality-v1";

export interface SemanticQualityCandidate {
  id: string;
  text: string;
  tokens: number;
}

export interface SemanticQualityFixture {
  id: string;
  query: string;
  exactIdentifiers: string[];
  expectedEvidenceIds: string[];
  maxResults: number;
  candidates: SemanticQualityCandidate[];
}

export interface SemanticQualityCorpus {
  corpusVersion: string;
  fixtures: SemanticQualityFixture[];
}

export interface SemanticStrategyQuality {
  strategy: "lexical-only" | "hybrid";
  evidenceRecall: number;
  irrelevantTokenRatio: number;
  selectedEvidenceIds: string[];
  fallback: boolean;
}

export interface SemanticFixtureQuality {
  fixtureId: string;
  lexical: SemanticStrategyQuality;
  hybrid: SemanticStrategyQuality;
}

export interface SemanticQualityReport {
  metricsVersion: typeof HYBRID_RETRIEVAL_QUALITY_VERSION;
  corpusVersion: string;
  model: { provider: string; model: string; dimensions: number };
  fixtures: SemanticFixtureQuality[];
  aggregate: {
    lexicalEvidenceRecall: number;
    hybridEvidenceRecall: number;
    evidenceRecallDelta: number;
    lexicalIrrelevantTokenRatio: number;
    hybridIrrelevantTokenRatio: number;
    irrelevantTokenRatioDelta: number;
    fallbackCount: number;
  };
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

const QUALITY_STOPWORDS = new Set([
  "and", "are", "before", "for", "from", "into", "local", "the", "this", "with",
]);

function terms(value: string): Set<string> {
  return new Set(
    [...value.toLocaleLowerCase("en-US").matchAll(/[\p{L}\p{N}_-]{3,}/gu)]
      .map((match) => match[0])
      .filter((term) => !QUALITY_STOPWORDS.has(term)),
  );
}

function exactPriority(fixture: SemanticQualityFixture, candidate: SemanticQualityCandidate): number {
  const lower = candidate.text.toLocaleLowerCase("en-US");
  return fixture.exactIdentifiers.some((identifier) =>
    lower.includes(identifier.toLocaleLowerCase("en-US"))
  ) ? 1 : 0;
}

function quality(
  fixture: SemanticQualityFixture,
  strategy: SemanticStrategyQuality["strategy"],
  selectedIds: readonly string[],
  fallback: boolean,
): SemanticStrategyQuality {
  const expected = new Set(fixture.expectedEvidenceIds);
  const selected = new Set(selectedIds);
  const recalled = fixture.expectedEvidenceIds.filter((id) => selected.has(id)).length;
  const selectedCandidates = fixture.candidates.filter((candidate) => selected.has(candidate.id));
  const selectedTokens = selectedCandidates.reduce((total, candidate) => total + candidate.tokens, 0);
  const irrelevantTokens = selectedCandidates
    .filter((candidate) => !expected.has(candidate.id))
    .reduce((total, candidate) => total + candidate.tokens, 0);
  return {
    strategy,
    evidenceRecall: expected.size > 0 ? rounded(recalled / expected.size) : 1,
    irrelevantTokenRatio: selectedTokens > 0 ? rounded(irrelevantTokens / selectedTokens) : 0,
    selectedEvidenceIds: [...selectedIds],
    fallback,
  };
}

function lexicalRanking(fixture: SemanticQualityFixture): Array<{ id: string; score: number }> {
  const queryTerms = terms(fixture.query);
  return fixture.candidates.map((candidate) => {
    const candidateTerms = terms(candidate.text);
    const overlap = [...queryTerms].filter((term) => candidateTerms.has(term)).length;
    return {
      id: candidate.id,
      score: exactPriority(fixture, candidate) * 1_000 + overlap,
    };
  }).filter((candidate) => candidate.score > 0).sort((left, right) =>
    right.score - left.score || left.id.localeCompare(right.id)
  );
}

export function compareHybridRetrievalCorpus(
  corpus: SemanticQualityCorpus,
  port: EmbeddingPort,
): SemanticQualityReport {
  const fixtures = corpus.fixtures.map((fixture): SemanticFixtureQuality => {
    const lexical = lexicalRanking(fixture);
    const lexicalIds = lexical.slice(0, fixture.maxResults).map((candidate) => candidate.id);
    let hybridIds = lexicalIds;
    let fallback = false;
    try {
      const vectors = port.embed([fixture.query, ...fixture.candidates.map((candidate) => candidate.text)]);
      const queryVector = vectors[0];
      if (!queryVector || vectors.length !== fixture.candidates.length + 1
        || !validEmbeddingVector(queryVector, port.identity.dimensions)) {
        throw new Error("invalid embedding batch");
      }
      const lexicalOrder = new Map(lexical.map((candidate, rank) => [candidate.id, rank]));
      const vectorCandidates = fixture.candidates.flatMap((candidate, index) => {
        const vector = vectors[index + 1];
        if (!vector || !validEmbeddingVector(vector, port.identity.dimensions)) return [];
        const similarity = cosineSimilarity(queryVector, vector);
        return similarity === undefined || similarity < 0.1 ? [] : [{ candidate, similarity }];
      }).sort((left, right) =>
        right.similarity - left.similarity || left.candidate.id.localeCompare(right.candidate.id)
      );
      const vectorOrder = new Map(vectorCandidates.map((item, rank) => [item.candidate.id, rank]));
      const similarityById = new Map(vectorCandidates.map((item) => [item.candidate.id, item.similarity]));
      const hybrid = fixture.candidates.filter((candidate) =>
        lexicalOrder.has(candidate.id) || vectorOrder.has(candidate.id)
      ).map((candidate) => {
        const similarity = similarityById.get(candidate.id) ?? 0;
        const score = exactPriority(fixture, candidate) * 1_000_000
          + Math.max(0, similarity) * 80
          + reciprocalRankFusion([
            { rank: lexicalOrder.get(candidate.id), weight: 1 },
            { rank: vectorOrder.get(candidate.id), weight: 1 },
          ]) * 1_500;
        return { id: candidate.id, score };
      }).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
      hybridIds = hybrid.slice(0, fixture.maxResults).map((candidate) => candidate.id);
    } catch {
      fallback = true;
    }
    return {
      fixtureId: fixture.id,
      lexical: quality(fixture, "lexical-only", lexicalIds, false),
      hybrid: quality(fixture, "hybrid", hybridIds, fallback),
    };
  });

  const average = (values: readonly number[]): number => values.length > 0
    ? rounded(values.reduce((total, value) => total + value, 0) / values.length)
    : 0;
  const lexicalEvidenceRecall = average(fixtures.map((fixture) => fixture.lexical.evidenceRecall));
  const hybridEvidenceRecall = average(fixtures.map((fixture) => fixture.hybrid.evidenceRecall));
  const lexicalIrrelevantTokenRatio = average(fixtures.map((fixture) => fixture.lexical.irrelevantTokenRatio));
  const hybridIrrelevantTokenRatio = average(fixtures.map((fixture) => fixture.hybrid.irrelevantTokenRatio));
  return {
    metricsVersion: HYBRID_RETRIEVAL_QUALITY_VERSION,
    corpusVersion: corpus.corpusVersion,
    model: {
      provider: port.identity.provider,
      model: port.identity.model,
      dimensions: port.identity.dimensions,
    },
    fixtures,
    aggregate: {
      lexicalEvidenceRecall,
      hybridEvidenceRecall,
      evidenceRecallDelta: rounded(hybridEvidenceRecall - lexicalEvidenceRecall),
      lexicalIrrelevantTokenRatio,
      hybridIrrelevantTokenRatio,
      irrelevantTokenRatioDelta: rounded(hybridIrrelevantTokenRatio - lexicalIrrelevantTokenRatio),
      fallbackCount: fixtures.filter((fixture) => fixture.hybrid.fallback).length,
    },
  };
}
