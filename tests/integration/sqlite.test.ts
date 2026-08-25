import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "ds4-context-core/persistence/migrations";
import { ContextDatabase } from "ds4-context-core/persistence/sqlite";

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

  it("preserves legacy memory and pins while adding event mutation schema v9", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    for (const migration of MIGRATIONS.filter((item) => item.version <= 8)) database.exec(migration.sql);
    database.prepare("INSERT INTO sessions(session_id, session_file, indexed_at) VALUES (?, ?, ?)")
      .run("legacy-memory-session", "/tmp/legacy-memory.jsonl", 1);
    database.prepare(`
      INSERT INTO entries(
        entry_key, entry_id, session_id, parent_id, entry_type, role,
        created_at, content_hash, searchable_text, token_estimate, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-memory-session:entry-1", "entry-1", "legacy-memory-session", null,
      "message", "user", 1, "hash", "legacy", 1, 1,
    );
    database.prepare(`
      INSERT INTO memory_items(
        memory_id, scope, session_id, project_path, claim, status, created_at, superseded_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("memory-legacy", "session", "legacy-memory-session", null, "Legacy claim", "active", 1, null);
    database.prepare("INSERT INTO memory_sources(memory_id, entry_key) VALUES (?, ?)")
      .run("memory-legacy", "legacy-memory-session:entry-1");
    database.prepare(`
      INSERT INTO pins(
        pin_id, scope, session_id, project_path, content, source_entry_key,
        source_entry_id, source_file, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "pin-legacy", "session", "legacy-memory-session", null, "Legacy pin",
      "legacy-memory-session:entry-1", "entry-1", null, "active", 1,
    );

    const migration = MIGRATIONS.find((item) => item.version === 9);
    if (!migration) throw new Error("Missing schema v9 migration");
    database.exec(migration.sql);

    expect(database.prepare("SELECT claim, status, updated_at FROM memory_items").get())
      .toMatchObject({ claim: "Legacy claim", status: "active", updated_at: 0 });
    expect(database.prepare("SELECT content, status, branch_leaf_id FROM pins").get())
      .toMatchObject({ content: "Legacy pin", status: "active", branch_leaf_id: null });
    expect(database.prepare("SELECT count(*) AS count FROM memory_mutations").get()).toMatchObject({ count: 0 });
    database.close();
  });

  it("preserves legacy calibration while adding cache metrics in schema v10", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    for (const migration of MIGRATIONS.filter((item) => item.version <= 9)) database.exec(migration.sql);
    database.prepare("INSERT INTO sessions(session_id, session_file, indexed_at) VALUES (?, ?, ?)")
      .run("legacy-calibration-session", "/tmp/legacy-calibration.jsonl", 1);
    database.prepare(`
      INSERT INTO context_manifests(
        manifest_id, session_id, created_at, provider, model, estimated_tokens,
        actual_tokens, prompt_hash, policy_version, planner_version, manifest_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-manifest", "legacy-calibration-session", 1, "legacy", "model",
      100, 120, "hash", "1", "observer-v1", "{\"id\":\"legacy-manifest\"}",
    );
    database.prepare(`
      INSERT INTO token_calibration(provider, model, estimated, actual, ratio, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("legacy", "model", 100, 120, 1.2, 1);

    const migration = MIGRATIONS.find((item) => item.version === 10);
    if (!migration) throw new Error("Missing schema v10 migration");
    database.exec(migration.sql);

    expect(database.prepare(`
      SELECT estimator_version, input_tokens, cache_read_tokens, cache_write_tokens
      FROM token_calibration
    `).get()).toMatchObject({
      estimator_version: "chars-v1",
      input_tokens: 120,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
    database.close();
  });

  it("applies schema migrations transactionally and can reopen idempotently", () => {
    const path = databasePath();
    const first = ContextDatabase.open(path, { now: 1_724_544_000_000 });

    expect(existsSync(path)).toBe(true);
    expect(first.schemaVersion).toBe(10);
    expect(first.migrations).toHaveLength(10);
    expect(first.listTables()).toEqual(expect.arrayContaining([
      "sessions",
      "entries",
      "entries_fts",
      "summaries",
      "context_manifests",
      "artifacts",
      "artifact_objects",
      "memory_mutations",
      "pin_mutations",
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
    expect(first.health()).toMatchObject({ ok: true, schemaVersion: 10, foreignKeys: true });
    first.close();
    first.close();

    const second = ContextDatabase.open(path, { now: 1_724_544_100_000 });
    expect(second.migrations).toHaveLength(10);
    expect(second.getSessionStats("session-1")).toEqual({ entries: 0, estimatedTokens: 0 });
    second.close();
  });
});
