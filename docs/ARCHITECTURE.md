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
  -> compute model-aware budget and deterministic prompt hash
  -> persist metadata-only Context Manifest
  -> do not mutate messages (observer mode)

assistant message_end
  -> attach actual provider input usage to pending manifest
  -> append token calibration sample

agent_settled / session_compact / session_tree / shutdown
  -> final incremental index sync

/context
  -> runtime, session, index, manifest, budget and database diagnostics

/context manifest
  -> latest provenance and composition summary without prompt content

/context rebuild-index
  -> transactional reconciliation from canonical JSONL
```

## Boundaries

- `src/core`: portable model profile, budget and token-estimation policy.
- `src/config`: Pi-independent configuration model and loader.
- `src/persistence`: rebuildable SQLite state, repositories, FTS5, and transactional migrations.
- `src/pi-adapter`: byte-safe JSONL reading, Pi-to-canonical conversion, checkpoints, and runtime snapshots.
- `src/extension`: Pi hooks, lifecycle, command presentation and fail-open handling.
- `src/shared`: logging and filesystem-path helpers.

## Canonical and derived state

The Pi session JSONL remains canonical. The SQLite database stores only indexes, summaries, metadata-only manifests, memory, pins, artifacts metadata, and calibration data. Deleting the database must never damage or alter a Pi session. Ephemeral sessions keep manifests in memory because they have no canonical JSONL source from which durable state could be reconstructed.

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

Configuration, database, indexing, observer, and diagnostics failures are caught at the extension boundary. Index failures retain the previous transactional snapshot. The `context` hook returns no replacement on failure, so Pi keeps the current message array. Managed planning will preserve the same fallback guarantee.
