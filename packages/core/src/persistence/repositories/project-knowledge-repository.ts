import type { DatabaseSync } from "node:sqlite";

export interface StoredProjectState {
  projectPath: string;
  gitRoot?: string;
  gitBranch?: string;
  gitHead?: string;
  dirty: boolean;
  changedFiles: string[];
  indexedAt: number;
}

export interface StoredProjectFile {
  projectPath: string;
  filePath: string;
  contentHash: string;
  sizeBytes: number;
  mtimeMs: number;
  language?: string;
  gitCommit?: string;
  modified: boolean;
  tracked: boolean;
  status: "current" | "deleted";
  indexedAt: number;
}

export interface StoredProjectSnippet {
  snippetId: string;
  projectPath: string;
  filePath: string;
  fileHash: string;
  startLine: number;
  endLine: number;
  content: string;
  symbols: string[];
  tokenEstimate: number;
  stale: boolean;
  indexedAt: number;
  chunkKind?: "text" | "symbol";
  parserId?: string;
  symbolId?: string;
  symbolName?: string;
  qualifiedName?: string;
  symbolKind?: string;
  signature?: string;
  parentSymbol?: string;
  imports?: string[];
  references?: string[];
}

export interface ProjectSnippetSearchResult extends StoredProjectSnippet {
  language?: string;
  gitCommit?: string;
  modified: boolean;
  tracked: boolean;
  ftsRank?: number;
}

export interface ProjectIndexStats {
  files: number;
  deletedFiles: number;
  currentSnippets: number;
  staleSnippets: number;
  symbolChunks: number;
  textChunks: number;
  indexedTokens: number;
}

interface StateRow {
  project_path: string;
  git_root: string | null;
  git_branch: string | null;
  git_head: string | null;
  dirty: number;
  changed_files_json: string;
  indexed_at: number;
}

interface FileRow {
  project_path: string;
  file_path: string;
  content_hash: string;
  size_bytes: number;
  mtime_ms: number;
  language: string | null;
  git_commit: string | null;
  modified: number;
  tracked: number;
  status: "current" | "deleted";
  indexed_at: number;
}

interface SnippetRow {
  snippet_id: string;
  project_path: string;
  file_path: string;
  file_hash: string;
  start_line: number;
  end_line: number;
  content: string;
  symbols: string;
  token_estimate: number;
  stale: number;
  indexed_at: number;
  chunk_kind: "text" | "symbol";
  parser_id: string | null;
  symbol_id: string | null;
  symbol_name: string | null;
  qualified_name: string | null;
  symbol_kind: string | null;
  signature: string | null;
  parent_symbol: string | null;
  imports_json: string;
  references_json: string;
  language: string | null;
  git_commit: string | null;
  modified: number;
  tracked: number;
  fts_rank?: number;
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function mapState(row: StateRow): StoredProjectState {
  return {
    projectPath: row.project_path,
    ...(row.git_root ? { gitRoot: row.git_root } : {}),
    ...(row.git_branch ? { gitBranch: row.git_branch } : {}),
    ...(row.git_head ? { gitHead: row.git_head } : {}),
    dirty: row.dirty === 1,
    changedFiles: parseJsonArray(row.changed_files_json),
    indexedAt: row.indexed_at,
  };
}

function mapFile(row: FileRow): StoredProjectFile {
  return {
    projectPath: row.project_path,
    filePath: row.file_path,
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
    mtimeMs: row.mtime_ms,
    ...(row.language ? { language: row.language } : {}),
    ...(row.git_commit ? { gitCommit: row.git_commit } : {}),
    modified: row.modified === 1,
    tracked: row.tracked === 1,
    status: row.status,
    indexedAt: row.indexed_at,
  };
}

function mapSnippet(row: SnippetRow): ProjectSnippetSearchResult {
  return {
    snippetId: row.snippet_id,
    projectPath: row.project_path,
    filePath: row.file_path,
    fileHash: row.file_hash,
    startLine: row.start_line,
    endLine: row.end_line,
    content: row.content,
    symbols: parseJsonArray(row.symbols),
    tokenEstimate: row.token_estimate,
    stale: row.stale === 1,
    indexedAt: row.indexed_at,
    chunkKind: row.chunk_kind,
    ...(row.parser_id ? { parserId: row.parser_id } : {}),
    ...(row.symbol_id ? { symbolId: row.symbol_id } : {}),
    ...(row.symbol_name ? { symbolName: row.symbol_name } : {}),
    ...(row.qualified_name ? { qualifiedName: row.qualified_name } : {}),
    ...(row.symbol_kind ? { symbolKind: row.symbol_kind } : {}),
    ...(row.signature ? { signature: row.signature } : {}),
    ...(row.parent_symbol ? { parentSymbol: row.parent_symbol } : {}),
    imports: parseJsonArray(row.imports_json),
    references: parseJsonArray(row.references_json),
    ...(row.language ? { language: row.language } : {}),
    ...(row.git_commit ? { gitCommit: row.git_commit } : {}),
    modified: row.modified === 1,
    tracked: row.tracked === 1,
    ...(row.fts_rank !== undefined ? { ftsRank: row.fts_rank } : {}),
  };
}

const SEARCH_SELECT = `
  SELECT
    snippet.snippet_id, snippet.project_path, snippet.file_path, snippet.file_hash,
    snippet.start_line, snippet.end_line, snippet.content, snippet.symbols,
    snippet.token_estimate, snippet.stale, snippet.indexed_at,
    snippet.chunk_kind, snippet.parser_id, snippet.symbol_id, snippet.symbol_name,
    snippet.qualified_name, snippet.symbol_kind, snippet.signature, snippet.parent_symbol,
    snippet.imports_json, snippet.references_json,
    file.language, file.git_commit, file.modified, file.tracked
  FROM project_snippets AS snippet
  JOIN project_files AS file
    ON file.project_path = snippet.project_path AND file.file_path = snippet.file_path
`;

export class ProjectKnowledgeRepository {
  constructor(private readonly database: DatabaseSync) {}

