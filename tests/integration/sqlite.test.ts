import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextDatabase } from "../../src/persistence/sqlite.ts";

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "ds4-sqlite-"));
  temporaryDirectories.push(directory);
  return join(directory, "nested", "context.db");
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("ContextDatabase", () => {
  it("applies schema migrations transactionally and can reopen idempotently", () => {
    const path = databasePath();
    const first = ContextDatabase.open(path, { now: 1_724_544_000_000 });

    expect(existsSync(path)).toBe(true);
    expect(first.schemaVersion).toBe(4);
    expect(first.migrations).toHaveLength(4);
    expect(first.listTables()).toEqual(expect.arrayContaining([
      "sessions",
      "entries",
      "entries_fts",
      "summaries",
      "context_manifests",
      "artifacts",
      "token_calibration",
      "session_index_state",
    ]));

    first.upsertSession({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      projectPath: "/tmp/project",
      indexedAt: 123,
    });
    expect(first.getSessionStats("session-1")).toEqual({ entries: 0, estimatedTokens: 0 });
    expect(first.health()).toMatchObject({ ok: true, schemaVersion: 4, foreignKeys: true });
    first.close();
    first.close();

    const second = ContextDatabase.open(path, { now: 1_724_544_100_000 });
    expect(second.migrations).toHaveLength(4);
    expect(second.getSessionStats("session-1")).toEqual({ entries: 0, estimatedTokens: 0 });
    second.close();
  });
});
