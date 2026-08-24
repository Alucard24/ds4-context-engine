import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../../src/persistence/migrations.ts";
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
  it("preserves legacy artifact bytes and source provenance in schema v8", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    for (const migration of MIGRATIONS.filter((item) => item.version <= 7)) database.exec(migration.sql);
    database.prepare("INSERT INTO sessions(session_id, session_file, indexed_at) VALUES (?, ?, ?)")
      .run("legacy-session", "/tmp/legacy.jsonl", 1);
    database.prepare(`
      INSERT INTO entries(
        entry_key, entry_id, session_id, parent_id, entry_type, role,
        created_at, content_hash, searchable_text, token_estimate, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-session:legacy-entry", "legacy-entry", "legacy-session", null,
      "message", "toolResult", 1, "hash", "legacy output", 3, 1,
    );
    database.prepare(`
      INSERT INTO artifacts(
        artifact_id, sha256, file_path, mime_type, size_bytes, created_at,
        source_entry_key, source_entry_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-artifact", "a".repeat(64), "/tmp/legacy-artifact", "text/plain", 13, 1,
      "legacy-session:legacy-entry", "legacy-entry",
    );

    const migration = MIGRATIONS.find((item) => item.version === 8);
    if (!migration) throw new Error("Missing schema v8 migration");
    database.exec(migration.sql);

    expect(database.prepare("SELECT sha256, size_bytes, status FROM artifact_objects").get()).toMatchObject({
      sha256: "a".repeat(64),
      size_bytes: 13,
      status: "available",
    });
    expect(database.prepare("SELECT source_session_id, source_entry_id, source_tool_call_id FROM artifacts").get())
      .toMatchObject({
        source_session_id: "legacy-session",
        source_entry_id: "legacy-entry",
        source_tool_call_id: "legacy",
      });
    database.close();
  });

  it("applies schema migrations transactionally and can reopen idempotently", () => {
    const path = databasePath();
    const first = ContextDatabase.open(path, { now: 1_724_544_000_000 });

    expect(existsSync(path)).toBe(true);
    expect(first.schemaVersion).toBe(8);
    expect(first.migrations).toHaveLength(8);
    expect(first.listTables()).toEqual(expect.arrayContaining([
      "sessions",
      "entries",
      "entries_fts",
      "summaries",
      "context_manifests",
      "artifacts",
      "artifact_objects",
      "token_calibration",
      "session_index_state",
      "project_states",
      "project_files",
      "project_snippets",
      "project_snippets_fts",
    ]));

    first.upsertSession({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      projectPath: "/tmp/project",
      indexedAt: 123,
    });
    expect(first.getSessionStats("session-1")).toEqual({ entries: 0, estimatedTokens: 0 });
    expect(first.health()).toMatchObject({ ok: true, schemaVersion: 8, foreignKeys: true });
    first.close();
    first.close();

    const second = ContextDatabase.open(path, { now: 1_724_544_100_000 });
    expect(second.migrations).toHaveLength(8);
    expect(second.getSessionStats("session-1")).toEqual({ entries: 0, estimatedTokens: 0 });
    second.close();
  });
});
