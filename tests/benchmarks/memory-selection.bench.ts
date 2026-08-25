import { afterAll, beforeAll, bench } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { MemoryManager } from "../../src/memory/memory-manager.ts";
import type { MemoryMutation, StoredMemoryMutation } from "../../src/memory/memory-types.ts";
import { ContextDatabase } from "../../src/persistence/sqlite.ts";

let database: ContextDatabase;
let manager: MemoryManager;
const sessionId = "memory-benchmark";
const projectPath = "/workspace/benchmark";

beforeAll(() => {
  database = ContextDatabase.open(":memory:");
  const entries = Array.from({ length: 1_000 }, (_, index) => ({
    entryKey: `${sessionId}:mutation-${index}`,
    entryId: `mutation-${index}`,
    sessionId,
    parentId: index === 0 ? null : `mutation-${index - 1}`,
    entryType: "custom",
    createdAt: index + 1,
    contentHash: `hash-${index}`,
    searchableText: "",
    tokenEstimate: 0,
    indexedAt: 1,
  }));
  database.sessionIndex.rebuild(
    { sessionId, sessionFile: "/tmp/memory-benchmark.jsonl", projectPath, indexedAt: 1 },
    entries,
    {
      sessionId,
      sessionFile: "/tmp/memory-benchmark.jsonl",
      headerHash: "header",
      fileSize: 1,
      fileMtimeMs: 1,
      checkpointOffset: 1,
      checkpointHashStart: 0,
      malformedLines: 0,
      indexedAt: 1,
    },
  );
  manager = new MemoryManager(
    database.memory,
    { ...DEFAULT_CONFIG.memory, maxResults: 12 },
    DEFAULT_CONFIG.context.maxPinnedTokens,
    DEFAULT_CONFIG.context.maxMemoryTokens,
    sessionId,
    projectPath,
    true,
    () => 2_000,
    () => "unused",
  );
  const mutations: StoredMemoryMutation[] = entries.map((entry, index) => {
    const mutation: MemoryMutation = {
      schemaVersion: 1,
      mutationId: `mutation-id-${String(index).padStart(4, "0")}`,
      operation: "add",
      createdAt: index + 1,
      item: {
        id: `memory-${String(index).padStart(4, "0")}`,
        scope: index % 2 === 0 ? "session" : "project",
        ...(index % 2 === 1 ? { projectPath } : {}),
        key: `setting-${index}`,
        claim: index === 777
          ? "InvoicePolicy export mode defaults to PerEndpoint."
          : `Durable setting ${index} defaults to value-${index}.`,
        createdAt: index + 1,
        sourceEntryIds: [],
      },
    };
    return {
      mutationKey: entry.entryKey,
      mutationId: mutation.mutationId,
      sessionId,
      createdAt: index + 1,
      entryOrder: index,
      payload: mutation,
    };
  });
  manager.reconcile({ memoryMutations: mutations, pinMutations: [], warnings: [] });
});

afterAll(() => database.close());

bench("rank 1000 durable memories", () => {
  manager.select("Keep InvoicePolicy export mode as PerEndpoint.", new Set());
}, { time: 1_000, warmupTime: 250 });
