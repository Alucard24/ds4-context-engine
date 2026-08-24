# Architecture

## Current vertical slice

```text
Pi session_start
  -> trusted configuration merge
  -> derived SQLite bootstrap and migrations
  -> validate Pi JSONL v3 header
  -> full index or checkpointed append sync

Pi context hook
  -> incrementally index newly appended JSONL records
  -> map AgentMessage[] back to active SessionEntry provenance
  -> snapshot effective system prompt and active tool schemas
  -> compute model-aware system/tool overhead and message budget
  -> group turns and tool exchanges atomically
  -> preserve current request and active ds4:pin groups
  -> select a contiguous, model-adaptive recent tail
  -> derive current-task identifiers, files, errors, phrases and keywords
  -> query exact matches and FTS5 over canonical indexed entries
  -> reject active-context duplicates and all alternate-branch candidates
  -> rank, deduplicate, quote and budget historical evidence groups
  -> fit active Pi summaries in the remaining budget
  -> validate hard limit, current request, and tool call/results
  -> return selected messages or fail open to Pi's original context
  -> persist metadata-only Context Manifest and prompt hash

assistant message_end
  -> attach actual provider input usage to pending manifest
  -> append token calibration sample

agent_settled
  -> final incremental index sync
  -> request proactive compaction once per leaf at the model-aware threshold

session_before_compact
  -> map Pi preparation messages to exact canonical entry IDs
  -> serialize only the newly discarded segment and preserve Pi's retained boundary
  -> generate and validate an immutable segment node
  -> resolve the prior root from the active Pi branch only
  -> generate and validate a bounded aggregate node when a prior root exists
  -> atomically persist prepared nodes/edges and return only the active root to Pi

session_compact / session_compact_failed
  -> commit or fail prepared summary lifecycle
  -> reconcile Pi JSONL details into rebuildable SQLite state

session_tree / shutdown
  -> final incremental index sync

/context
  -> runtime, session, index, manifest, budget and database diagnostics

/context manifest | explain | included | excluded
  -> latest plan, provenance and composition without prompt content

/context compaction | compact-preview
  -> trigger threshold and latest summary lifecycle diagnostics

/context summaries
  -> immutable graph nodes, ordered edges, roots, levels and current-branch active path

/context retrieved
  -> query terms, candidate counts, branch blocks, budget decisions and injected excerpts

/context rebuild-index
  -> transactional reconciliation from canonical JSONL
```

## Boundaries

- `src/core`: portable model profile, budget and token-estimation policy.
- `src/config`: Pi-independent configuration model and loader.
- `src/planner`: Pi-independent atomic grouping, deterministic ranking, fitting, validation, and fail-open plans.
- `src/compaction`: structured summary contract, hierarchical graph model, validation, lifecycle metadata, and source hashing.
- `src/retrieval`: task descriptors, safe FTS queries, deterministic ranking, evidence quoting, deduplication, and token fitting.
- `src/persistence`: rebuildable SQLite state, repositories, FTS5, and transactional migrations.
- `src/pi-adapter`: byte-safe JSONL reading, provenance mapping, active pin discovery, checkpoints, and runtime snapshots.
- `src/extension`: Pi hooks, lifecycle, command presentation and fail-open handling.
- `src/shared`: logging and filesystem-path helpers.

## Canonical and derived state

The Pi session JSONL remains canonical. The SQLite database stores only indexes, summary nodes/edges, metadata-only manifests, memory, pins, artifacts metadata, and calibration data. Each aggregate's active text is the Pi compaction summary; non-active nodes created by the same operation are embedded in its details, while older ancestors remain in earlier entries. Deleting the database must never damage or alter a Pi session and the graph is rebuilt by replaying those entries. Ephemeral sessions keep manifests and graph nodes in memory because they have no canonical JSONL source from which durable state could be reconstructed.

## Lifecycle

Database resources are opened during `session_start`, not from the extension factory. They are closed idempotently during `session_shutdown`. Reload and session replacement therefore cannot reuse stale `SessionManager` instances or database handles.

## SQLite choice

M0 uses Node's built-in `node:sqlite` `DatabaseSync`. This avoids a native third-party runtime dependency while matching Pi's Node `>=22.19.0` requirement. Access is wrapped inside `ContextDatabase`, so replacing the driver does not affect core or Pi-adapter code.

Session entries use a scoped key (`session_id:entry_id`) because Pi's short entry IDs are guaranteed unique only inside one session. The original Pi entry ID remains stored separately for provenance and parent traversal.

Database settings:

- WAL for file-backed databases;
- foreign keys enabled;
- 5-second busy timeout;
- transactional, checksummed migrations;
- FTS5 tables created by schema migration;
- containing directory mode `0700` and database file mode `0600` where supported.

## Failure policy

Configuration, database, indexing, retrieval, planning, observer, and diagnostics failures are caught at the extension boundary. Index failures retain the previous transactional snapshot. FTS errors degrade to exact matches; total retrieval failure produces no supplemental messages. Expected planning hazards produce an explicit fallback manifest; unexpected hook failures return no replacement. In both cases Pi keeps its original message array.
