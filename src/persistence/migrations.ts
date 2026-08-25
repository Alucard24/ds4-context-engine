import type { DatabaseSync } from "node:sqlite";
import { sha256 } from "../shared/hash.ts";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  appliedAt: number;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial-derived-store",
    sql: `
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        session_file TEXT NOT NULL,
        project_path TEXT,
        indexed_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE entries (
        entry_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        parent_id TEXT,
        entry_type TEXT NOT NULL,
        role TEXT,
        created_at INTEGER,
        content_hash TEXT NOT NULL,
        searchable_text TEXT,
        token_estimate INTEGER,
        indexed_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX entries_session_parent_idx ON entries(session_id, parent_id);
      CREATE INDEX entries_session_created_idx ON entries(session_id, created_at);
      CREATE INDEX entries_content_hash_idx ON entries(content_hash);

      CREATE VIRTUAL TABLE entries_fts USING fts5(
        searchable_text,
        entry_id UNINDEXED,
        session_id UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TABLE summaries (
        summary_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        summary_kind TEXT NOT NULL,
        content TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        validation_status TEXT NOT NULL,
        provider TEXT,
        model TEXT
      ) STRICT;
      CREATE INDEX summaries_session_created_idx ON summaries(session_id, created_at);

      CREATE TABLE summary_sources (
        summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
        entry_id TEXT NOT NULL REFERENCES entries(entry_id) ON DELETE CASCADE,
        PRIMARY KEY(summary_id, entry_id)
      ) WITHOUT ROWID, STRICT;

      CREATE TABLE summary_edges (
        parent_summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
        child_summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
        PRIMARY KEY(parent_summary_id, child_summary_id),
        CHECK(parent_summary_id <> child_summary_id)
      ) WITHOUT ROWID, STRICT;

      CREATE TABLE memory_items (
        memory_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE,
        project_path TEXT,
        claim TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        superseded_by TEXT REFERENCES memory_items(memory_id),
        CHECK(scope IN ('session', 'project')),
        CHECK(status IN ('active', 'superseded', 'invalid', 'expired'))
      ) STRICT;

      CREATE TABLE memory_sources (
        memory_id TEXT NOT NULL REFERENCES memory_items(memory_id) ON DELETE CASCADE,
        entry_id TEXT NOT NULL REFERENCES entries(entry_id) ON DELETE CASCADE,
        PRIMARY KEY(memory_id, entry_id)
      ) WITHOUT ROWID, STRICT;

      CREATE VIRTUAL TABLE memory_fts USING fts5(
        claim,
        memory_id UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TABLE pins (
        pin_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE,
        project_path TEXT,
        content TEXT NOT NULL,
        source_entry_id TEXT REFERENCES entries(entry_id) ON DELETE SET NULL,
        source_file TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        CHECK(scope IN ('session', 'branch', 'project')),
        CHECK(status IN ('active', 'superseded', 'deleted'))
      ) STRICT;

      CREATE TABLE context_manifests (
        manifest_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        estimated_tokens INTEGER,
        actual_tokens INTEGER,
        prompt_hash TEXT,
        policy_version TEXT NOT NULL,
        planner_version TEXT NOT NULL,
        manifest_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX context_manifests_session_created_idx
        ON context_manifests(session_id, created_at DESC);

      CREATE TABLE artifacts (
        artifact_id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL UNIQUE,
        file_path TEXT NOT NULL,
        mime_type TEXT,
        size_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        source_entry_id TEXT REFERENCES entries(entry_id) ON DELETE SET NULL
      ) STRICT;

      CREATE TABLE token_calibration (
        calibration_id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        estimated INTEGER NOT NULL,
        actual INTEGER NOT NULL,
        ratio REAL NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX token_calibration_model_created_idx
        ON token_calibration(provider, model, created_at DESC);
    `,
  },
  {
    version: 2,
    name: "session-index-checkpoints-and-scoped-entry-keys",
    sql: `
      CREATE TABLE entries_v2 (
        entry_key TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        parent_id TEXT,
        entry_type TEXT NOT NULL,
        role TEXT,
        created_at INTEGER,
        content_hash TEXT NOT NULL,
        searchable_text TEXT,
        token_estimate INTEGER,
        indexed_at INTEGER NOT NULL,
        UNIQUE(session_id, entry_id)
      ) STRICT;
      INSERT INTO entries_v2(
        entry_key, entry_id, session_id, parent_id, entry_type, role,
        created_at, content_hash, searchable_text, token_estimate, indexed_at
      )
      SELECT
        session_id || ':' || entry_id, entry_id, session_id, parent_id, entry_type, role,
        created_at, content_hash, searchable_text, token_estimate, indexed_at
      FROM entries;

      CREATE TABLE summary_sources_v2 (
        summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
        entry_key TEXT NOT NULL REFERENCES entries_v2(entry_key) ON DELETE CASCADE,
        PRIMARY KEY(summary_id, entry_key)
      ) WITHOUT ROWID, STRICT;
      INSERT INTO summary_sources_v2(summary_id, entry_key)
      SELECT source.summary_id, entry.session_id || ':' || source.entry_id
      FROM summary_sources AS source
      JOIN entries AS entry ON entry.entry_id = source.entry_id;

      CREATE TABLE memory_sources_v2 (
        memory_id TEXT NOT NULL REFERENCES memory_items(memory_id) ON DELETE CASCADE,
        entry_key TEXT NOT NULL REFERENCES entries_v2(entry_key) ON DELETE CASCADE,
        PRIMARY KEY(memory_id, entry_key)
      ) WITHOUT ROWID, STRICT;
      INSERT INTO memory_sources_v2(memory_id, entry_key)
      SELECT source.memory_id, entry.session_id || ':' || source.entry_id
      FROM memory_sources AS source
      JOIN entries AS entry ON entry.entry_id = source.entry_id;

      CREATE TABLE pins_v2 (
        pin_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE,
        project_path TEXT,
        content TEXT NOT NULL,
        source_entry_key TEXT REFERENCES entries_v2(entry_key) ON DELETE SET NULL,
        source_entry_id TEXT,
        source_file TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        CHECK(scope IN ('session', 'branch', 'project')),
        CHECK(status IN ('active', 'superseded', 'deleted'))
      ) STRICT;
      INSERT INTO pins_v2(
        pin_id, scope, session_id, project_path, content, source_entry_key,
        source_entry_id, source_file, status, created_at
      )
      SELECT
        pin.pin_id, pin.scope, pin.session_id, pin.project_path, pin.content,
        (SELECT entry.session_id || ':' || entry.entry_id FROM entries AS entry
          WHERE entry.entry_id = pin.source_entry_id LIMIT 1),
        pin.source_entry_id, pin.source_file, pin.status, pin.created_at
      FROM pins AS pin;

      CREATE TABLE artifacts_v2 (
        artifact_id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL UNIQUE,
        file_path TEXT NOT NULL,
        mime_type TEXT,
        size_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        source_entry_key TEXT REFERENCES entries_v2(entry_key) ON DELETE SET NULL,
        source_entry_id TEXT
      ) STRICT;
      INSERT INTO artifacts_v2(
        artifact_id, sha256, file_path, mime_type, size_bytes, created_at,
        source_entry_key, source_entry_id
      )
      SELECT
        artifact.artifact_id, artifact.sha256, artifact.file_path, artifact.mime_type,
        artifact.size_bytes, artifact.created_at,
        (SELECT entry.session_id || ':' || entry.entry_id FROM entries AS entry
          WHERE entry.entry_id = artifact.source_entry_id LIMIT 1),
        artifact.source_entry_id
      FROM artifacts AS artifact;

      DROP TABLE summary_sources;
      DROP TABLE memory_sources;
      DROP TABLE pins;
      DROP TABLE artifacts;
      DROP TABLE entries_fts;
      DROP TABLE entries;

      ALTER TABLE entries_v2 RENAME TO entries;
      ALTER TABLE summary_sources_v2 RENAME TO summary_sources;
      ALTER TABLE memory_sources_v2 RENAME TO memory_sources;
      ALTER TABLE pins_v2 RENAME TO pins;
      ALTER TABLE artifacts_v2 RENAME TO artifacts;

      CREATE INDEX entries_session_parent_idx ON entries(session_id, parent_id);
      CREATE INDEX entries_session_created_idx ON entries(session_id, created_at);
      CREATE INDEX entries_content_hash_idx ON entries(content_hash);
      CREATE VIRTUAL TABLE entries_fts USING fts5(
        searchable_text,
        entry_key UNINDEXED,
        entry_id UNINDEXED,
        session_id UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      INSERT INTO entries_fts(searchable_text, entry_key, entry_id, session_id)
      SELECT COALESCE(searchable_text, ''), entry_key, entry_id, session_id FROM entries;

      CREATE TABLE session_index_state (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        session_file TEXT NOT NULL,
        header_hash TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        file_mtime_ms REAL NOT NULL,
        checkpoint_offset INTEGER NOT NULL,
        checkpoint_line_start INTEGER NOT NULL,
        checkpoint_hash TEXT,
        indexed_entries INTEGER NOT NULL,
        malformed_lines INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 3,
    name: "bounded-checkpoint-fingerprint",
    sql: `
      ALTER TABLE session_index_state
        RENAME COLUMN checkpoint_line_start TO checkpoint_hash_start;
    `,
  },
  {
    version: 4,
    name: "observer-context-manifest-columns",
    sql: `
      ALTER TABLE context_manifests ADD COLUMN branch_leaf_id TEXT;
      ALTER TABLE context_manifests ADD COLUMN context_window INTEGER;
      ALTER TABLE context_manifests ADD COLUMN output_reserve INTEGER;
      ALTER TABLE context_manifests ADD COLUMN hard_input_limit INTEGER;
      ALTER TABLE context_manifests ADD COLUMN target_input_tokens INTEGER;
      ALTER TABLE context_manifests ADD COLUMN pi_reported_tokens INTEGER;
      CREATE INDEX context_manifests_prompt_hash_idx
        ON context_manifests(prompt_hash);
    `,
  },
  {
    version: 5,
    name: "compaction-summary-lifecycle",
    sql: `
      ALTER TABLE summaries ADD COLUMN first_kept_entry_id TEXT;
      ALTER TABLE summaries ADD COLUMN tokens_before INTEGER;
      ALTER TABLE summaries ADD COLUMN compaction_reason TEXT;
      ALTER TABLE summaries ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'committed'
        CHECK(lifecycle_status IN ('prepared', 'committed', 'failed'));
      ALTER TABLE summaries ADD COLUMN pi_compaction_entry_id TEXT;
      ALTER TABLE summaries ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
      CREATE INDEX summaries_session_lifecycle_idx
        ON summaries(session_id, lifecycle_status, created_at DESC);
      CREATE UNIQUE INDEX summaries_pi_compaction_entry_idx
        ON summaries(session_id, pi_compaction_entry_id)
        WHERE pi_compaction_entry_id IS NOT NULL;
    `,
  },
  {
    version: 6,
    name: "hierarchical-summary-graph",
    sql: `
      ALTER TABLE summaries ADD COLUMN graph_level INTEGER NOT NULL DEFAULT 0
        CHECK(graph_level >= 0);
      ALTER TABLE summary_edges ADD COLUMN child_order INTEGER NOT NULL DEFAULT 0
        CHECK(child_order >= 0);
      CREATE INDEX summaries_session_kind_level_idx
        ON summaries(session_id, summary_kind, graph_level, created_at DESC);
      CREATE INDEX summary_edges_child_idx
        ON summary_edges(child_summary_id, parent_summary_id);
    `,
  },
  {
    version: 7,
    name: "project-knowledge-index",
    sql: `
      CREATE TABLE project_states (
        project_path TEXT PRIMARY KEY,
        git_root TEXT,
        git_branch TEXT,
        git_head TEXT,
        dirty INTEGER NOT NULL CHECK(dirty IN (0, 1)),
        changed_files_json TEXT NOT NULL,
        indexed_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE project_files (
        project_path TEXT NOT NULL REFERENCES project_states(project_path) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
        mtime_ms REAL NOT NULL,
        language TEXT,
        git_commit TEXT,
        modified INTEGER NOT NULL CHECK(modified IN (0, 1)),
        tracked INTEGER NOT NULL CHECK(tracked IN (0, 1)),
        status TEXT NOT NULL CHECK(status IN ('current', 'deleted')),
        indexed_at INTEGER NOT NULL,
        PRIMARY KEY(project_path, file_path)
      ) WITHOUT ROWID, STRICT;
      CREATE INDEX project_files_hash_idx ON project_files(project_path, content_hash);
      CREATE INDEX project_files_status_idx ON project_files(project_path, status, file_path);

      CREATE TABLE project_snippets (
        snippet_id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        start_line INTEGER NOT NULL CHECK(start_line > 0),
        end_line INTEGER NOT NULL CHECK(end_line >= start_line),
        content TEXT NOT NULL,
        symbols TEXT NOT NULL,
        token_estimate INTEGER NOT NULL CHECK(token_estimate >= 0),
        stale INTEGER NOT NULL CHECK(stale IN (0, 1)),
        indexed_at INTEGER NOT NULL,
        FOREIGN KEY(project_path, file_path)
          REFERENCES project_files(project_path, file_path) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX project_snippets_file_idx
        ON project_snippets(project_path, file_path, stale, start_line);
      CREATE INDEX project_snippets_hash_idx
        ON project_snippets(project_path, file_hash, stale);

      CREATE VIRTUAL TABLE project_snippets_fts USING fts5(
        content,
        file_path,
        symbols,
        snippet_id UNINDEXED,
        project_path UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `,
  },
  {
    version: 8,
    name: "content-addressed-artifact-store",
    sql: `
      CREATE TABLE artifact_objects (
        sha256 TEXT PRIMARY KEY CHECK(length(sha256) = 64),
        file_path TEXT NOT NULL UNIQUE,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
        created_at INTEGER NOT NULL,
        last_verified_at INTEGER,
        status TEXT NOT NULL CHECK(status IN ('available', 'missing', 'corrupt'))
      ) STRICT;
      INSERT OR IGNORE INTO artifact_objects(
        sha256, file_path, mime_type, size_bytes, created_at, status
      )
      SELECT sha256, file_path, COALESCE(mime_type, 'application/octet-stream'),
        size_bytes, created_at, 'available'
      FROM artifacts;

      CREATE TABLE artifacts_v3 (
        artifact_id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL REFERENCES artifact_objects(sha256) ON DELETE RESTRICT,
        source_session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        source_entry_key TEXT NOT NULL REFERENCES entries(entry_key) ON DELETE CASCADE,
        source_entry_id TEXT NOT NULL,
        source_tool_call_id TEXT NOT NULL,
        source_tool_name TEXT NOT NULL,
        is_error INTEGER NOT NULL CHECK(is_error IN (0, 1)),
        original_chars INTEGER NOT NULL CHECK(original_chars >= 0),
        original_tokens INTEGER NOT NULL CHECK(original_tokens >= 0),
        condensed_chars INTEGER NOT NULL CHECK(condensed_chars >= 0),
        condensed_tokens INTEGER NOT NULL CHECK(condensed_tokens >= 0),
        created_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL,
        UNIQUE(source_session_id, source_entry_id, source_tool_call_id, sha256)
      ) STRICT;
      INSERT OR IGNORE INTO artifacts_v3(
        artifact_id, sha256, source_session_id, source_entry_key, source_entry_id,
        source_tool_call_id, source_tool_name, is_error, original_chars,
        original_tokens, condensed_chars, condensed_tokens, created_at, metadata_json
      )
      SELECT
        artifact.artifact_id, artifact.sha256, entry.session_id,
        artifact.source_entry_key, artifact.source_entry_id,
        'legacy', 'unknown', 0, artifact.size_bytes, 0, 0, 0,
        artifact.created_at, '{}'
      FROM artifacts AS artifact
      JOIN entries AS entry ON entry.entry_key = artifact.source_entry_key
      WHERE artifact.source_entry_key IS NOT NULL AND artifact.source_entry_id IS NOT NULL;

      DROP TABLE artifacts;
      ALTER TABLE artifacts_v3 RENAME TO artifacts;
      CREATE INDEX artifacts_session_created_idx
        ON artifacts(source_session_id, created_at DESC);
      CREATE INDEX artifacts_source_entry_idx
        ON artifacts(source_session_id, source_entry_id);
      CREATE INDEX artifacts_sha_idx ON artifacts(sha256);
    `,
  },
  {
    version: 9,
    name: "event-sourced-memory-and-pins",
    sql: `
      ALTER TABLE memory_items ADD COLUMN memory_key TEXT;
      ALTER TABLE memory_items ADD COLUMN origin_session_id TEXT
        REFERENCES sessions(session_id) ON DELETE CASCADE;
      ALTER TABLE memory_items ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE memory_items ADD COLUMN status_reason TEXT;
      ALTER TABLE memory_items ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
      CREATE INDEX memory_items_scope_status_idx
        ON memory_items(scope, session_id, project_path, status, created_at DESC);
      CREATE UNIQUE INDEX memory_items_active_key_idx
        ON memory_items(
          scope,
          COALESCE(session_id, ''),
          COALESCE(project_path, ''),
          memory_key
        )
        WHERE status = 'active' AND memory_key IS NOT NULL;

      ALTER TABLE pins ADD COLUMN branch_leaf_id TEXT;
      ALTER TABLE pins ADD COLUMN superseded_by TEXT REFERENCES pins(pin_id);
      ALTER TABLE pins ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE pins ADD COLUMN status_reason TEXT;
      ALTER TABLE pins ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
      CREATE INDEX pins_scope_status_idx
        ON pins(scope, session_id, project_path, status, created_at DESC);
      CREATE INDEX pins_branch_leaf_idx
        ON pins(session_id, branch_leaf_id, status);

      CREATE TABLE memory_mutations (
        mutation_key TEXT PRIMARY KEY REFERENCES entries(entry_key) ON DELETE CASCADE,
        mutation_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        entry_order INTEGER NOT NULL CHECK(entry_order >= 0),
        payload_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX memory_mutations_session_created_idx
        ON memory_mutations(session_id, created_at, mutation_id);

      CREATE TABLE pin_mutations (
        mutation_key TEXT PRIMARY KEY REFERENCES entries(entry_key) ON DELETE CASCADE,
        mutation_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        entry_order INTEGER NOT NULL CHECK(entry_order >= 0),
        payload_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX pin_mutations_session_created_idx
        ON pin_mutations(session_id, created_at, mutation_id);
    `,
  },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

interface MigrationRow {
  version: number;
  name: string;
  checksum: string;
  applied_at: number;
}

function migrationChecksum(migration: Migration): string {
  return sha256(`${migration.version}\n${migration.name}\n${migration.sql}`);
}

export function listAppliedMigrations(database: DatabaseSync): AppliedMigration[] {
  const rows = database
    .prepare("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version")
    .all() as unknown as MigrationRow[];

  return rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

export function applyMigrations(database: DatabaseSync, now = Date.now()): AppliedMigration[] {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);

  const applied = new Map(listAppliedMigrations(database).map((migration) => [migration.version, migration]));
  for (const existing of applied.values()) {
    const known = MIGRATIONS.find((migration) => migration.version === existing.version);
    if (!known) {
      throw new Error(`Database schema version ${existing.version} is newer than this extension supports`);
    }
    if (existing.checksum !== migrationChecksum(known)) {
      throw new Error(`Migration checksum mismatch for version ${existing.version}`);
    }
  }

  const insert = database.prepare(
    "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      insert.run(migration.version, migration.name, migrationChecksum(migration), now);
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  }

  return listAppliedMigrations(database);
}
