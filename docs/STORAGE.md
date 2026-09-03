# Derived Storage

## Source of truth

Pi's session JSONL is canonical for conversations and live project files are canonical for source knowledge. `context.db` is a disposable projection and can be rebuilt with:

```text
/context rebuild-index
```

The extension never edits or rewrites Pi JSONL or project source files. Manual memory/pin commands, confirmed `context_persistence` canonical writes, and learned-ranking feedback append versioned classified Pi `CustomEntry` records through Pi's official `appendEntry()` API. The tool does not write SQLite as a substitute for a canonical Pin or Memory append.

The M19 non-Pi reference adapter owns a separate `ds4-runtime-session-v1` JSONL source selected by its host runtime. Its header binds runtime/session identity and the exact canonical project root; following records contain provenance-checked canonical messages. DS4 snapshots and capability diagnostics are disposable. `createReferenceHistory()` refuses overwrite, append uses a dedicated provenance-checked operation, files are mode `0600` where supported, and rebuild never edits this runtime-owned canonical file. Reference JSONL is not imported into Pi or `context.db`.

M20 local KV state is entirely runtime-owned and volatile. Core returns only an in-memory eligibility fingerprint to the runtime port; it has no cache-handle field or serialization API. Prefixes, fingerprints, handles and provider outputs are absent from Pi/reference JSONL, Context Manifests, ranking artifacts and every SQLite table. Aggregate hit/miss/prefill counters live only on the adapter controller, and a restart safely resets them with the runtime cache. M20 adds no database migration.

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

Schema v7 adds `project_states`, `project_files`, `project_snippets`, and `project_snippets_fts`. The state row records canonical root plus Git branch/HEAD/dirty paths. Current file rows store SHA-256, size, mtime, language, indexed Git HEAD, tracked/modified state and lifecycle. Snippet rows store the immutable file hash, line range, source text, estimate and stale bit.

Schema v12 extends snippet rows with text/symbol chunk kind, parser ID, stable symbol ID, simple and qualified names, kind, signature, parent, imports and references. The exact-name indexes and all parser output are disposable. Built-in TypeScript/JavaScript/Python/Go structural parsing has no native dependency; unsupported, invalid or declaration-free files retain bounded v7 text windows.

Changed hashes never overwrite old snippet rows silently: only the changed path's prior rows become stale and new hash-derived snippet/symbol IDs become current. Unrelated files preserve their rows and IDs. Deleted, renamed, oversized, binary, symlinked or newly sensitive files similarly invalidate prior snippets. Exact path/symbol and FTS queries join current files and require `stale = 0`; stale FTS rows may remain locally for derived-history diagnostics but cannot enter context.

Project source text is duplicated in SQLite only to provide local FTS and bounded snippet injection. Deleting the database loses no source truth. `/context rebuild-index` clears/rebuilds current projections from trusted live files. No project table is read or written while Pi reports the project untrusted.

## Derived embedding index

Schema v13 adds `derived_embeddings` for opt-in M16 historical/project vectors. The compound key contains source kind/scope/key/hash, chunking version, embedding provider/model and dimensions. Rows store only source grouping metadata, numeric vector JSON and indexing time; no query text, copied evidence text, provider response ID or remote handle is added.

Current source keys and hashes prune obsolete vectors without touching unrelated sources. Provider/model/dimension profiles coexist, so changing one profile does not rewrite another. Query vectors live only in a bounded volatile cache. The table is ignored when semantic retrieval is disabled and can always be recreated from Pi JSONL plus trusted live project files and the configured runtime embedding port.

Remote embedding text is privacy-filtered before the port is called. `local-only` values are omitted entirely and allowed values are secret-redacted. These rules govern transport; SQLite remains a local disposable projection.

## Memory and pin event projection

Schema v9 adds append-only `memory_mutations` and `pin_mutations`, each keyed to the canonical scoped `entries.entry_key` for its Pi custom entry. Mutation payloads describe immutable add, explicit supersede, or lifecycle status operations. `entry_order` preserves causal order when several Pi entries share one millisecond timestamp.

`memory_items`, `memory_sources`, `memory_fts`, and `pins` are materialized transactionally by replaying every known mutation. Materialized memory records retain normalized keys, origin session, source entries, optional privacy classification, active/superseded/invalid/expired status and immutable replacement links. Pins retain session/branch/project scope, creation leaf, optional classification, source entry/file and active/superseded/deleted lifecycle. Classification lives in canonical mutation JSON and derived `metadata_json`; M10 required no schema migration beyond v9.

