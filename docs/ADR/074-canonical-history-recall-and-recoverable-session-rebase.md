# ADR 074 — Canonical history recall and recoverable session rebase

Status: Accepted. Default activation explicitly approved by the user on 2026-10-05 for coordinated 0.5.0.

## Context

PR #1's integration plan targets the 0.4.13 baseline. Automatic retrieval already exists, but accepts only the latest user request, excludes active context, and previously filtered ancestors after SQL candidate LIMIT. Pi 0.84.3 exposes command-only session replacement and fresh `withSession` contexts; metadata-only setup remains lazily persisted until an assistant message. A naive rebase could therefore activate an unpersisted target, lose session/branch-scoped curated state, or make SQLite authoritative.

## Decision

The user's 2026-10-05 release instruction supersedes the plan's initial opt-in activation: `historyTools.enabled` and `sessionRebase.enabled` default to `true`, with editable Pi `/context config` fields and preserved explicit overrides. Rebase remains manual; project-scope expansion, semantic retrieval, BPE and auto-tuning defaults do not change.

1. Reuse the existing indexer, cursor/raw hashes, exact/FTS engine, storage and privacy policy. Apply ancestor/context/type/date/role filters inside SQL before LIMIT. Explicit history tools are enabled by default and lexical-only; automatic retrieval defaults and semantic behavior are unchanged.
2. Migration 17 adds disposable byte locators. Original-source reads verify the header/project, entry identity and SHA-256 on one descriptor. Model refs are bounded, session-bound, volatile and reauthorized; no arbitrary paths or IDs are accepted.
3. Privacy applies to complete source entries before excerpts and again at historical tool-result/provider egress. Explicit classification survives serialization into checkpoints. Protocol outputs/handoffs do not become a recursively indexed second history corpus.
4. Rebase is manual, trusted-project-only, enabled separately, idle, archive-complete and tool-atomic. It requires history tools and a usable memory bridge when confirmed mutations exist. Capture the actual active leaf, not the last physical sibling record. Reject legacy source versions before `SessionManager.open()` can migrate/rewrite them.
5. Build a deterministic quoted handoff from Pi's current canonical context. Never infer current verification success or manufacture confirmations. If the whole live context exceeds the checkpoint budget, block rather than silently discard it; this increment does not call a summarization provider.
6. Persist canonical versioned checkpoint/link entries in an atomically installed, no-overwrite target JSONL **before** `switchSession`. The source JSONL is not appended, truncated, replaced, deleted or copied into a competing authoritative archive. Canonical paths bind symlink aliases to one operation identity.
7. Store a durable metadata-only operation journal adjacent to session state. Phases are Prepared, ArchiveVerified, CheckpointReady, TargetCreated, Activated and Verified; failures retain Recoverable state. Recovery is explicit/idempotent, verifies source prefix, durable target-prefix hash/byte count, and target checkpoint/handoff, and uses fresh `withSession` context after activation. Persist the target fingerprint before atomic install; reject changed staged bytes without rejecting legitimate append-only continuation. Paths/checkpoint bodies are not copied into public diagnostics.
8. Coordinate per-source across processes using a fixed **lock-only SQLite file**, separate from the rebuildable history index. Hold its kernel-backed writer transaction throughout the operation, including activation. The file stores no history, checkpoint, lineage or journal authority. Process death releases the lock; rebuilding the main index cannot release a live rebase lock. This avoids unsafe stale filesystem-lock stealing and JS-only mutexes.
9. Migration 18 projects canonical checkpoint/link/journal data. A deleted main database reconstructs these projections from JSONL/journal. No migration 1–16 SQL/checksum or synchronized package version is rewritten.
10. Carry only applicable non-project pins/session memory as frozen, verified continuation snapshots, with original IDs, timestamps, classification, scope and provenance. Target lifecycle/supersession mutations affect the continuation overlay, not the original source's rows or JSONL. The existing confirmed-write/UI/revision policy remains in force. Verified lineage restores explicit ancestor project contributions; arbitrary sibling harvesting remains opt-in. Missing/invalid/excluded origins remove inherited availability rather than create new facts.
11. Compaction and rebase exclude one another, including native compaction tracked via lifecycle signals. ParentSession alone never grants lineage; only verified checkpoint/link pairs on the active branch do. An inherited branch pin applies to descendants of that continuation, not a branch reset before its checkpoint.

## Evidence

- Scope-after-LIMIT regression fails with unscoped sibling candidates and passes after SQL prefiltering.
- Real installed Pi 0.84.3 offline runtime replacement, target persistence, fresh-context activation and repeated recovery pass with stream/fetch spies unused.
- Synthetic canonical fixtures cover pre-compaction originals, 150 siblings, project/branch isolation, locators/index rebuild, ref expiry/scope/source edits/deletion and provider-switch egress.
- Fault injection and **real process exits** at all six operation boundaries recover idempotently; a separately killed lock holder releases the kernel lock.
- Source bytes remain identical in synthetic rebase/recovery tests; full main-index loss reconstructs checkpoint/lineage and inherited lifecycle state.

## Consequences and limits

- JSONL and the operation journal remain authoritative; lock/index databases are operational/disposable projections only.
- Explicit recall uses bounded text, not raw media attachments, and has no remote semantic embedding step. Refs expire on restart.
- Deterministic handoffs may require prior compaction or a larger bounded checkpoint budget. A damaged/missing archive or unsupported source format blocks rebase/recovery; it is not repaired or deleted automatically.
- Directory fsync is supported on the tested Linux host. Node does not expose the equivalent on Windows; file fsync remains explicit. Windows and Node 22/24 execution require separate host/CI confirmation. Full-source lineage verification may be expensive; P7 optimization/provider-generated checkpoints are not part of this increment.
- No npm publication, PR merge, provider probe or original-session deletion is authorized by this ADR.
