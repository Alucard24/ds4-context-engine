import type { DatabaseSync, StatementSync } from "node:sqlite";

export interface StoredSessionEntry {
  entryKey: string;
  entryId: string;
  sessionId: string;
  parentId: string | null;
  entryType: string;
  role?: string;
  createdAt?: number;
  contentHash: string;
  searchableText: string;
  tokenEstimate: number;
  indexedAt: number;
}

export interface SessionIdentity {
  sessionId: string;
  sessionFile: string;
  projectPath?: string;
  indexedAt: number;
}

export interface SessionIndexCheckpointInput {
  sessionId: string;
  sessionFile: string;
  headerHash: string;
  fileSize: number;
  fileMtimeMs: number;
  checkpointOffset: number;
  checkpointHashStart: number;
  checkpointHash?: string;
  malformedLines: number;
  indexedAt: number;
}

export interface SessionIndexState extends SessionIndexCheckpointInput {
  indexedEntries: number;
}

export interface SessionIndexStats {
  entries: number;
  estimatedTokens: number;
}

export interface IndexWriteResult {
  inserted: number;
  unchanged: number;
  totalEntries: number;
}

export class AppendOnlyEntryChangedError extends Error {
  constructor(readonly entryId: string) {
    super(`Entry ${entryId} changed during append-only indexing`);
    this.name = "AppendOnlyEntryChangedError";
  }
}

export interface EntrySearchResult {
  entryId: string;
  parentId: string | null;
  entryType: string;
  role?: string;
  createdAt?: number;
  searchableText: string;
  tokenEstimate: number;
  contentHash: string;
  score?: number;
}

export interface SessionEmbeddingSources {
  rows: EntrySearchResult[];
  total: number;
}

interface StateRow {
  session_id: string;
  session_file: string;
  header_hash: string;
  file_size: number;
  file_mtime_ms: number;
  checkpoint_offset: number;
  checkpoint_hash_start: number;
  checkpoint_hash: string | null;
  indexed_entries: number;
  malformed_lines: number;
  indexed_at: number;
}

interface SearchRow {
  entry_id: string;
  parent_id: string | null;
  entry_type: string;
  role: string | null;
  created_at: number | null;
  searchable_text: string | null;
  token_estimate: number | null;
  content_hash: string;
  score?: number;
}

function runTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

export class SessionIndexRepository {
  private readonly upsertSessionStatement: StatementSync;
  private readonly insertEntryStatement: StatementSync;
  private readonly insertFtsStatement: StatementSync;
  private readonly deleteFtsEntryStatement: StatementSync;
  private readonly existingHashStatement: StatementSync;
  private readonly upsertStateStatement: StatementSync;

  constructor(private readonly database: DatabaseSync) {
    this.upsertSessionStatement = database.prepare(`
      INSERT INTO sessions(session_id, session_file, project_path, indexed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        session_file = excluded.session_file,
        project_path = excluded.project_path,
        indexed_at = excluded.indexed_at
    `);
    this.insertEntryStatement = database.prepare(`
      INSERT INTO entries(
        entry_key, entry_id, session_id, parent_id, entry_type, role,
        created_at, content_hash, searchable_text, token_estimate, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entry_key) DO UPDATE SET
        parent_id = excluded.parent_id,
        entry_type = excluded.entry_type,
        role = excluded.role,
        created_at = excluded.created_at,
        content_hash = excluded.content_hash,
        searchable_text = excluded.searchable_text,
        token_estimate = excluded.token_estimate,
        indexed_at = excluded.indexed_at
    `);
    this.insertFtsStatement = database.prepare(`
      INSERT INTO entries_fts(searchable_text, entry_key, entry_id, session_id)
      VALUES (?, ?, ?, ?)
    `);
    this.deleteFtsEntryStatement = database.prepare("DELETE FROM entries_fts WHERE entry_key = ?");
    this.existingHashStatement = database.prepare(
      "SELECT content_hash FROM entries WHERE entry_key = ? AND session_id = ?",
    );
    this.upsertStateStatement = database.prepare(`
      INSERT INTO session_index_state(
        session_id, session_file, header_hash, file_size, file_mtime_ms,
        checkpoint_offset, checkpoint_hash_start, checkpoint_hash,
        indexed_entries, malformed_lines, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        session_file = excluded.session_file,
        header_hash = excluded.header_hash,
        file_size = excluded.file_size,
        file_mtime_ms = excluded.file_mtime_ms,
        checkpoint_offset = excluded.checkpoint_offset,
        checkpoint_hash_start = excluded.checkpoint_hash_start,
        checkpoint_hash = excluded.checkpoint_hash,
        indexed_entries = excluded.indexed_entries,
        malformed_lines = excluded.malformed_lines,
        indexed_at = excluded.indexed_at
    `);
  }