Before replay, the current session's mutation rows are replaced from its complete Pi entry tree. Other indexed sessions remain available, preserving the 0.1 project-scope behavior.

Schema v15 adds `project_memory_sessions`, `project_memory_source_exclusions`, and mutation creation-parent columns. When `memory.crossSession` is opted in, DS4 enumerates at most `memory.maxProjectSessions` sibling Pi JSONL files, validates each header against the exact trusted canonical project path, indexes only changed suffixes, and materializes their explicit mutations. Source rows retain header/checkpoint hashes, offsets, record/mutation counts, malformed-line counts, status and bounded error text. Exclusions are local derived policy; mutation content remains only in canonical JSONL and existing local projection tables. `context_persistence` exposes a process-local `sourceRef` instead of the session ID/path. Source-reference and revision mappings are TTL/cap-bounded, never written to SQLite, manifests, logs or JSONL, and disappear at restart. Deleting `context.db` deliberately removes exclusions; replay then restores contributions from unchanged canonical sibling JSONL.

A missing, moved, truncated, identity-mismatched or corrupt sibling source stops contributing unverifiable project-scoped mutations without discarding its isolated session-scoped projection. The active session retains its last transactional projection if an auxiliary cross-session refresh fails. Restored files rebuild deterministically. Deleting the database loses no canonical mutation; source discovery recreates the complete project projection without opening every source session. Unbacked legacy pre-v9 materialized rows are inspectable immediately after migration but are not treated as canonical during a later full replay.

Custom entries have empty lexical search text and never enter Pi context directly. The managed planner creates bounded, source-labelled synthetic pin/memory messages. Context Manifests store only metadata and hashes, never content/claims.

## Model calibration and provider cache metrics

Schema v10 extends `context_manifests` and `token_calibration` with separate uncached-input, cache-read, and cache-write token columns. New calibration rows also carry the correlated manifest ID and explicit estimator version. Legacy pre-v10 samples migrate as `chars-v1` with their prior total stored as uncached input and zero cache fields; this preserves historical ratio behavior without inventing cache hits.

Calibration rows are derived telemetry, isolated by exact provider/model and bounded to the latest configured window at read time. The runtime recomputes median/MAD outlier filtering deterministically; no learned model or mutable provider state is stored. Deleting the database loses calibration and cache history but never session content. Ephemeral sessions and configurations that disable manifest persistence keep only a bounded in-memory window.

## Context quality samples

Schema v11 adds bounded `context_quality_samples` for opt-in M14 measurement. Rows contain only metric/corpus/planner/profile versions, source-kind/token/budget/decision counts, normalized outcome labels and separate planning duration. Prompt text, evidence text, paths, memory claims, provider payloads, response IDs and raw source IDs are never stored. Invalid or corrupt rows are skipped during aggregation.

The table is a disposable replay projection. Deleting it loses no canonical state; replaying the versioned sanitized corpus recreates byte-stable non-timing aggregates. Runtime samples without expected-evidence labels remain explicitly unlabeled. See [`CONTEXT_QUALITY.md`](CONTEXT_QUALITY.md).

## Learned-ranking labels and model artifact

M18 adds no SQLite table. Classified `ds4-context-ranking-feedback-v1` Pi custom entries are canonical and contain only version/hash/label metadata plus ten bounded numeric features. Stable repository and candidate identities are SHA-256 hashes; raw prompt, evidence, claim, path and symbol text are absent. Sanitized replay labels use the same entry schema and explicitly identify their label source.

The trained `ds4-context/ranking-model.json` file is a disposable private artifact containing schema/algorithm versions, bounded weights, aggregate training counts, optional promotion-gate metrics and a stable-payload checksum. Deleting or corrupting it restores static ranking; canonical labels remain available for local retraining. Shadow comparison stores only aggregate disagreement in Context Manifests. No label, feature vector or candidate ID is copied into a manifest. See [`LEARNED_RANKING.md`](LEARNED_RANKING.md).

## Native continuation state

M12 adds no continuation table. It was introduced at schema v10; M14 adds quality samples in v11, M15 adds project-symbol columns/indexes in v12, and M16 adds only disposable vectors in v13. The active process keeps only deterministic SHA-256 hashes of the previous full request items and serialized response items, a hash of non-input request options, completion time, and the minimum provider response handle needed for `previous_response_id`.

