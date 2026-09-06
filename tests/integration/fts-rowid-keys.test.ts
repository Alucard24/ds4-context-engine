import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
} from "ds4-context-core/persistence/migrations";
import {
  SessionIndexRepository,
  type SessionIdentity,
  type SessionIndexCheckpointInput,
  type StoredSessionEntry,
} from "ds4-context-core/persistence/repositories/session-index-repository";
import {
  ProjectKnowledgeRepository,
  type StoredProjectSnippet,
} from "ds4-context-core/persistence/repositories/project-knowledge-repository";
import { SqliteWriteCoordinator } from "ds4-context-core/persistence/write-coordinator";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function migrationChecksum(migration: { version: number; name: string; sql: string }): string {
  return createHash("sha256")
    .update(`${migration.version}\n${migration.name}\n${migration.sql}`)
    .digest("hex");
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "ds4-fts-keys-"));
  temporaryDirectories.push(directory);
  return directory;
}

function openRepositories(): {
  raw: DatabaseSync;
  sessionIndex: SessionIndexRepository;
  projectKnowledge: ProjectKnowledgeRepository;
} {
  const raw = new DatabaseSync(join(temporaryDirectory(), "context.db"));
  applyMigrations(raw);
  const writes = new SqliteWriteCoordinator(raw);
  return {
    raw,
    sessionIndex: new SessionIndexRepository(raw, writes),
    projectKnowledge: new ProjectKnowledgeRepository(raw, writes),
  };
}

function entry(sequence: number, text: string, sessionId = "s1"): StoredSessionEntry {
  return {
    entryKey: `${sessionId}:e${sequence}`,
    entryId: `e${sequence}`,
    sessionId,
    parentId: null,
    entryType: "message",
    role: "user",
    createdAt: 1_000 + sequence,
    contentHash: "c".repeat(64),
    searchableText: text,
    tokenEstimate: 10,
    indexedAt: 2_000 + sequence,
  };
}

function identity(sessionId: string, file: string): SessionIdentity {
  return { sessionId, sessionFile: file, projectPath: "/p", indexedAt: 3_000 };
}

function checkpoint(sessionId: string, file: string, offset: number): SessionIndexCheckpointInput {
  return {
    sessionId,
    sessionFile: file,
    headerHash: "h",
    fileSize: 100,
    fileMtimeMs: 1,
    checkpointOffset: offset,
    checkpointHashStart: 0,
    malformedLines: 0,
    indexedAt: 1,
  };
}

function ftsCounts(raw: DatabaseSync): { entries: number; keys: number; snippets: number; snippetKeys: number } {
  return {
    entries: (raw.prepare("SELECT count(*) AS c FROM entries_fts").get() as { c: number }).c,
    keys: (raw.prepare("SELECT count(*) AS c FROM entries_fts_keys").get() as { c: number }).c,
    snippets: (raw.prepare("SELECT count(*) AS c FROM project_snippets_fts").get() as { c: number }).c,
    snippetKeys: (raw.prepare("SELECT count(*) AS c FROM project_snippets_fts_keys").get() as { c: number }).c,
  };
}

