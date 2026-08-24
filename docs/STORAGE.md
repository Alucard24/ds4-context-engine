# Derived Storage

## Source of truth

Pi's session JSONL is canonical. `context.db` is a disposable projection and can be rebuilt with:

```text
/context rebuild-index
```

The extension never writes to the Pi JSONL file.

## Session index

Each parsed entry stores:

- Pi session ID and original entry ID;
- session-scoped `entry_key`;
- parent ID and entry type;
- role and timestamp when available;
- SHA-256 of the original JSONL record;
- lexical text and token estimate;
- indexing timestamp.

All branches are indexed. Branch selection and weighting are deferred to the retrieval milestone.

Thinking blocks, image payloads, opaque provider blocks, and `custom` extension-state entries are retained by Pi but intentionally excluded from lexical search. User/assistant text, tool names, tool arguments, tool results, paths, symbols, errors, summaries, labels, and model changes are indexable.

## Incremental checkpoint

`session_index_state` records:

- canonical session file path;
- header hash;
- file size and modification time;
- byte offset after the last newline-terminated physical line;
- start offset and SHA-256 of the final, bounded 64 KiB at that physical-line boundary;
- indexed entry and malformed-line counts.

For a growing append-only file, DS4 verifies the header and checkpoint bytes, then reads only the suffix. It performs a full transactional reconciliation when the file is truncated, rewritten in place, changes header, grows after an unterminated tail, or fails append-only entry-hash validation.

Malformed newline-terminated records are skipped consistently and counted. A valid final record without a newline is indexed, but later growth forces a full reconciliation because the boundary is not append-safe.

## Context manifests

For persisted sessions, each `context` hook stores a metadata-only manifest containing token counts, source entry and atomic-group IDs, inclusion/exclusion reasons and scores, original/selected counts, model and recent-tail budgets, tool names, a SHA-256 prompt hash, and planner/policy versions. Prompt text, message text, tool arguments, image data, and rendered provider payloads are not stored.

The following finalized assistant response updates the pending manifest with actual provider input usage (`input + cacheRead + cacheWrite`) and adds a calibration sample. Ephemeral sessions retain this information only in memory.

## Compaction summaries

Validated summaries are stored with their content, source hash, canonical source entry IDs, retained boundary, trigger, model, validation result, and lifecycle state. A summary is first `prepared`; `session_compact` changes it to `committed` and records the Pi compaction entry ID. `session_compact_failed` marks it `failed`.

The same summary ID, source hash, source IDs, validation metadata, and cumulative file lists are written to `CompactionEntry.details.ds4ContextEngine` in Pi JSONL. On startup, stale prepared rows are failed and committed rows can be rebuilt from those canonical details. Summary source rows retain foreign keys to the indexed raw entries.

## Transactions

A full rebuild does not blindly delete unchanged entries. It upserts all observed entries, marks them in a temporary seen-set, and removes only stale rows. This preserves foreign-key provenance for unchanged source entries. FTS rows and checkpoint state update in the same transaction.

If parsing, validation, or SQLite writing fails, the transaction rolls back and the previous derived index remains available. Pi continues with its native context.