The volatile state is cleared on lifecycle/model/branch/compaction boundaries and is not reconstructed on resume. The first request after a cold start is therefore always the complete managed replay. Pi may persist its normal `AssistantMessage.responseId` in canonical JSONL, but DS4 does not create a custom entry, copy that ID into SQLite/manifest/logs, or depend on it for recovery.

## Artifact objects and references

Schema v8 splits content objects from source references. `artifact_objects` is keyed by SHA-256 and stores the private file path, MIME, byte size, verification timestamps, and integrity status. `artifacts` is keyed by a deterministic source-specific ID and references session/entry/tool identity plus original/condensed token estimates and an optional derived privacy classification in `metadata_json`. Equal bytes across calls or sessions deduplicate to one object while retaining independent provenance.

Objects live under `ds4-context/artifacts/<sha-prefix>/<sha256>` with private permissions and atomic writes. Pi's full JSONL tool result remains canonical; the object file is a rebuildable local cache. No artifact content is stored in Context Manifests. Search recomputes SHA-256 and returns only bounded, redacted, JSON-quoted literal-match windows for a current-branch reference. The runtime reapplies the stored artifact classification before returning excerpts to the active provider; prohibited remote searches return no content.

A full index rebuild replays all message entries, recreates missing qualifying objects, removes stale session references, and garbage-collects object rows/files with no references. Missing/corrupt states are reported by `/context health` without blocking Pi.

## Context manifests

For persisted sessions, each `context` hook stores a metadata-only manifest containing token counts, session/project/pin/memory source and atomic-group IDs, inclusion/exclusion reasons, classifications and scores, original/selected counts, exact-model override/calibration/adaptive budgets, aggregate learned-ranking status/disagreement, model-switch/cache disposition, provider destination/allow names, privacy counters, optional continuation mode/item counts/retry reasons, project revision/hash/line references, tool names, a SHA-256 prompt hash, and planner/policy versions. Prompt text, message text, pin content, memory claims, project snippet text, tool arguments, image data, rendered provider payloads, and provider response/conversation IDs are not stored in the manifest.

`before_provider_request` updates the pending in-memory manifest with final-check/redaction counters but never the provider payload. The following finalized assistant response updates only the existing scalar usage columns (`actual_tokens`, `input_tokens`, `cache_read_tokens`, and `cache_write_tokens`) and adds at most one exact-model calibration sample. It does not read or rewrite `manifest_json`. Repository reads hydrate authoritative usage from those columns. Ephemeral, oversize-skipped, concurrently pruned, and otherwise uncorrelated manifests retain bounded calibration only in memory.

Retention is bounded without a schema change: SQLite keeps the latest 128 manifests globally and at most 200 calibration samples for each provider/model/estimator profile. A manifest prune first detaches its small calibration row, then removes the large diagnostic JSON; calibration has its own per-profile retention. Save and prune are one transaction. Existing oversized stores are reduced incrementally by at most 32 rows and 8 MiB of serialized manifest payload per subsequent manifest write; one individually oversized oldest row may be removed to guarantee progress. There is no startup purge.

New manifest persistence is byte-bounded. Payloads up to 256 KiB remain complete. Larger payloads preserve all `included` provenance and replace only the `excluded` inventory with a deterministic first/last sample of at most 256 details plus explicit `ds4-context-manifest-inventory-v1` counts, token/classification/kind rollups, and digests. The wrapper returned by `getStored()` declares `complete` or `excluded-rollup`; the live runtime manifest remains complete. A projected payload over 1 MiB is skipped without affecting the model request. Deleted pages become reusable by SQLite but do not promise an immediate reduction in filesystem size. Manifests and calibration remain disposable; Pi JSONL and project files are untouched.

## Storage diagnostics and offline maintenance

`/context storage` is read-only and metadata-only. It reports schema/journal, database and sidecar sizes, page/free-page counts, bounded manifest/calibration aggregates, active-project aggregate counts, artifact totals, convergence, and categorical maintenance reasons. `/context health` reports storage warning state separately from SQLite integrity: high-water or retention warnings produce an overall `WARN` without changing `DatabaseHealth.ok`.

File-backed runtime clients use a private two-phase lease next to the database. An explicit maintenance lock prevents new clients from opening SQLite, and active or ambiguous client leases block compaction. Database close precedes lease release. Pi remains on its existing fallback path if it starts while maintenance is active.

