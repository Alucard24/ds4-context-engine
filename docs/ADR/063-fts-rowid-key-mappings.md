# 063 — Resolve FTS key deletes through rowid mapping tables

**Date:** 2026-09-06
**Status:** Accepted
**Related:** [002](002-pi-jsonl-canonical-sqlite-rebuildable.md), [058](058-bounded-manifest-storage.md)

## Context

The FTS5 shadow tables used by the session index and the project knowledge
index declare `entry_key` / `snippet_id` as `UNINDEXED` columns. FTS5 cannot
use the token vocabulary to locate a row by an `UNINDEXED` column, so every
`DELETE FROM …_fts WHERE entry_key = ?` is a full scan of the whole virtual
table, whose cost is proportional to the size of the entire FTS index.

For incremental appends the cost is small, but a session-index **rebuild**
(fork, path change, truncation, missing checkpoint) re-writes every entry:
a large session (11k entries, ~600MB database) paid thousands of full scans
and stalled for hours, surfacing as an indefinite hang of the agent session.

A first candidate — making `entry_key` an indexed FTS5 column and recreating
the tables in a migration — was benchmarked and rejected: FTS5 then treats the
key as searchable vocabulary, changing the `MATCH` surface (a term present
only in an entry key becomes a false-positive hit) and the `bm25` column
weight mapping of existing queries.

## Decision

Keep the FTS table definitions byte-identical and add dedicated mapping
tables that derive the SQLite rowid of each FTS row:

- `entries_fts_keys(entry_key PRIMARY KEY, fts_rowid)`
- `project_snippets_fts_keys(snippet_id, project_path, fts_rowid)`

Deletes become `DELETE FROM …_fts WHERE rowid = <mapped>` (O(log n)) and
rebuild cleanups resolve stale rows through the same mapping joined on the
base tables. Insert paths upsert the mapping from the FTS `last_insert_rowid`
inside the same write transaction as the FTS insert, so mapping and index
cannot diverge (a crash rolls back both).

The mapping tables are purely derived, rebuildable state: migration 16
backfills them from the live FTS rows with one scan, in a single
transaction — a failure rolls back and the previous schema keeps working.

## Consequences

- Per-row FTS deletes: ~0.23 ms instead of ~40 ms–2 s (cold) per row;
  a 11k-row rebuild drops from hours to ~3 s.
- The FTS schema, the `MATCH` surface and the `bm25` weight mapping are
  unchanged (verified by the migration and repository tests).
- Existing databases upgrade non-destructively on first open after the
  extension update; no user data is stored in the mapping tables.
- Future migrations that drop/recreate FTS tables must rebuild the mapping
  tables in the same migration.