  getState(projectPath: string): StoredProjectState | undefined {
    const row = this.database.prepare(`
      SELECT project_path, git_root, git_branch, git_head, dirty, changed_files_json, indexed_at
      FROM project_states WHERE project_path = ?
    `).get(projectPath) as StateRow | undefined;
    return row ? mapState(row) : undefined;
  }

  saveState(state: StoredProjectState): void {
    this.database.prepare(`
      INSERT INTO project_states(
        project_path, git_root, git_branch, git_head, dirty, changed_files_json, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_path) DO UPDATE SET
        git_root = excluded.git_root,
        git_branch = excluded.git_branch,
        git_head = excluded.git_head,
        dirty = excluded.dirty,
        changed_files_json = excluded.changed_files_json,
        indexed_at = excluded.indexed_at
    `).run(
      state.projectPath,
      state.gitRoot ?? null,
      state.gitBranch ?? null,
      state.gitHead ?? null,
      state.dirty ? 1 : 0,
      JSON.stringify(state.changedFiles),
      state.indexedAt,
    );
  }

  listFiles(projectPath: string): StoredProjectFile[] {
    const rows = this.database.prepare(`
      SELECT project_path, file_path, content_hash, size_bytes, mtime_ms, language,
        git_commit, modified, tracked, status, indexed_at
      FROM project_files WHERE project_path = ? ORDER BY file_path
    `).all(projectPath) as unknown as FileRow[];
    return rows.map(mapFile);
  }

  getFile(projectPath: string, filePath: string): StoredProjectFile | undefined {
    const row = this.database.prepare(`
      SELECT project_path, file_path, content_hash, size_bytes, mtime_ms, language,
        git_commit, modified, tracked, status, indexed_at
      FROM project_files WHERE project_path = ? AND file_path = ?
    `).get(projectPath, filePath) as FileRow | undefined;
    return row ? mapFile(row) : undefined;
  }

