import type { DatabaseSync } from "node:sqlite";

export type ArtifactObjectStatus = "available" | "missing" | "corrupt";

export interface ArtifactObjectRecord {
  sha256: string;
  filePath: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  lastVerifiedAt?: number;
  status: ArtifactObjectStatus;
}

export interface ArtifactReferenceRecord {
  artifactId: string;
  sha256: string;
  sourceSessionId: string;
  sourceEntryKey: string;
  sourceEntryId: string;
  sourceToolCallId: string;
  sourceToolName: string;
  isError: boolean;
  originalChars: number;
  originalTokens: number;
  condensedChars: number;
  condensedTokens: number;
  createdAt: number;
  metadata: Record<string, unknown>;
}

export interface ArtifactRecord extends ArtifactReferenceRecord {
  object: ArtifactObjectRecord;
}

export interface ArtifactStats {
  objects: number;
  references: number;
  bytes: number;
  missing: number;
  corrupt: number;
}

interface ObjectRow {
  sha256: string;
  file_path: string;
  mime_type: string;
  size_bytes: number;
  created_at: number;
  last_verified_at: number | null;
  status: ArtifactObjectStatus;
}

interface ReferenceRow {
  artifact_id: string;
  sha256: string;
  source_session_id: string;
  source_entry_key: string;
  source_entry_id: string;
  source_tool_call_id: string;
  source_tool_name: string;
  is_error: number;
  original_chars: number;
  original_tokens: number;
  condensed_chars: number;
  condensed_tokens: number;
  created_at: number;
  metadata_json: string;
}

interface JoinedRow extends ReferenceRow {
  file_path: string;
  mime_type: string;
  size_bytes: number;
  object_created_at: number;
  last_verified_at: number | null;
  status: ArtifactObjectStatus;
}

