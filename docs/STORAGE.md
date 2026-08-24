# Derived Storage

## Source of truth

Pi's session JSONL is canonical for conversations and live project files are canonical for source knowledge. `context.db` is a disposable projection and can be rebuilt with:

```text
/context rebuild-index
```

The extension never writes to the Pi JSONL file or project source files.

## Session index

Each parsed entry stores:

- Pi session ID and original entry ID;
- session-scoped `entry_key`;
- parent ID and entry type;
- role and timestamp when available;
- SHA-256 of the original JSONL record;
- lexical text and token estimate;
- indexing timestamp.

All branches are indexed. M6 searches the complete session projection but injects only hits whose entry IDs belong to Pi's active branch. Alternate-branch candidate counts remain diagnostic and their text is not sent automatically.

Thinking blocks, image payloads, opaque provider blocks, and `custom` extension-state entries are retained by Pi but intentionally excluded from lexical search. User/assistant text, tool names, tool arguments, tool results, paths, symbols, errors, summaries, labels, and model changes are indexable. Retrieval injection currently accepts only `message` and `custom_message` rows; summary and metadata rows can match FTS for diagnostics but cannot become raw evidence.

`SessionIndexRepository.searchExact()` uses literal `instr()` matching for case-sensitive identifiers and phrases. `searchFts()` joins the contentless metadata columns in `entries_fts` back to scoped `entries` rows and orders by FTS5 `bm25`. User text never becomes raw MATCH syntax: every extracted term is double-quoted and embedded quotes are doubled.

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

## Project knowledge index

Schema v7 adds `project_states`, `project_files`, `project_snippets`, and `project_snippets_fts`. The state row records canonical root plus Git branch/HEAD/dirty paths. Current file rows store SHA-256, size, mtime, language, indexed Git HEAD, tracked/modified state, and lifecycle. Snippet rows store the immutable file hash, line range, source text, heuristic symbols, estimate, and stale bit.

Changed hashes never overwrite old snippet rows silently: prior rows become stale and new hash-derived snippet IDs become current. Deleted, renamed, oversized, binary, symlinked, or newly sensitive files similarly invalidate prior snippets. Exact and FTS queries join current files and require `stale = 0`; stale FTS rows may remain locally for derived-history diagnostics but cannot enter context.

Project source text is duplicated in SQLite only to provide local FTS and bounded snippet injection. Deleting the database loses no source truth. `/context rebuild-index` clears/rebuilds current projections from trusted live files. No project table is read or written while Pi reports the project untrusted.

## Artifact objects and references

Schema v8 splits content objects from source references. `artifact_objects` is keyed by SHA-256 and stores the private file path, MIME, byte size, verification timestamps, and integrity status. `artifacts` is keyed by a deterministic source-specific ID and references session/entry/tool identity plus original/condensed token estimates. Equal bytes across calls or sessions deduplicate to one object while retaining independent provenance.

Objects live under `ds4-context/artifacts/<sha-prefix>/<sha256>` with private permissions and atomic writes. Pi's full JSONL tool result remains canonical; the object file is a rebuildable local cache. No artifact content is stored in Context Manifests. Search recomputes SHA-256 and returns only bounded, redacted, JSON-quoted literal-match windows for a current-branch reference.

A full index rebuild replays all message entries, recreates missing qualifying objects, removes stale session references, and garbage-collects object rows/files with no references. Missing/corrupt states are reported by `/context health` without blocking Pi.

## Context manifests

For persisted sessions, each `context` hook stores a metadata-only manifest containing token counts, session/project source and atomic-group IDs, inclusion/exclusion reasons and scores, original/selected counts, model and category budgets, project revision/hash/line references, tool names, a SHA-256 prompt hash, and planner/policy versions. Prompt text, message text, project snippet text, tool arguments, image data, and rendered provider payloads are not stored in the manifest.

The following finalized assistant response updates the pending manifest with actual provider input usage (`input + cacheRead + cacheWrite`) and adds a calibration sample. Ephemeral sessions retain this information only in memory.

## Compaction summaries

Validated summary nodes are stored with immutable content, kind, graph level, source hash, canonical source entry IDs, retained boundary, trigger, model, validation result, and lifecycle state. `summary_edges` records ordered parent-to-child links. Segments have level zero; each aggregate level is greater than every child. A graph batch is first `prepared`; `session_compact` changes all new nodes to `committed` and associates only the active root with the Pi compaction entry. `session_compact_failed` marks the batch `failed`.

Schema-v2 `CompactionEntry.details.ds4ContextEngine` records the active/segment IDs, node kind, level, ordered child IDs, transitive source IDs, source hash, validation metadata, cumulative file lists, and non-active nodes created by that operation. Earlier ancestors remain canonical in earlier Pi entries. On startup, stale prepared rows are failed and committed entries are replayed to rebuild nodes and edges. Schema-v1 M4 entries normalize to level-zero segment roots.

`SummaryRepository.saveGraph()` inserts a complete node batch transactionally, rejects missing/cross-session children, enforces increasing graph levels, and refuses ID collisions that would change immutable content or provenance. `summary_sources` keeps foreign keys to indexed raw entries; deleting a session cascades through the entire derived graph.

## Transactions

A full rebuild does not blindly delete unchanged entries. It upserts all observed entries, marks them in a temporary seen-set, and removes only stale rows. This preserves foreign-key provenance for unchanged source entries. FTS rows and checkpoint state update in the same transaction.

Session reconciliation is transactional. Each changed project file is also replaced transactionally with its snippets and FTS rows; artifact object/reference metadata and project deletion batches are atomic. A filesystem artifact write precedes its metadata transaction, so an interrupted metadata write may leave only an unreferenced content-addressed cache file; canonical JSONL remains sufficient for recovery. If parsing, validation, or SQLite writing fails, the prior derived state remains available. Artifact/project failures contribute no replacement/snippets; planner failures discard all synthetic evidence; Pi continues with its native context.
