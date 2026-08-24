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

Validated summary nodes are stored with immutable content, kind, graph level, source hash, canonical source entry IDs, retained boundary, trigger, model, validation result, and lifecycle state. `summary_edges` records ordered parent-to-child links. Segments have level zero; each aggregate level is greater than every child. A graph batch is first `prepared`; `session_compact` changes all new nodes to `committed` and associates only the active root with the Pi compaction entry. `session_compact_failed` marks the batch `failed`.

Schema-v2 `CompactionEntry.details.ds4ContextEngine` records the active/segment IDs, node kind, level, ordered child IDs, transitive source IDs, source hash, validation metadata, cumulative file lists, and non-active nodes created by that operation. Earlier ancestors remain canonical in earlier Pi entries. On startup, stale prepared rows are failed and committed entries are replayed to rebuild nodes and edges. Schema-v1 M4 entries normalize to level-zero segment roots.

`SummaryRepository.saveGraph()` inserts a complete node batch transactionally, rejects missing/cross-session children, enforces increasing graph levels, and refuses ID collisions that would change immutable content or provenance. `summary_sources` keeps foreign keys to indexed raw entries; deleting a session cascades through the entire derived graph.

## Transactions

A full rebuild does not blindly delete unchanged entries. It upserts all observed entries, marks them in a temporary seen-set, and removes only stale rows. This preserves foreign-key provenance for unchanged source entries. FTS rows and checkpoint state update in the same transaction.

If parsing, validation, or SQLite writing fails, the transaction rolls back and the previous derived index remains available. Pi continues with its native context.
