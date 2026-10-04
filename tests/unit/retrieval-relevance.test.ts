import { describe, expect, it } from "vitest";
import type {
  EntrySearchResult,
  SessionIndexRepository,
} from "ds4-context-core/persistence/repositories/session-index-repository";
import { HistoricalRetrievalEngine } from "ds4-context-core/retrieval/retrieval-engine";

function hit(entryId: string, text: string, overrides: Partial<EntrySearchResult> = {}): EntrySearchResult {
  return {
    entryId,
    parentId: null,
    entryType: "message",
    role: "user",
    createdAt: 100,
    searchableText: text,
    tokenEstimate: 10,
    contentHash: entryId,
    ...overrides,
  };
}

function retrieve(requestText: string, hits: EntrySearchResult[], exactHits: EntrySearchResult[] = [], maxResults = 1) {
  const repository = {
    searchExact: () => exactHits,
    searchFts: () => hits,
  } as unknown as SessionIndexRepository;
  return new HistoricalRetrievalEngine(repository, () => 0).retrieve({
    sessionId: "synthetic",
    requestText,
    activeBranchEntryIds: new Set([...hits, ...exactHits].map((item) => item.entryId)),
    activeContextEntryIds: new Set(),
    exact: true,
    fts: true,
    semantic: false,
    maxResults,
    maxTokens: 1_000,
    timestamp: 1,
  });
}

describe("historical retrieval topic relevance", () => {
  it("ranks legacy-project evidence above a newer generic workflow reminder", () => {
    const reminder = hit("reminder", "Devi procedere e metterlo in memoria.", { createdAt: 1_000 });
    const topical = hit("topical", "I progetti legacy fuori dalla cartella orbit hanno un registro dedicato.", {
      role: "assistant", createdAt: 1, tokenEstimate: 3_000,
    });
    const result = retrieve(
      "Aggiungi progetti legacy fuori dalla cartella orbit: devi considerare la memoria.",
      [reminder, topical],
    );
    expect(result.selected.map((item) => item.entryId)).toEqual(["topical"]);
    expect(result.selected[0]?.matchedTerms).toEqual(expect.arrayContaining(["legacy", "cartella", "orbit"]));
    expect(result.queryTerms.map((term) => term.toLowerCase())).not.toContain("devi");
  });

  it("does not let FTS order, role, recency and source length outweigh an additional topic match", () => {
    const reminders = Array.from({ length: 10 }, (_, index) =>
      hit(`reminder-${index}`, `Memoria: richiesta generica numero ${index}.`, { createdAt: 1_000 + index }),
    );
    const topical = hit("topical", `Legacy memoria: registro tecnico. ${"x".repeat(48_000)}`, {
      role: "assistant", createdAt: 1, tokenEstimate: 12_000,
    });
    const result = retrieve("legacy memoria", [...reminders, topical]);
    expect(result.selected.map((item) => item.entryId)).toEqual(["topical"]);
    expect(result.selected[0]?.matchedTerms).toEqual(expect.arrayContaining(["legacy", "memoria"]));
    expect(result.selectedTokens).toBeLessThanOrEqual(result.maxTokens);
  });

  it("does not boost keyword prefixes inside unrelated larger words", () => {
    const partial = hit("partial", "Legacy MemoriaMap is an unrelated symbol.", { createdAt: 1_000 });
    const topical = hit("topical", "Legacy memoria: registro tecnico.", { role: "assistant", createdAt: 1 });
    const result = retrieve("legacy memoria", [partial, topical]);
    expect(result.selected.map((item) => item.entryId)).toEqual(["topical"]);
  });

  it("folds Latin accents like the FTS index when counting topic matches", () => {
    const reminder = hit("reminder", "Memoire: generic reminder.", { createdAt: 1_000 });
    const topical = hit("topical", "Legacy mémoire: technical registry.", { role: "assistant", createdAt: 1 });
    const result = retrieve("legacy memoire", [reminder, topical]);
    expect(result.selected.map((item) => item.entryId)).toEqual(["topical"]);
    expect(result.selected[0]?.matchedTerms).toEqual(expect.arrayContaining(["legacy", "memoire"]));
  });

  it("keeps an explicit literal identifier above broader multi-term FTS evidence", () => {
    const literal = hit("literal", "OrbitRegistry stores the mapping.", { role: "assistant", createdAt: 1 });
    const broad = hit("broad", "Legacy memoria cartella progetti registro.", { createdAt: 1_000 });
    const result = retrieve("Inspect `OrbitRegistry`: legacy memoria cartella progetti registro", [broad], [literal]);
    expect(result.selected.map((item) => item.entryId)).toEqual(["literal"]);
  });

  it("does not admit generic-only FTS rows or award them a distinct-topic bonus", () => {
    const reminders = Array.from({ length: 12 }, (_, index) =>
      hit(`generic-${index}`, "Posso procedere solo senza aspettare: capito, avanti.", { createdAt: 1_000 + index }),
    );
    const topical = hit("ui", "Le schermate mostrano il comando da premere per la GUI.", { role: "assistant", createdAt: 1 });
    const result = retrieve(
      "cazzo mostrarmi schermate posso premere solo andare avanti capito senza aspettare input",
      [...reminders, topical], [], 12,
    );
    expect(result.selected.map((item) => item.entryId)).toEqual(["ui"]);
    expect(result.selected[0]?.matchedTerms).toEqual(expect.arrayContaining(["schermate", "premere"]));
    expect(result.queryTerms).not.toEqual(expect.arrayContaining(["posso", "solo", "senza"]));
  });

  it("does not fill spare retrieval budget with lexical rows that match no query term", () => {
    const result = retrieve("schermate", [hit("unrelated", "Posso procedere solo senza aspettare.")], [], 12);
    expect(result.selected).toEqual([]);
    expect(result.selectedTokens).toBe(0);
  });

  it.each(["ok procedi allora", "Sì procedi basta che risolviamo il problema una volta per tutte"])("does not search canonical history for generic interaction: %s", (requestText) => {
    let calls = 0;
    const repository = {
      searchExact: () => { calls++; return []; },
      searchFts: () => { calls++; return []; },
    } as unknown as SessionIndexRepository;
    const result = new HistoricalRetrievalEngine(repository, () => 0).retrieve({
      sessionId: "synthetic", requestText,
      activeBranchEntryIds: new Set(), activeContextEntryIds: new Set(),
      exact: true, fts: true, semantic: false, maxResults: 12, maxTokens: 36_866, timestamp: 1,
    });
    expect(result.status).toBe("no-query");
    expect(result.selected).toEqual([]);
    expect(calls).toBe(0);
  });
});
