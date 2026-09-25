import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, bench, describe } from "vitest";
import type {
  SessionIndexCheckpointInput,
  StoredSessionEntry,
} from "ds4-context-core/persistence/repositories/session-index-repository";
import { ContextDatabase } from "ds4-context-core/persistence/sqlite";

/**
 * Storage-growth benchmark for derived SQLite projections.
 *
 * Seeds session indexes at increasing sizes and measures the hot paths a
 * session actually pays: exact-identifier scan, FTS retrieval, per-session
 * stats, storage diagnostics, and the append-only unchanged re-check.
 *
 * Run on demand with:
 *
 *   npx vitest bench tests/benchmarks/storage-scale.bench.ts
 */

const SIZES = [5_000, 50_000, 200_000] as const;
const BATCH_SIZE = 1_000;

interface Fixture {
  size: number;
  sessionId: string;
  database: ContextDatabase;
  identity: { sessionId: string; sessionFile: string; projectPath: string; indexedAt: number };
  firstBatch: StoredSessionEntry[];
}

const root = mkdtempSync(join(tmpdir(), "ds4-storage-scale-"));
const fixtures = new Map<number, Fixture>();

function fixture(size: number): Fixture {
  const value = fixtures.get(size);
  if (!value) throw new Error(`Missing storage-scale fixture for ${size}`);
  return value;
}

function entry(sessionId: string, index: number): StoredSessionEntry {
  return {
    entryKey: `${sessionId}:entry-${index}`,
    entryId: `entry-${index}`,
    sessionId,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    entryType: "message",
    role: index % 2 === 0 ? "user" : "assistant",
    createdAt: index,
    contentHash: `hash-${index}`,
    searchableText: index === 0
      ? "UniqueNeedle only here with the canonical marker"
      : `turn ${index} mentions Marker${index % 97} and Symbol${index % 1009} with reference text for retrieval benchmarks`,
    tokenEstimate: 24,
    indexedAt: index,
  };
}

function checkpoint(sessionId: string, offset: number): SessionIndexCheckpointInput {
  return {
    sessionId,
    sessionFile: `/tmp/${sessionId}.jsonl`,
    headerHash: `header-${sessionId}`,
    fileSize: offset,
    fileMtimeMs: offset,
    checkpointOffset: offset,
    checkpointHashStart: 0,
    checkpointHash: `checkpoint-${offset}`,
    malformedLines: 0,
    indexedAt: offset,
  };
}

beforeAll(() => {
  for (const size of SIZES) {
    const sessionId = `scale-${size}`;
    const database = ContextDatabase.open(join(root, `${size}.db`));
    const identity = {
      sessionId,
      sessionFile: `/tmp/${sessionId}.jsonl`,
      projectPath: "/tmp/scale-project",
      indexedAt: 1,
    };
    const firstBatch: StoredSessionEntry[] = [];
    for (let start = 0; start < size; start += BATCH_SIZE) {
      const end = Math.min(start + BATCH_SIZE, size);
      const batch: StoredSessionEntry[] = [];
      for (let index = start; index < end; index++) batch.push(entry(sessionId, index));
      if (start === 0) firstBatch.push(...batch);
      database.sessionIndex.append(identity, batch, checkpoint(sessionId, end));
    }
    fixtures.set(size, { size, sessionId, database, identity, firstBatch });
  }
}, 900_000);

afterAll(() => {
  for (const value of fixtures.values()) value.database.close();
  rmSync(root, { recursive: true, force: true });
});

const options = { time: 400, warmupTime: 150 };

for (const size of SIZES) {
  describe(`session index with ${size.toLocaleString("en-US")} entries`, () => {
    bench("exact identifier scan over one session", () => {
      fixture(size).database.sessionIndex.searchExact(fixture(size).sessionId, "UniqueNeedle", 5);
    }, options);

    bench("exact phrase scan over one session", () => {
      fixture(size).database.sessionIndex.searchExact(fixture(size).sessionId, "canonical marker", 5);
    }, options);

    bench("FTS retrieval (common token)", () => {
      fixture(size).database.sessionIndex.searchFts(fixture(size).sessionId, '"Marker42"', 5);
    }, options);

    bench("FTS retrieval (rare token)", () => {
      fixture(size).database.sessionIndex.searchFts(fixture(size).sessionId, '"Symbol7"', 5);
    }, options);

    bench("per-session stats", () => {
      fixture(size).database.sessionIndex.getStats(fixture(size).sessionId);
    }, options);

    bench("storage diagnostics", () => {
      fixture(size).database.storageDiagnostics("/tmp/scale-project");
    }, options);

    bench("append-only unchanged re-check (1,000 entries)", () => {
      const target = fixture(size);
      target.database.sessionIndex.append(
        target.identity,
        target.firstBatch,
        checkpoint(target.sessionId, BATCH_SIZE),
      );
    }, options);
  });
}