  getState(sessionId: string): SessionIndexState | undefined {
    const row = this.database.prepare(`
      SELECT session_id, session_file, header_hash, file_size, file_mtime_ms,
        checkpoint_offset, checkpoint_hash_start, checkpoint_hash,
        indexed_entries, malformed_lines, indexed_at
      FROM session_index_state
      WHERE session_id = ?
    `).get(sessionId) as unknown as StateRow | undefined;
    if (!row) return undefined;

    return {
      sessionId: row.session_id,
      sessionFile: row.session_file,
      headerHash: row.header_hash,
      fileSize: row.file_size,
      fileMtimeMs: row.file_mtime_ms,
      checkpointOffset: row.checkpoint_offset,
      checkpointHashStart: row.checkpoint_hash_start,
      ...(row.checkpoint_hash ? { checkpointHash: row.checkpoint_hash } : {}),
      indexedEntries: row.indexed_entries,
      malformedLines: row.malformed_lines,
      indexedAt: row.indexed_at,
    };
  }

  upsertSession(identity: SessionIdentity): void {
    this.upsertSessionStatement.run(
      identity.sessionId,
      identity.sessionFile,
      identity.projectPath ?? null,
      identity.indexedAt,
    );
  }

  rebuild(
    identity: SessionIdentity,
    entries: readonly StoredSessionEntry[],
    checkpoint: SessionIndexCheckpointInput,
  ): IndexWriteResult {
    return runTransaction(this.database, () => {
      this.upsertSession(identity);
      this.database.exec(`
        CREATE TEMP TABLE IF NOT EXISTS ds4_seen_entries (
          entry_key TEXT PRIMARY KEY
        ) WITHOUT ROWID;
        DELETE FROM ds4_seen_entries;
      `);
      const markSeen = this.database.prepare("INSERT INTO ds4_seen_entries(entry_key) VALUES (?)");

      for (const entry of entries) {
        markSeen.run(entry.entryKey);
        this.writeEntry(entry);
      }

      this.database.prepare(`
        DELETE FROM entries_fts
        WHERE session_id = ?
          AND entry_key NOT IN (SELECT entry_key FROM ds4_seen_entries)
      `).run(identity.sessionId);
      this.database.prepare(`
        DELETE FROM entries
        WHERE session_id = ?
          AND entry_key NOT IN (SELECT entry_key FROM ds4_seen_entries)
      `).run(identity.sessionId);

      this.writeState(checkpoint, entries.length);
      return { inserted: entries.length, unchanged: 0, totalEntries: entries.length };
    });
  }

  append(
    identity: SessionIdentity,
    entries: readonly StoredSessionEntry[],
    checkpoint: SessionIndexCheckpointInput,
  ): IndexWriteResult {
    return runTransaction(this.database, () => {
      this.upsertSession(identity);
      let inserted = 0;
      let unchanged = 0;

      for (const entry of entries) {
        const existing = this.existingHashStatement.get(entry.entryKey, entry.sessionId) as unknown as
          | { content_hash: string }
          | undefined;
        if (existing) {
          if (existing.content_hash !== entry.contentHash) {
            throw new AppendOnlyEntryChangedError(entry.entryId);
          }
          unchanged++;
          continue;
        }
        this.writeEntry(entry);
        inserted++;
      }

      const totalEntries = this.countEntries(identity.sessionId);
      this.writeState(checkpoint, totalEntries);
      return { inserted, unchanged, totalEntries };
    });
  }

  hasEntry(sessionId: string, entryId: string): boolean {
    const row = this.database.prepare(
      "SELECT 1 AS found FROM entries WHERE entry_key = ? AND session_id = ?",
    ).get(`${sessionId}:${entryId}`, sessionId);
    return row !== undefined;
  }

