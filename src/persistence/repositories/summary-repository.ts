import type { DatabaseSync } from "node:sqlite";
import {
  parseDs4CompactionDetails,
  type SummaryRecord,
  type SummaryLifecycleStatus,
} from "../../compaction/compaction-record.ts";

interface SummaryRow {
  summary_id: string;
  session_id: string;
  summary_kind: string;
  content: string;
  source_hash: string;
  created_at: number;
  validation_status: string;
  provider: string | null;
  model: string | null;
  first_kept_entry_id: string | null;
  tokens_before: number | null;
  compaction_reason: string | null;
  lifecycle_status: SummaryLifecycleStatus;
  pi_compaction_entry_id: string | null;
  metadata_json: string;
}

const SELECT_SUMMARY = `
  SELECT summary_id, session_id, summary_kind, content, source_hash, created_at,
         validation_status, provider, model, first_kept_entry_id, tokens_before,
         compaction_reason, lifecycle_status, pi_compaction_entry_id, metadata_json
  FROM summaries
`;

function rowToRecord(database: DatabaseSync, row: SummaryRow): SummaryRecord {
  const parsed = JSON.parse(row.metadata_json) as unknown;
  const metadata = parseDs4CompactionDetails({
    readFiles: [],
    modifiedFiles: [],
    ds4ContextEngine: parsed,
  })?.ds4ContextEngine;
  if (!metadata) throw new Error(`Summary ${row.summary_id} contains invalid DS4 metadata`);
  const sourceRows = database.prepare(`
    SELECT entry.entry_id
    FROM summary_sources AS source
    JOIN entries AS entry ON entry.entry_key = source.entry_key
    WHERE source.summary_id = ?
    ORDER BY entry.created_at, entry.entry_id
  `).all(row.summary_id) as unknown as Array<{ entry_id: string }>;

  return {
    id: row.summary_id,
    sessionId: row.session_id,
    kind: "segment",
    content: row.content,
    sourceHash: row.source_hash,
    sourceEntryIds: sourceRows.map((source) => source.entry_id),
    createdAt: row.created_at,
    validationStatus: metadata.validationStatus,
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.model ? { model: row.model } : {}),
    firstKeptEntryId: row.first_kept_entry_id ?? metadata.firstKeptEntryId,
    tokensBefore: row.tokens_before ?? metadata.tokensBefore,
    reason: metadata.reason,
    lifecycleStatus: row.lifecycle_status,
    ...(row.pi_compaction_entry_id ? { piCompactionEntryId: row.pi_compaction_entry_id } : {}),
    metadata,
  };
}

export class SummaryRepository {
  constructor(private readonly database: DatabaseSync) {}

  save(record: SummaryRecord): void {
    const sourceEntryIds = [...new Set(record.sourceEntryIds)];
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO summaries(
          summary_id, session_id, summary_kind, content, source_hash, created_at,
          validation_status, provider, model, first_kept_entry_id, tokens_before,
          compaction_reason, lifecycle_status, pi_compaction_entry_id, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(summary_id) DO UPDATE SET
          session_id = excluded.session_id,
          summary_kind = excluded.summary_kind,
          content = excluded.content,
          source_hash = excluded.source_hash,
          created_at = excluded.created_at,
          validation_status = excluded.validation_status,
          provider = excluded.provider,
          model = excluded.model,
          first_kept_entry_id = excluded.first_kept_entry_id,
          tokens_before = excluded.tokens_before,
          compaction_reason = excluded.compaction_reason,
          lifecycle_status = excluded.lifecycle_status,
          pi_compaction_entry_id = excluded.pi_compaction_entry_id,
          metadata_json = excluded.metadata_json
      `).run(
        record.id,
        record.sessionId,
        record.kind,
        record.content,
        record.sourceHash,
        record.createdAt,
        record.validationStatus,
        record.provider ?? null,
        record.model ?? null,
        record.firstKeptEntryId,
        record.tokensBefore,
        record.reason,
        record.lifecycleStatus,
        record.piCompactionEntryId ?? null,
        JSON.stringify(record.metadata),
      );

      this.database.prepare("DELETE FROM summary_sources WHERE summary_id = ?").run(record.id);
      const insertSource = this.database.prepare(`
        INSERT INTO summary_sources(summary_id, entry_key)
        SELECT ?, entry_key FROM entries WHERE session_id = ? AND entry_id = ?
      `);
      for (const entryId of sourceEntryIds) {
        const result = insertSource.run(record.id, record.sessionId, entryId);
        if (result.changes !== 1) {
          throw new Error(`Summary source entry is not indexed: ${record.sessionId}:${entryId}`);
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  markCommitted(summaryId: string, piCompactionEntryId: string): boolean {
    const result = this.database.prepare(`
      UPDATE summaries
      SET lifecycle_status = 'committed', pi_compaction_entry_id = ?
      WHERE summary_id = ?
    `).run(piCompactionEntryId, summaryId);
    return result.changes === 1;
  }

  markFailed(summaryId: string): boolean {
    const result = this.database.prepare(`
      UPDATE summaries SET lifecycle_status = 'failed'
      WHERE summary_id = ? AND lifecycle_status = 'prepared'
    `).run(summaryId);
    return result.changes === 1;
  }

  failPreparedForSession(sessionId: string): number {
    const result = this.database.prepare(`
      UPDATE summaries SET lifecycle_status = 'failed'
      WHERE session_id = ? AND lifecycle_status = 'prepared'
    `).run(sessionId);
    return Number(result.changes);
  }

  getById(summaryId: string): SummaryRecord | undefined {
    const row = this.database.prepare(`${SELECT_SUMMARY} WHERE summary_id = ? AND metadata_json <> '{}'`)
      .get(summaryId) as unknown as SummaryRow | undefined;
    return row ? rowToRecord(this.database, row) : undefined;
  }

  getLatest(sessionId: string): SummaryRecord | undefined {
    const row = this.database.prepare(`
      ${SELECT_SUMMARY}
      WHERE session_id = ? AND metadata_json <> '{}'
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(sessionId) as unknown as SummaryRow | undefined;
    return row ? rowToRecord(this.database, row) : undefined;
  }
}
