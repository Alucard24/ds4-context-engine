import { describe, expect, it } from "vitest";
import { ContextDatabase } from "ds4-context-core/persistence/sqlite";
import type {
  EntrySearchResult,
  SessionIndexRepository,
} from "ds4-context-core/persistence/repositories/session-index-repository";
import { disabledSemanticQueryDiagnostics } from "ds4-context-core/retrieval/embedding";
import {
  HistoricalRetrievalEngine,
  type RetrieveHistoryInput,
} from "ds4-context-core/retrieval/retrieval-engine";
import { SemanticEmbeddingIndex } from "ds4-context-core/retrieval/semantic-index";
import { LocalFeatureHashEmbedding } from "../../src/pi-adapter/local-embedding.ts";

const hit: EntrySearchResult = {
  entryId: "entry-old",
  parentId: null,
  entryType: "message",
  role: "user",
  createdAt: 1,
  searchableText: "LastExportUtc remains nullable.",
  tokenEstimate: 10,
  contentHash: "hash",
};

function input(overrides: Partial<RetrieveHistoryInput> = {}): RetrieveHistoryInput {
  return {
    sessionId: "session",
    requestText: "What about `LastExportUtc`?",
    activeBranchEntryIds: new Set(["entry-old"]),
    activeContextEntryIds: new Set(),
    exact: true,
    fts: true,
    semantic: false,
    maxResults: 4,
    maxTokens: 1_000,
    timestamp: 1,
    ...overrides,
  };
}

function repository(options: { ftsError?: boolean } = {}): SessionIndexRepository {
  return {
    searchExact: () => [hit],
    searchFts: () => {
      if (options.ftsError) throw new Error("fts unavailable");
      return [{ ...hit, score: -1 }];
    },
  } as unknown as SessionIndexRepository;
}

describe("HistoricalRetrievalEngine fallback policy", () => {
  it("retains exact evidence when FTS fails", () => {
    const engine = new HistoricalRetrievalEngine(repository({ ftsError: true }), () => 0);
    const result = engine.retrieve(input());

    expect(result.status).toBe("complete");
    expect(result.selected.map((item) => item.entryId)).toEqual(["entry-old"]);
    expect(result.warnings).toEqual(["FTS unavailable: fts unavailable"]);
  });

  it("falls back to lexical results when the semantic index is unavailable", () => {
    const engine = new HistoricalRetrievalEngine(repository(), () => 0);
    const result = engine.retrieve(input({ semantic: true }));

    expect(result.selected).toHaveLength(1);
    expect(result.semantic).toMatchObject({
      enabled: true,
      vectorCandidates: 0,
      fallbackReason: "semantic index unavailable",
    });
  });

  it("keeps exact identifiers ahead of stronger vector-only candidates", () => {
    const exactHit: EntrySearchResult = {
      ...hit,
      role: "assistant",
      tokenEstimate: 12_000,
    };
    const vectorHit: EntrySearchResult = {
      entryId: "entry-vector",
      parentId: null,
      entryType: "message",
      role: "user",
      createdAt: 100,
      searchableText: "Renew authentication credentials after expiry.",
      tokenEstimate: 1,
      contentHash: "hash-vector",
    };
    const semanticRepository = {
      searchExact: () => [exactHit],
      searchFts: () => [],
      getEntriesByIds: () => [vectorHit],
    } as unknown as SessionIndexRepository;
    const semanticIndex = {
      query: () => ({
        hits: [{
          sourceKey: vectorHit.entryId,
          sourceHash: vectorHit.contentHash,
          chunkingVersion: "pi-session-entry-v1",
          similarity: 1,
          rank: 0,
        }],
        diagnostics: {
          ...disabledSemanticQueryDiagnostics(true),
          vectorCandidates: 1,
          indexFresh: true,
        },
      }),
    } as unknown as SemanticEmbeddingIndex;
    const engine = new HistoricalRetrievalEngine(semanticRepository, () => 0, semanticIndex);

    const result = engine.retrieve(input({
      semantic: true,
      activeBranchEntryIds: new Set([exactHit.entryId, vectorHit.entryId]),
      maxResults: 1,
      maxTokens: 20_000,
    }));

    expect(result.selected[0]?.entryId).toBe(exactHit.entryId);
    expect(result.selected[0]?.reason).toContain("exact identifier");
  });

  it("adds active-branch semantic history without weakening exact retrieval", () => {
    const semanticRows: EntrySearchResult[] = [
      {
        entryId: "entry-auth",
        parentId: null,
        entryType: "message",
        role: "assistant",
        createdAt: 1,
        searchableText: "OAuth token refresh handles expired authentication secrets.",
        tokenEstimate: 12,
        contentHash: "hash-auth",
      },
      {
        entryId: "entry-schema",
        parentId: null,
        entryType: "message",
        role: "assistant",
        createdAt: 2,
        searchableText: "SQLite migration creates a metadata table.",
        tokenEstimate: 12,
        contentHash: "hash-schema",
      },
    ];
    const semanticRepository = {
      searchExact: () => [],
      searchFts: () => [],
      listEmbeddingSources: () => ({ rows: semanticRows, total: semanticRows.length }),
      getEntriesByIds: (_sessionId: string, ids: readonly string[]) =>
        semanticRows.filter((row) => ids.includes(row.entryId)),
    } as unknown as SessionIndexRepository;
    const database = ContextDatabase.open(":memory:");
    const semanticIndex = new SemanticEmbeddingIndex(
      database.embeddings,
      new LocalFeatureHashEmbedding(256),
      {
        maxSources: 100,
        candidatePool: 10,
        batchSize: 16,
        queryCacheSize: 8,
        timeoutMs: 1_000,
      },
      undefined,
      () => 0,
      () => 100,
    );
    const engine = new HistoricalRetrievalEngine(semanticRepository, () => 0, semanticIndex);
    engine.syncSemantic("session");

    const result = engine.retrieve(input({
      requestText: "renew authorization credentials after expiry",
      activeBranchEntryIds: new Set(semanticRows.map((row) => row.entryId)),
      exact: true,
      fts: true,
      semantic: true,
      maxResults: 1,
    }));

    expect(result.selected[0]).toMatchObject({ entryId: "entry-auth" });
    expect(result.selected[0]?.reason).toContain("vector similarity");
    expect(result.semantic).toMatchObject({ enabled: true, vectorCandidates: 1, indexFresh: true });
    database.close();
  });

  it("does no storage work when retrieval is disabled", () => {
    let calls = 0;
    const engine = new HistoricalRetrievalEngine({
      searchExact: () => { calls++; return []; },
      searchFts: () => { calls++; return []; },
    } as unknown as SessionIndexRepository, () => 0);
    const result = engine.retrieve(input({ exact: false, fts: false }));

    expect(result.status).toBe("disabled");
    expect(calls).toBe(0);
  });
});
