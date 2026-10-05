# Explicit History Recall and Session Rebase

Both features are enabled by default; session rebase remains manual and never runs automatically. Pi JSONL remains canonical; SQLite stores rebuildable projections only. Historical evidence is quoted data, not instructions or user-confirmed pins/decisions.

## Settings through Pi

Inspect the history/rebase fields with `/context config` and edit them directly in Pi using:

```text
/context config set historyTools.enabled false
/context config set sessionRebase.enabled false
/context config set historyTools.maxResults 6
/context config set historyTools.maxOutputTokens 3000
```

Saved changes apply when the next Pi session starts. Set either `enabled` value back to `true` to re-enable it. Explicit saved overrides take precedence over defaults. Project-wide recall remains disabled unless explicitly allowed; semantic retrieval, BPE and model calibration are unchanged.

## History tools (Release A)

```json
{
  "historyTools": {
    "enabled": true,
    "defaultScope": "current-branch",
    "maxResults": 6,
    "maxOutputTokens": 3000,
    "allowProjectScope": false,
    "includeSummaries": false,
    "maxProjectSessions": 100
  }
}
```

`context_history_recall` accepts an explicit `query`, optional `scope`, `limit`, `maxOutputTokens`, roles, ISO `before`/`after` dates and `includeSummaries`. It reuses the automatic retrieval engine and exact/FTS index. Ancestor/type/context filters run **inside SQL before LIMIT**. Explicit searches include pre-compaction canonical ancestors even when absent from the provider context; no automatic double-injection is added.

Scopes:

- `current-branch` (default): only current Pi ancestors.
- `current-session`: all branches of this session; non-ancestors are labelled `other-branch`.
- `current-lineage`: current ancestors plus explicitly verified rebase ancestors, never arbitrary Pi `parentSession` paths.
- `project`: explicit, trusted-project-only and additionally gated by `allowProjectScope`; canonical header cwd must match exactly. Sibling discovery is capped and partial coverage is reported. No cross-project fallback.

Results include bounded metadata and original-source excerpts. Summaries require an explicit/default opt-in and retain their derived type (`compaction`/`branch_summary`); they never become confirmed decisions. Whole entries are privacy-classified before excerpts are selected, secrets are redacted, and privacy is rechecked on original-source read and on historical tool-result egress after provider changes (including the final transport/native-continuation boundary).

`context_history_read` accepts only a server-issued opaque `sourceRef`, plus `startLine`, `maxLines` (default 120, maximum 200) and output budget. References expire after ten minutes, are capped at 512, bound to their issuing session and reauthorized against the **current** scope. Restart requires fresh recall. They cannot resolve model-supplied paths or arbitrary IDs. Reads verify project/session headers, byte locators and raw SHA-256 on the same file descriptor, then return original searchable text (not a summary, and not raw JSONL). Source records over 4 MiB, deleted/modified sources and oversized single lines return bounded unavailability. Tool outputs themselves are not recursively indexed as recall sources.

`context_history_status` reports content-free availability/index state. UI equivalents:

```text
/context history status
/context history search <query>
/context history read <sourceRef> [startLine] [maxLines]
```

Budgets are 6 hits / 3,000 serialized `chars-v1` output tokens by default, capped at 12 / 6,000. Output budgets cannot be below 256; envelope/warning reserve is included. Explicit recall is lexical-only in this increment: it does not initiate remote embedding/provider calls. Existing `retrieval.exact`/`fts` toggles are respected; automatic semantic retrieval is unchanged. Coverage means the bounded authorized sources searched, not exhaustive semantic recovery. Pins, memory mutations and source exclusions retain their existing contracts; recall never mutates them.

Migration 17 adds only `entry_source_locations`; v1–16 SQL/checksums are untouched. Missing locators trigger rebuild using the existing indexer/cursor/raw hashes. Disabled/ephemeral/unavailable paths fail open with metadata-only error codes. These tools are not activated when disabled; registration reserves their names so session startup can activate opt-in configuration.

## Session rebase (Release B)