  getStats(sessionId: string): SessionIndexStats {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS entries, COALESCE(SUM(token_estimate), 0) AS estimated_tokens
      FROM entries
      WHERE session_id = ?
    `).get(sessionId) as unknown as { entries: number; estimated_tokens: number };
    return { entries: row.entries, estimatedTokens: row.estimated_tokens };
  }

  searchExact(sessionId: string, phrase: string, limit: number): EntrySearchResult[] {
    const rows = this.database.prepare(`
      SELECT entry_id, parent_id, entry_type, role, created_at,
        searchable_text, token_estimate, content_hash
      FROM entries
      WHERE session_id = ? AND instr(searchable_text, ?) > 0
      ORDER BY created_at DESC, entry_id DESC
      LIMIT ?
    `).all(sessionId, phrase, limit) as unknown as SearchRow[];
    return rows.map(toSearchResult);
  }

  searchFts(sessionId: string, query: string, limit: number): EntrySearchResult[] {
    const rows = this.database.prepare(`
      SELECT entry.entry_id, entry.parent_id, entry.entry_type, entry.role,
        entry.created_at, entry.searchable_text, entry.token_estimate,
        entry.content_hash, bm25(entries_fts) AS score
      FROM entries_fts
      JOIN entries AS entry ON entry.entry_key = entries_fts.entry_key
      WHERE entries_fts MATCH ? AND entries_fts.session_id = ?
      ORDER BY score, entry.created_at DESC
      LIMIT ?
    `).all(query, sessionId, limit) as unknown as SearchRow[];
    return rows.map(toSearchResult);
  }

  listEmbeddingSources(sessionId: string, limit: number): SessionEmbeddingSources {
    const count = this.database.prepare(`
      SELECT count(*) AS count FROM entries
      WHERE session_id = ? AND entry_type IN ('message', 'custom_message')
        AND searchable_text IS NOT NULL AND length(trim(searchable_text)) > 0
    `).get(sessionId) as { count: number };
    const rows = this.database.prepare(`
      SELECT entry_id, parent_id, entry_type, role, created_at,
        searchable_text, token_estimate, content_hash
      FROM entries
      WHERE session_id = ? AND entry_type IN ('message', 'custom_message')
        AND searchable_text IS NOT NULL AND length(trim(searchable_text)) > 0
      ORDER BY entry_key
      LIMIT ?
    `).all(sessionId, limit) as unknown as SearchRow[];
    return { rows: rows.map(toSearchResult), total: count.count };
  }

  getEntriesByIds(sessionId: string, entryIds: readonly string[]): EntrySearchResult[] {
    const ids = [...new Set(entryIds)].slice(0, 500);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.database.prepare(`
      SELECT entry_id, parent_id, entry_type, role, created_at,
        searchable_text, token_estimate, content_hash
      FROM entries
      WHERE session_id = ? AND entry_id IN (${placeholders})
      ORDER BY entry_id
    `).all(sessionId, ...ids) as unknown as SearchRow[];
    return rows.map(toSearchResult);
  }

  private writeEntry(entry: StoredSessionEntry): void {
    this.insertEntryStatement.run(
      entry.entryKey,
      entry.entryId,
      entry.sessionId,
      entry.parentId,
      entry.entryType,
      entry.role ?? null,
      entry.createdAt ?? null,
      entry.contentHash,
      entry.searchableText,
      entry.tokenEstimate,
      entry.indexedAt,
    );
    this.deleteFtsEntryStatement.run(entry.entryKey);
    this.insertFtsStatement.run(entry.searchableText, entry.entryKey, entry.entryId, entry.sessionId);
  }

  private writeState(checkpoint: SessionIndexCheckpointInput, indexedEntries: number): void {
    this.upsertStateStatement.run(
      checkpoint.sessionId,
      checkpoint.sessionFile,
      checkpoint.headerHash,
      checkpoint.fileSize,
      checkpoint.fileMtimeMs,
      checkpoint.checkpointOffset,
      checkpoint.checkpointHashStart,
      checkpoint.checkpointHash ?? null,
      indexedEntries,
      checkpoint.malformedLines,
      checkpoint.indexedAt,
    );
  }

  private countEntries(sessionId: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM entries WHERE session_id = ?")
      .get(sessionId) as unknown as { count: number };
    return row.count;
  }
}

function toSearchResult(row: SearchRow): EntrySearchResult {
  return {
    entryId: row.entry_id,
    parentId: row.parent_id,
    entryType: row.entry_type,
    ...(row.role ? { role: row.role } : {}),
    ...(row.created_at !== null ? { createdAt: row.created_at } : {}),
    searchableText: row.searchable_text ?? "",
    tokenEstimate: row.token_estimate ?? 0,
    contentHash: row.content_hash,
    ...(row.score !== undefined ? { score: row.score } : {}),
  };
}