function metadata(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function mapObject(row: ObjectRow): ArtifactObjectRecord {
  return {
    sha256: row.sha256,
    filePath: row.file_path,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    ...(row.last_verified_at !== null ? { lastVerifiedAt: row.last_verified_at } : {}),
    status: row.status,
  };
}

function mapReference(row: ReferenceRow): ArtifactReferenceRecord {
  return {
    artifactId: row.artifact_id,
    sha256: row.sha256,
    sourceSessionId: row.source_session_id,
    sourceEntryKey: row.source_entry_key,
    sourceEntryId: row.source_entry_id,
    sourceToolCallId: row.source_tool_call_id,
    sourceToolName: row.source_tool_name,
    isError: row.is_error === 1,
    originalChars: row.original_chars,
    originalTokens: row.original_tokens,
    condensedChars: row.condensed_chars,
    condensedTokens: row.condensed_tokens,
    createdAt: row.created_at,
    metadata: metadata(row.metadata_json),
  };
}

function mapJoined(row: JoinedRow): ArtifactRecord {
  return {
    ...mapReference(row),
    object: {
      sha256: row.sha256,
      filePath: row.file_path,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      createdAt: row.object_created_at,
      ...(row.last_verified_at !== null ? { lastVerifiedAt: row.last_verified_at } : {}),
      status: row.status,
    },
  };
}

const JOINED_SELECT = `
  SELECT
    reference.artifact_id, reference.sha256, reference.source_session_id,
    reference.source_entry_key, reference.source_entry_id,
    reference.source_tool_call_id, reference.source_tool_name, reference.is_error,
    reference.original_chars, reference.original_tokens, reference.condensed_chars,
    reference.condensed_tokens, reference.created_at, reference.metadata_json,
    object.file_path, object.mime_type, object.size_bytes,
    object.created_at AS object_created_at, object.last_verified_at, object.status
  FROM artifacts AS reference
  JOIN artifact_objects AS object ON object.sha256 = reference.sha256
`;

export class ArtifactRepository {
  constructor(private readonly database: DatabaseSync) {}

  save(record: ArtifactRecord): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO artifact_objects(
          sha256, file_path, mime_type, size_bytes, created_at, last_verified_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sha256) DO UPDATE SET
          file_path = excluded.file_path,
          mime_type = excluded.mime_type,
          size_bytes = excluded.size_bytes,
          last_verified_at = excluded.last_verified_at,
          status = excluded.status
      `).run(
        record.object.sha256,
        record.object.filePath,
        record.object.mimeType,
        record.object.sizeBytes,
        record.object.createdAt,
        record.object.lastVerifiedAt ?? null,
        record.object.status,
      );
      this.database.prepare(`
        INSERT INTO artifacts(
          artifact_id, sha256, source_session_id, source_entry_key, source_entry_id,
          source_tool_call_id, source_tool_name, is_error, original_chars,
          original_tokens, condensed_chars, condensed_tokens, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(artifact_id) DO UPDATE SET
          condensed_chars = excluded.condensed_chars,
          condensed_tokens = excluded.condensed_tokens,
          metadata_json = excluded.metadata_json
      `).run(
        record.artifactId,
        record.sha256,
        record.sourceSessionId,
        record.sourceEntryKey,
        record.sourceEntryId,
        record.sourceToolCallId,
        record.sourceToolName,
        record.isError ? 1 : 0,
        record.originalChars,
        record.originalTokens,
        record.condensedChars,
        record.condensedTokens,
        record.createdAt,
        JSON.stringify(record.metadata),
      );
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getForSession(artifactId: string, sessionId: string): ArtifactRecord | undefined {
    const row = this.database.prepare(`${JOINED_SELECT}
      WHERE reference.artifact_id = ? AND reference.source_session_id = ?
    `).get(artifactId, sessionId) as JoinedRow | undefined;
    return row ? mapJoined(row) : undefined;
  }

  listForSession(sessionId: string, sourceEntryIds?: ReadonlySet<string>): ArtifactRecord[] {
    const rows = this.database.prepare(`${JOINED_SELECT}
      WHERE reference.source_session_id = ?
      ORDER BY reference.created_at DESC, reference.artifact_id
    `).all(sessionId) as unknown as JoinedRow[];
    const records = rows.map(mapJoined);
    return sourceEntryIds
      ? records.filter((record) => sourceEntryIds.has(record.sourceEntryId))
      : records;
  }

  updateObjectStatus(sha256: string, status: ArtifactObjectStatus, verifiedAt: number): void {
    this.database.prepare(`
      UPDATE artifact_objects SET status = ?, last_verified_at = ? WHERE sha256 = ?
    `).run(status, verifiedAt, sha256);
  }

  deleteSessionReferencesExcept(sessionId: string, artifactIds: ReadonlySet<string>): number {
    const rows = this.database.prepare(
      "SELECT artifact_id FROM artifacts WHERE source_session_id = ?",
    ).all(sessionId) as unknown as Array<{ artifact_id: string }>;
    const remove = this.database.prepare("DELETE FROM artifacts WHERE artifact_id = ?");
    let changes = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        if (artifactIds.has(row.artifact_id)) continue;
        changes += Number(remove.run(row.artifact_id).changes);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
    return changes;
  }

  listOrphanObjects(): ArtifactObjectRecord[] {
    const rows = this.database.prepare(`
      SELECT object.sha256, object.file_path, object.mime_type, object.size_bytes,
        object.created_at, object.last_verified_at, object.status
      FROM artifact_objects AS object
      LEFT JOIN artifacts AS reference ON reference.sha256 = object.sha256
      WHERE reference.artifact_id IS NULL
      ORDER BY object.sha256
    `).all() as unknown as ObjectRow[];
    return rows.map(mapObject);
  }

  deleteObject(sha256: string): void {
    this.database.prepare(`
      DELETE FROM artifact_objects
      WHERE sha256 = ? AND NOT EXISTS (SELECT 1 FROM artifacts WHERE artifacts.sha256 = artifact_objects.sha256)
    `).run(sha256);
  }

  stats(sessionId?: string): ArtifactStats {
    const referenceWhere = sessionId ? "WHERE source_session_id = ?" : "";
    const referenceArgs = sessionId ? [sessionId] : [];
    const references = this.database.prepare(
      `SELECT count(*) AS count FROM artifacts ${referenceWhere}`,
    ).get(...referenceArgs) as { count: number };
    const objectWhere = sessionId
      ? "WHERE EXISTS (SELECT 1 FROM artifacts AS reference WHERE reference.sha256 = object.sha256 AND reference.source_session_id = ?)"
      : "";
    const objectArgs = sessionId ? [sessionId] : [];
    const objects = this.database.prepare(`
      SELECT count(*) AS count, COALESCE(sum(size_bytes), 0) AS bytes,
        COALESCE(sum(status = 'missing'), 0) AS missing,
        COALESCE(sum(status = 'corrupt'), 0) AS corrupt
      FROM artifact_objects AS object ${objectWhere}
    `).get(...objectArgs) as { count: number; bytes: number; missing: number; corrupt: number };
    return {
      objects: objects.count,
      references: references.count,
      bytes: objects.bytes,
      missing: objects.missing,
      corrupt: objects.corrupt,
    };
  }
}