This implementation is **unpublished**, on the 0.4.13 feature branch; see [ADR 074](ADR/074-canonical-history-recall-and-recoverable-session-rebase.md) and [the implementation handoff](HISTORY_RECALL_REBASE_IMPLEMENTATION.md).

```json
{
  "historyTools": { "enabled": true },
  "sessionRebase": {
    "enabled": true,
    "mode": "manual",
    "checkpointTargetTokens": 8000,
    "preserveSource": true
  }
}
```

```text
/context rebase --dry-run
/context rebase
/context rebase --recover <operationId>
```

`sessionRebase.enabled` defaults false. History tools must be enabled, the project must be trusted, and the session must be idle without pending messages/compaction. Only manual mode with source preservation is accepted. `suggestAfterCompactions=6` and `suggestAboveSessionMiB=50` are reserved settings, not automatic triggers or implemented notifications.

Dry-run validates complete canonical source, active-leaf ancestry, completed tool exchanges and checkpoint budget without target activation. The checkpoint is deterministic: current canonical Pi context, frozen applicable pin/session-memory snapshots and original provenance, history links, and verification state **unknown**. No LLM-generated success/decision is invented and no checkpoint provider is called. The whole live-context handoff must fit `checkpointTargetTokens` (512–24,000); an oversized handoff is blocked rather than silently clipped. Prior compaction or an explicitly larger bounded checkpoint budget may be necessary. Confirmed canonical memory mutations require an available enabled memory bridge. Project items remain their original scoped contributions, not copied target events.

The append-only source is left byte-for-byte intact. The target is installed with a no-overwrite atomic filesystem operation **before activation**, containing canonical checkpoint/link custom entries and a quoted custom-message handoff. Pi 0.84.3 `switchSession({withSession})` activates it; all subsequent checks use the fresh replacement context, never the stale command context. No project file, worktree, Git ref or original source is changed by the rebase operation. Older source JSONL formats are blocked before the SDK can migrate them on disk.

A durable, metadata-only `.ds4-rebase/operations/<operationId>.json` journal adjacent to the canonical session files records Prepared → ArchiveVerified → CheckpointReady → TargetCreated → Activated → Verified. Failure retains a recoverable journal/candidate; it does not delete either session. Use `--recover` explicitly, normally from the preserved source or target. A verified operation can be recovered again without creating another target. Source-prefix hashes, durable target-prefix hashes/byte counts, and target checkpoint/link/handoff integrity are reverified before activation. The target fingerprint is persisted at CheckpointReady before atomic installation, so recovery also covers an installed candidate without a TargetCreated journal update. Changed staged bytes fail closed even if lineage remains valid; legitimate append-only target continuation remains recoverable. If no candidate exists, source growth or branch/session movement blocks checkpoint recreation. A malformed/edited/missing source blocks unsafe activation. A held lock reports busy; process death releases it. The separate lock-only SQLite writer transaction is kernel-backed and independent of the disposable main index, and stores no history/checkpoint authority.

Migration 18 projects checkpoints/lineage/operations; missing main databases rebuild from canonical entries/journal. `parentSession` alone grants no history lineage. The active branch must include its verified checkpoint/link pair. Session memory and applicable branch pins preserve original IDs, timestamps, classification and provenance while participating in the new continuation. Existing UI confirmation/revision checks still govern writes. Continuation supersessions/unpins/invalidations overlay the snapshots without changing the original source's state; restart/rebuild restores that overlay. Branch reset before the checkpoint, damaged provenance or explicit source exclusion removes inherited availability.

### Limits

- Original history attachments are not copied; source reads expose bounded searchable text.
- No automatic rebase, generated checkpoint summary, provider probe, npm publication or source deletion is part of this increment.
- Linux offline tests cover the installed SDK, six crash boundaries, process-death lock release and index loss. Windows/Node 22/24 require separate host/CI execution. File fsync is explicit; directory fsync is unavailable through Node on Windows.
- Lineage validation can re-read sizeable archives; no measured large-session speedup is claimed. Source loss/damage is reported, not automatically repaired. References require fresh recall after restart.
