import { describe, expect, it } from "vitest";
import type {
  EntrySearchResult,
  SessionIndexRepository,
} from "ds4-context-core/persistence/repositories/session-index-repository";
import {
  HistoricalRetrievalEngine,
  type RetrieveHistoryInput,
} from "ds4-context-core/retrieval/retrieval-engine";

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

  it("reports configured semantic ranking without changing lexical results", () => {
    const engine = new HistoricalRetrievalEngine(repository(), () => 0);
    const result = engine.retrieve(input({ semantic: true }));

    expect(result.selected).toHaveLength(1);
    expect(result.warnings.join("\n")).toContain("Semantic ranking");
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
