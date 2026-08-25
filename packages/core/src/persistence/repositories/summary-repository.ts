import type { DatabaseSync } from "node:sqlite";
import { SqliteWriteCoordinator } from "../write-coordinator.ts";
import {
  parseDs4CompactionDetails,
  type SummaryKind,
  type SummaryLifecycleStatus,
  type SummaryRecord,
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
  graph_level: number;
}

interface ImmutableSummaryRow {
  session_id: string;
  summary_kind: string;
  content: string;
  source_hash: string;
  created_at: number;
  graph_level: number;
}

const SELECT_SUMMARY = `
  SELECT summary_id, session_id, summary_kind, content, source_hash, created_at,
         validation_status, provider, model, first_kept_entry_id, tokens_before,
         compaction_reason, lifecycle_status, pi_compaction_entry_id, metadata_json,
         graph_level
  FROM summaries
`;

function parseKind(value: string): SummaryKind {
  if (!["segment", "aggregate", "task-state", "branch"].includes(value)) {
    throw new Error(`Unsupported summary kind in database: ${value}`);
  }
  return value as SummaryKind;
}

function rowToRecord(database: DatabaseSync, row: SummaryRow): SummaryRecord {
  const parsed = JSON.parse(row.metadata_json) as unknown;
  const metadata = parseDs4CompactionDetails({
    readFiles: [],
    modifiedFiles: [],
    ds4ContextEngine: parsed,
  })?.ds4ContextEngine;
  if (!metadata) throw new Error(`Summary ${row.summary_id} contains invalid DS4 metadata`);
  if (
    metadata.summaryId !== row.summary_id
    || metadata.summaryKind !== row.summary_kind
    || metadata.sourceHash !== row.source_hash
    || metadata.graphLevel !== row.graph_level
  ) {
    throw new Error(`Summary ${row.summary_id} metadata does not match graph columns`);
  }
  const sourceRows = database.prepare(`
    SELECT entry.entry_id
    FROM summary_sources AS source
    JOIN entries AS entry ON entry.entry_key = source.entry_key
    WHERE source.summary_id = ?
    ORDER BY entry.created_at, entry.entry_id
  `).all(row.summary_id) as unknown as Array<{ entry_id: string }>;
  const childRows = database.prepare(`
    SELECT child_summary_id
    FROM summary_edges
    WHERE parent_summary_id = ?
    ORDER BY child_order, child_summary_id
  `).all(row.summary_id) as unknown as Array<{ child_summary_id: string }>;
  const sourceEntryIds = sourceRows.map((source) => source.entry_id);
  const childSummaryIds = childRows.map((child) => child.child_summary_id);
  const sorted = (values: readonly string[]): string[] => [...values].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(sorted(sourceEntryIds)) !== JSON.stringify(sorted(metadata.sourceEntryIds))) {
    throw new Error(`Summary ${row.summary_id} source links do not match metadata`);
  }
  if (JSON.stringify(childSummaryIds) !== JSON.stringify(metadata.childSummaryIds)) {
    throw new Error(`Summary ${row.summary_id} child order does not match metadata`);
  }

  return {
    id: row.summary_id,
    sessionId: row.session_id,
    kind: parseKind(row.summary_kind),
    content: row.content,
    sourceHash: row.source_hash,
    sourceEntryIds,
    childSummaryIds,
    graphLevel: row.graph_level,
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

function assertImmutable(database: DatabaseSync, record: SummaryRecord): void {
  const existing = database.prepare(`
    SELECT session_id, summary_kind, content, source_hash, created_at, graph_level
    FROM summaries WHERE summary_id = ?
  `).get(record.id) as unknown as ImmutableSummaryRow | undefined;
  if (!existing) return;
  if (
    existing.session_id !== record.sessionId
    || existing.summary_kind !== record.kind
    || existing.content !== record.content
    || existing.source_hash !== record.sourceHash
    || existing.created_at !== record.createdAt
    || existing.graph_level !== record.graphLevel
  ) {
    throw new Error(`Summary node is immutable and conflicts with existing node: ${record.id}`);
  }
}

export class SummaryRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly writes = new SqliteWriteCoordinator(database),
  ) {}

  save(record: SummaryRecord): void {
    this.saveGraph([record]);
  }

  saveGraph(records: readonly SummaryRecord[]): void {
    if (records.length === 0) return;
    const ids = new Set<string>();
    for (const record of records) {
      if (ids.has(record.id)) throw new Error(`Duplicate summary node in graph batch: ${record.id}`);
      ids.add(record.id);
    }

    this.writes.transaction("summary-graph-save", () => {
      for (const record of records) {
        assertImmutable(this.database, record);
        this.database.prepare(`
          INSERT INTO summaries(
            summary_id, session_id, summary_kind, content, source_hash, created_at,
            validation_status, provider, model, first_kept_entry_id, tokens_before,
            compaction_reason, lifecycle_status, pi_compaction_entry_id, metadata_json,
            graph_level
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(summary_id) DO UPDATE SET
            validation_status = excluded.validation_status,
            provider = excluded.provider,
            model = excluded.model,
            first_kept_entry_id = excluded.first_kept_entry_id,
            tokens_before = excluded.tokens_before,
            compaction_reason = excluded.compaction_reason,
            lifecycle_status = CASE
              WHEN excluded.lifecycle_status = 'committed' THEN 'committed'
              WHEN summaries.lifecycle_status = 'committed' THEN 'committed'
              ELSE excluded.lifecycle_status
            END,
            pi_compaction_entry_id = COALESCE(excluded.pi_compaction_entry_id, summaries.pi_compaction_entry_id),
            metadata_json = excluded.metadata_json,
            graph_level = excluded.graph_level
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
          record.graphLevel,
        );
      }

      for (const record of records) {
        this.database.prepare("DELETE FROM summary_sources WHERE summary_id = ?").run(record.id);
        this.database.prepare("DELETE FROM summary_edges WHERE parent_summary_id = ?").run(record.id);
      }

      const insertSource = this.database.prepare(`
        INSERT INTO summary_sources(summary_id, entry_key)
        SELECT ?, entry_key FROM entries WHERE session_id = ? AND entry_id = ?
      `);
      const childLookup = this.database.prepare(`
        SELECT session_id, graph_level FROM summaries WHERE summary_id = ?
      `);
      const insertEdge = this.database.prepare(`
        INSERT INTO summary_edges(parent_summary_id, child_summary_id, child_order)
        VALUES (?, ?, ?)
      `);
      for (const record of records) {
        for (const entryId of new Set(record.sourceEntryIds)) {
          const result = insertSource.run(record.id, record.sessionId, entryId);
          if (result.changes !== 1) {
            throw new Error(`Summary source entry is not indexed: ${record.sessionId}:${entryId}`);
          }
        }
        const children = [...new Set(record.childSummaryIds)];
        for (const [order, childId] of children.entries()) {
          if (childId === record.id) throw new Error(`Summary node cannot reference itself: ${record.id}`);
          const child = childLookup.get(childId) as unknown as { session_id: string; graph_level: number } | undefined;
          if (!child || child.session_id !== record.sessionId) {
            throw new Error(`Summary child is missing from the same session: ${record.sessionId}:${childId}`);
          }
          if (child.graph_level >= record.graphLevel) {
            throw new Error(`Summary child level must be lower than parent: ${childId} -> ${record.id}`);
          }
          const cycle = this.database.prepare(`
            WITH RECURSIVE descendants(summary_id) AS (
              SELECT child_summary_id FROM summary_edges WHERE parent_summary_id = ?
              UNION
              SELECT edge.child_summary_id
              FROM summary_edges AS edge
              JOIN descendants AS child ON edge.parent_summary_id = child.summary_id
            )
            SELECT 1 AS found FROM descendants WHERE summary_id = ? LIMIT 1
          `).get(childId, record.id) as unknown as { found: number } | undefined;
          if (cycle) throw new Error(`Summary edge would create a cycle: ${record.id} -> ${childId}`);
          insertEdge.run(record.id, childId, order);
        }
      }
    });
  }

  markCommitted(summaryId: string, piCompactionEntryId?: string): boolean {
    return this.writes.execute("summary-mark-committed", () => {
      const result = this.database.prepare(`
        UPDATE summaries
        SET lifecycle_status = 'committed',
            pi_compaction_entry_id = COALESCE(?, pi_compaction_entry_id)
        WHERE summary_id = ?
      `).run(piCompactionEntryId ?? null, summaryId);
      return result.changes === 1;
    });
  }

  markFailed(summaryId: string): boolean {
    return this.writes.execute("summary-mark-failed", () => {
      const result = this.database.prepare(`
        UPDATE summaries SET lifecycle_status = 'failed'
        WHERE summary_id = ? AND lifecycle_status = 'prepared'
      `).run(summaryId);
      return result.changes === 1;
    });
  }

  markFailedMany(summaryIds: readonly string[]): number {
    return this.writes.transaction("summary-mark-failed-many", () => {
      let changed = 0;
      for (const summaryId of new Set(summaryIds)) changed += this.markFailed(summaryId) ? 1 : 0;
      return changed;
    });
  }

  failPreparedForSession(sessionId: string): number {
    return this.writes.execute("summary-fail-session-prepared", () => {
      const result = this.database.prepare(`
        UPDATE summaries SET lifecycle_status = 'failed'
        WHERE session_id = ? AND lifecycle_status = 'prepared'
      `).run(sessionId);
      return Number(result.changes);
    });
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
      ORDER BY created_at DESC, graph_level DESC, rowid DESC
      LIMIT 1
    `).get(sessionId) as unknown as SummaryRow | undefined;
    return row ? rowToRecord(this.database, row) : undefined;
  }

  listBySession(sessionId: string): SummaryRecord[] {
    const rows = this.database.prepare(`
      ${SELECT_SUMMARY}
      WHERE session_id = ? AND metadata_json <> '{}'
      ORDER BY created_at, graph_level, rowid
    `).all(sessionId) as unknown as SummaryRow[];
    return rows.map((row) => rowToRecord(this.database, row));
  }
}