describe("FTS rowid key mappings (migration 16)", () => {
  it("upgrades a v15 database without losing entries, FTS rows, or search behavior", () => {
    const path = join(temporaryDirectory(), "context.db");
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA foreign_keys = ON;");
    raw.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      ) STRICT;
    `);
    const insertMigration = raw.prepare(
      "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    );
    for (const migration of MIGRATIONS.filter((item) => item.version < 16)) {
      raw.exec(migration.sql);
      insertMigration.run(migration.version, migration.name, migrationChecksum(migration), migration.version);
      raw.exec(`PRAGMA user_version = ${migration.version}`);
    }
    raw.prepare("INSERT INTO sessions(session_id, session_file, project_path, indexed_at) VALUES (?, ?, ?, ?)")
      .run("s1", "/x.jsonl", "/x", 1);
    raw.prepare(`
      INSERT INTO entries(entry_key, entry_id, session_id, parent_id, entry_type, role,
        created_at, content_hash, searchable_text, token_estimate, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("s1:e1", "e1", "s1", null, "message", "user", 1, "k".repeat(64), "alpha beta gamma", 5, 2);
    raw.prepare(`
      INSERT INTO entries_fts(searchable_text, entry_key, entry_id, session_id)
      VALUES (?, ?, ?, ?)
    `).run("alpha beta gamma", "s1:e1", "e1", "s1");
    raw.prepare("INSERT INTO project_states(project_path, dirty, changed_files_json, indexed_at) VALUES (?, 0, '[]', ?)")
      .run("/x", 1);
    raw.prepare(`
      INSERT INTO project_files(
        project_path, file_path, content_hash, size_bytes, mtime_ms,
        language, modified, tracked, status, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 1, 'current', ?)
    `).run("/x", "a.ts", "f".repeat(64), 24, 1, "typescript", 2);
    raw.prepare(`
      INSERT INTO project_snippets(snippet_id, project_path, file_path, file_hash,
        start_line, end_line, content, symbols, token_estimate, stale, indexed_at)
      VALUES (?, ?, ?, ?, 1, 1, ?, ?, 5, 0, ?)
    `).run("p1", "/x", "a.ts", "f".repeat(64), "export const x = 1", '["x"]', 2);
    raw.prepare(`
      INSERT INTO project_snippets_fts(content, file_path, symbols, snippet_id, project_path)
      VALUES (?, ?, ?, ?, ?)
    `).run("export const x = 1", "a.ts", "x", "p1", "/x");
    raw.close();

    const { raw: upgraded } = openRepositoriesWith(path);

    expect((upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version)
      .toBe(CURRENT_SCHEMA_VERSION);
    const counts = ftsCounts(upgraded);
    expect(counts.entries).toBe(1);
    expect(counts.keys).toBe(1);
    expect(counts.snippets).toBe(1);
    expect(counts.snippetKeys).toBe(1);

    // The mapping points at the surviving FTS row.
    const mapping = upgraded.prepare("SELECT fts_rowid FROM entries_fts_keys WHERE entry_key = ?")
      .get("s1:e1") as { fts_rowid: number };
    const rowid = upgraded.prepare("SELECT rowid FROM entries_fts WHERE entry_key = ?")
      .get("s1:e1") as { rowid: number };
    expect(mapping.fts_rowid).toBe(rowid.rowid);

    // Search behavior is unchanged: terms that only appear in entry_key stay non-searchable.
    const keyOnly = upgraded.prepare("SELECT count(*) AS c FROM entries_fts WHERE entries_fts MATCH 'zz9e1'")
      .get() as { c: number };
    expect(keyOnly.c).toBe(0);
    upgraded.close();
  });

  it("keeps keys consistent across rebuilds and stale-row cleanup", () => {
    const { raw, sessionIndex } = openRepositories();
    const sessionFile = join("/work", "session.jsonl");

    sessionIndex.rebuild(
      identity("s1", sessionFile),
      [entry(1, "first message content"), entry(2, "second message content")],
      checkpoint("s1", sessionFile, 0),
    );
    let counts = ftsCounts(raw);
    expect(counts.entries).toBe(2);
    expect(counts.keys).toBe(2);

    // Re-indexing existing keys replaces FTS rows instead of duplicating them.
    sessionIndex.rebuild(
      identity("s1", sessionFile),
      [entry(1, "first message content"), entry(2, "second message content"), entry(3, "third message content")],
      checkpoint("s1", sessionFile, 0),
    );
    counts = ftsCounts(raw);
    expect(counts.entries).toBe(3);
    expect(counts.keys).toBe(3);

    // Stale-row cleanup (entry removed from a rebuild) clears FTS + keys together.
    sessionIndex.rebuild(
      identity("s1", sessionFile),
      [entry(2, "second message content"), entry(3, "third message content")],
      checkpoint("s1", sessionFile, 0),
    );
    counts = ftsCounts(raw);
    expect(counts.entries).toBe(2);
    expect(counts.keys).toBe(2);
    expect(
      (raw.prepare("SELECT count(*) AS c FROM entries WHERE entry_key = ?").get("s1:e1") as { c: number }).c,
    ).toBe(0);

    // Search still finds the surviving rows.
    const search = sessionIndex.searchFts("s1", "second", 10);
    expect(search.length).toBe(1);
    expect(search[0]?.entryId).toBe("e2");
    raw.close();
  });

  it("keeps snippet keys consistent across replaceFile and clearProject", () => {
    const { raw, projectKnowledge } = openRepositories();
    raw.prepare("INSERT INTO project_states(project_path, dirty, changed_files_json, indexed_at) VALUES (?, 0, '[]', ?)")
      .run("/p", 1);
    const snippet = (id: string, content: string): StoredProjectSnippet => ({
      snippetId: id,
      projectPath: "/p",
      filePath: "src/a.ts",
      fileHash: "f".repeat(64),
      startLine: 1,
      endLine: 1,
      content,
      symbols: ["x"],
      tokenEstimate: 5,
      stale: false,
      indexedAt: 1,
      chunkKind: "text",
    });
    const file = {
      projectPath: "/p",
      filePath: "src/a.ts",
      contentHash: "f".repeat(64),
      sizeBytes: 10,
      mtimeMs: 1,
      language: "typescript",
      gitCommit: undefined,
      modified: false,
      tracked: true,
      status: "current" as const,
      indexedAt: 1,
    };

    projectKnowledge.replaceFile(file, [snippet("p1", "alpha content one")]);
    expect(ftsCounts(raw).snippets).toBe(1);
    expect(ftsCounts(raw).snippetKeys).toBe(1);

    projectKnowledge.replaceFile(file, [snippet("p1", "alpha content two"), snippet("p2", "beta content")]);
    const counts = ftsCounts(raw);
    expect(counts.snippets).toBe(2);
    expect(counts.snippetKeys).toBe(2);

    const search = projectKnowledge.searchExact("/p", "alpha", 10);
    expect(search.length).toBeGreaterThan(0);

    projectKnowledge.clearProject("/p");
    const cleared = ftsCounts(raw);
    expect(cleared.snippets).toBe(0);
    expect(cleared.snippetKeys).toBe(0);
    raw.close();
  });
});

function openRepositoriesWith(path: string): { raw: DatabaseSync } {
  const upgraded = new DatabaseSync(path);
  applyMigrations(upgraded);
  return { raw: upgraded };
}