  replaceFile(file: StoredProjectFile, snippets: readonly StoredProjectSnippet[]): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO project_files(
          project_path, file_path, content_hash, size_bytes, mtime_ms, language,
          git_commit, modified, tracked, status, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?)
        ON CONFLICT(project_path, file_path) DO UPDATE SET
          content_hash = excluded.content_hash,
          size_bytes = excluded.size_bytes,
          mtime_ms = excluded.mtime_ms,
          language = excluded.language,
          git_commit = excluded.git_commit,
          modified = excluded.modified,
          tracked = excluded.tracked,
          status = 'current',
          indexed_at = excluded.indexed_at
      `).run(
        file.projectPath,
        file.filePath,
        file.contentHash,
        file.sizeBytes,
        file.mtimeMs,
        file.language ?? null,
        file.gitCommit ?? null,
        file.modified ? 1 : 0,
        file.tracked ? 1 : 0,
        file.indexedAt,
      );
      this.database.prepare(`
        UPDATE project_snippets SET stale = 1
        WHERE project_path = ? AND file_path = ? AND stale = 0
      `).run(file.projectPath, file.filePath);

      const removeFts = this.database.prepare(
        "DELETE FROM project_snippets_fts WHERE snippet_id = ? AND project_path = ?",
      );
      const upsertSnippet = this.database.prepare(`
        INSERT INTO project_snippets(
          snippet_id, project_path, file_path, file_hash, start_line, end_line,
          content, symbols, token_estimate, stale, indexed_at, chunk_kind, parser_id,
          symbol_id, symbol_name, qualified_name, symbol_kind, signature, parent_symbol,
          imports_json, references_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(snippet_id) DO UPDATE SET
          content = excluded.content,
          symbols = excluded.symbols,
          token_estimate = excluded.token_estimate,
          stale = 0,
          indexed_at = excluded.indexed_at,
          chunk_kind = excluded.chunk_kind,
          parser_id = excluded.parser_id,
          symbol_id = excluded.symbol_id,
          symbol_name = excluded.symbol_name,
          qualified_name = excluded.qualified_name,
          symbol_kind = excluded.symbol_kind,
          signature = excluded.signature,
          parent_symbol = excluded.parent_symbol,
          imports_json = excluded.imports_json,
          references_json = excluded.references_json
      `);
      const insertFts = this.database.prepare(`
        INSERT INTO project_snippets_fts(
          content, file_path, symbols, snippet_id, project_path
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const snippet of snippets) {
        removeFts.run(snippet.snippetId, snippet.projectPath);
        upsertSnippet.run(
          snippet.snippetId,
          snippet.projectPath,
          snippet.filePath,
          snippet.fileHash,
          snippet.startLine,
          snippet.endLine,
          snippet.content,
          JSON.stringify(snippet.symbols),
          snippet.tokenEstimate,
          snippet.indexedAt,
          snippet.chunkKind ?? "text",
          snippet.parserId ?? null,
          snippet.symbolId ?? null,
          snippet.symbolName ?? null,
          snippet.qualifiedName ?? null,
          snippet.symbolKind ?? null,
          snippet.signature ?? null,
          snippet.parentSymbol ?? null,
          JSON.stringify(snippet.imports ?? []),
          JSON.stringify(snippet.references ?? []),
        );
        insertFts.run(
          snippet.content,
          snippet.filePath,
          [...snippet.symbols, ...(snippet.imports ?? []), ...(snippet.references ?? [])].join(" "),
          snippet.snippetId,
          snippet.projectPath,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  markDeleted(projectPath: string, filePaths: readonly string[], indexedAt: number): void {
    if (filePaths.length === 0) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const markFile = this.database.prepare(`
        UPDATE project_files SET status = 'deleted', modified = 1, indexed_at = ?
        WHERE project_path = ? AND file_path = ?
      `);
      const markSnippets = this.database.prepare(`
        UPDATE project_snippets SET stale = 1
        WHERE project_path = ? AND file_path = ? AND stale = 0
      `);
      for (const path of filePaths) {
        markFile.run(indexedAt, projectPath, path);
        markSnippets.run(projectPath, path);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  searchExactPath(projectPath: string, path: string, limit: number): ProjectSnippetSearchResult[] {
    const rows = this.database.prepare(`${SEARCH_SELECT}
      WHERE snippet.project_path = ? AND snippet.stale = 0 AND file.status = 'current'
        AND (snippet.file_path = ? COLLATE NOCASE
          OR substr(snippet.file_path, -(length(?) + 1)) = ('/' || ?) COLLATE NOCASE)
      ORDER BY CASE WHEN snippet.file_path = ? COLLATE NOCASE THEN 0 ELSE 1 END,
        file.modified DESC, snippet.start_line, snippet.snippet_id
      LIMIT ?
    `).all(projectPath, path, path, path, path, limit) as unknown as SnippetRow[];
    return rows.map(mapSnippet);
  }

  searchExactSymbol(projectPath: string, symbol: string, limit: number): ProjectSnippetSearchResult[] {
    const rows = this.database.prepare(`${SEARCH_SELECT}
      WHERE snippet.project_path = ? AND snippet.stale = 0 AND file.status = 'current'
        AND (snippet.qualified_name = ? COLLATE NOCASE OR snippet.symbol_name = ? COLLATE NOCASE)
      ORDER BY CASE WHEN snippet.qualified_name = ? COLLATE NOCASE THEN 0 ELSE 1 END,
        file.modified DESC, snippet.start_line, snippet.snippet_id
      LIMIT ?
    `).all(projectPath, symbol, symbol, symbol, limit) as unknown as SnippetRow[];
    return rows.map(mapSnippet);
  }

  searchExact(projectPath: string, term: string, limit: number): ProjectSnippetSearchResult[] {
    const rows = this.database.prepare(`${SEARCH_SELECT}
      WHERE snippet.project_path = ? AND snippet.stale = 0 AND file.status = 'current'
        AND (instr(snippet.file_path, ?) > 0 OR instr(snippet.content, ?) > 0)
      ORDER BY file.modified DESC, snippet.start_line, snippet.snippet_id
      LIMIT ?
    `).all(projectPath, term, term, limit) as unknown as SnippetRow[];
    return rows.map(mapSnippet);
  }

  searchFts(projectPath: string, query: string, limit: number): ProjectSnippetSearchResult[] {
    const rows = this.database.prepare(`
      SELECT
        snippet.snippet_id, snippet.project_path, snippet.file_path, snippet.file_hash,
        snippet.start_line, snippet.end_line, snippet.content, snippet.symbols,
        snippet.token_estimate, snippet.stale, snippet.indexed_at,
        snippet.chunk_kind, snippet.parser_id, snippet.symbol_id, snippet.symbol_name,
        snippet.qualified_name, snippet.symbol_kind, snippet.signature, snippet.parent_symbol,
        snippet.imports_json, snippet.references_json,
        file.language, file.git_commit, file.modified, file.tracked,
        bm25(project_snippets_fts, 1.0, 3.0, 4.0) AS fts_rank
      FROM project_snippets_fts
      JOIN project_snippets AS snippet
        ON snippet.snippet_id = project_snippets_fts.snippet_id
        AND snippet.project_path = project_snippets_fts.project_path
      JOIN project_files AS file
        ON file.project_path = snippet.project_path AND file.file_path = snippet.file_path
      WHERE project_snippets_fts MATCH ? AND snippet.project_path = ?
        AND snippet.stale = 0 AND file.status = 'current'
      ORDER BY fts_rank, file.modified DESC, snippet.start_line, snippet.snippet_id
      LIMIT ?
    `).all(query, projectPath, limit) as unknown as SnippetRow[];
    return rows.map(mapSnippet);
  }

  getStats(projectPath: string): ProjectIndexStats {
    const row = this.database.prepare(`
      SELECT
        (SELECT count(*) FROM project_files WHERE project_path = ? AND status = 'current') AS files,
        (SELECT count(*) FROM project_files WHERE project_path = ? AND status = 'deleted') AS deleted_files,
        (SELECT count(*) FROM project_snippets WHERE project_path = ? AND stale = 0) AS current_snippets,
        (SELECT count(*) FROM project_snippets WHERE project_path = ? AND stale = 1) AS stale_snippets,
        (SELECT count(*) FROM project_snippets WHERE project_path = ? AND stale = 0 AND chunk_kind = 'symbol') AS symbol_chunks,
        (SELECT count(*) FROM project_snippets WHERE project_path = ? AND stale = 0 AND chunk_kind = 'text') AS text_chunks,
        (SELECT COALESCE(sum(token_estimate), 0) FROM project_snippets WHERE project_path = ? AND stale = 0) AS indexed_tokens
    `).get(projectPath, projectPath, projectPath, projectPath, projectPath, projectPath, projectPath) as {
      files: number;
      deleted_files: number;
      current_snippets: number;
      stale_snippets: number;
      symbol_chunks: number;
      text_chunks: number;
      indexed_tokens: number;
    };
    return {
      files: row.files,
      deletedFiles: row.deleted_files,
      currentSnippets: row.current_snippets,
      staleSnippets: row.stale_snippets,
      symbolChunks: row.symbol_chunks,
      textChunks: row.text_chunks,
      indexedTokens: row.indexed_tokens,
    };
  }

  clearProject(projectPath: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM project_snippets_fts WHERE project_path = ?").run(projectPath);
      this.database.prepare("DELETE FROM project_states WHERE project_path = ?").run(projectPath);
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