Physical size recovery uses the separately packaged, interactive `ds4-context-storage` CLI. It creates and validates a standalone backup, rewrites only an offline working copy, runs `VACUUM INTO` a candidate, checks schema/migrations/foreign keys, protected-table counts and private full-row digests, and source exclusions, then performs a persisted recoverable swap that retires WAL/SHM sidecars before installing the candidate. It never runs automatically or through an LLM-callable tool, never overwrites its fixed backup, and never edits Pi JSONL or project files. See [`STORAGE_MAINTENANCE.md`](STORAGE_MAINTENANCE.md).

## Compaction summaries

Validated summary nodes are stored with immutable content, kind, graph level, source hash, canonical source entry IDs, retained boundary, trigger, model, validation result, and lifecycle state. While privacy is enabled, non-normal nodes carry an outer classification marker so later provider switches re-enforce the source ceiling. `summary_edges` records ordered parent-to-child links. Segments have level zero; each aggregate level is greater than every child. A graph batch is first `prepared`; `session_compact` changes all new nodes to `committed` and associates only the active root with the Pi compaction entry. `session_compact_failed` marks the batch `failed`.

Schema-v2 `CompactionEntry.details.ds4ContextEngine` records the active/segment IDs, node kind, level, ordered child IDs, transitive source IDs, source hash, validation metadata, cumulative file lists, and non-active nodes created by that operation. Earlier ancestors remain canonical in earlier Pi entries. On startup, stale prepared rows are failed and committed entries are replayed to rebuild nodes and edges. Schema-v1 M4 entries normalize to level-zero segment roots.

`SummaryRepository.saveGraph()` inserts a complete node batch transactionally, rejects missing/cross-session children, enforces increasing graph levels, and refuses ID collisions that would change immutable content or provenance. `summary_sources` keeps foreign keys to indexed raw entries; deleting a session cascades through the entire derived graph.

## 0.2 schema freeze, upgrade, and rollback

The 0.2 projection contract is frozen at schema 15. Migrations 1–10 are the exact 0.1 history; 11–15 add quality samples, structural symbols, derived embeddings, cross-process leases, and cross-session project-memory checkpoints. `tests/golden/compatibility-0.2.0.json` pins every migration name and SHA-256 checksum so an existing migration cannot be silently rewritten.

Opening a schema-10 database applies only forward migrations and preserves legacy rows. No migration edits Pi JSONL, reference-adapter JSONL, project files, or runtime KV state. Complete database deletion remains the recovery path because all tables are projections; versioned local quality inputs rebuild quality aggregates separately.

Rollback is also projection-based. A 0.1 binary refuses schema 15 by design. Stop all processes sharing the database, retain canonical JSONL/project files, then remove or archive `context.db`, its WAL/SHM files, and other disposable local artifacts before allowing 0.1 to create a fresh database or use another `storage.databasePath`. Never alter `schema_migrations`, stored checksums, or `PRAGMA user_version` to force a downgrade. See [`RELEASE_READINESS_0.2.0.md`](RELEASE_READINESS_0.2.0.md).

## Transactions

A full rebuild does not blindly delete unchanged entries. It upserts all observed entries, marks them in a temporary seen-set, and removes only stale rows. This preserves foreign-key provenance for unchanged source entries. FTS rows and checkpoint state update in the same transaction.

Session reconciliation is transactional. Memory/pin mutation replacement, checkpoint update, source exclusion and full materialization each occur under the shared write coordinator. Each manifest upsert and dual-bound incremental retention prune share one transaction; each scalar usage/calibration update and its independent per-profile prune do the same. Each quality upsert and bounded-retention prune also share one transaction; quality failures do not affect manifests or planning. Each changed project file is replaced transactionally with its snippets and FTS rows; embedding upserts and canonical-source pruning are transactional; artifact object/reference metadata and project deletion batches are atomic. A filesystem artifact write precedes its metadata transaction, so an interrupted metadata write may leave only an unreferenced content-addressed cache file; canonical JSONL remains sufficient for recovery. If manifest serialization, projection, retention, or SQLite writing fails, the complete current manifest remains in memory and the provider request is unchanged. Other artifact/project failures contribute no replacement/snippets; planner failures discard all synthetic evidence; Pi continues with its native context.

After bounded busy-aware replay is exhausted, DS4 emits `database.write_lock_timeout` with only the coordinator operation name, attempt count, elapsed/configured waits, and SQLite primary code. The thrown error repeats the operation and categorical lock status but never includes SQL, bound values, provider content, or the raw SQLite message. Retry and rollback diagnostics follow the same metadata-only rule.
