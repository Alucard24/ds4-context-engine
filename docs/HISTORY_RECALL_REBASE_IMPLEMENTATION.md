# History Recall / Session Rebase — implementation handoff

## Goal

Implement PR #1 plan v2.0 incrementally: P0 compatibility, release A (explicit history recall/read), then release B (checkpoint, lineage, recoverable rebase). Publication is not authorized. Source plan copied without merging the PR from `origin/docs/history-recall-session-rebase-plan` (`a587da1`): [`DS4_Context_Engine_Piano_Integrazione_History_Recall_Rebase.md`](../DS4_Context_Engine_Piano_Integrazione_History_Recall_Rebase.md), read in full (636 lines).

## Constraints & Preferences

- Implementation branch: `feat/history-recall-session-rebase`, based on `419d50b` / coordinated 0.4.13, exactly the plan baseline.
- Preserve pre-existing untracked `.serena/`, `AGENTS.md`, `SESSION_HANDOFF.md`; do not stash, overwrite, stage or remove them.
- The user's 2026-10-05 follow-up authorizes default activation, commit, push and coordinated npm publication. The original no-publication restriction is superseded; no plan-PR merge, deletion/truncation of original sessions, session-generation provider calls, second indexer/canonical archive, or implicit scope expansion is authorized.
- Pi 0.84.3, core/adapter separation, canonical append-only JSONL and rebuildable SQLite remain required.
- Preserve memory/pin mutation, confirmation, provenance, scope and lifecycle contracts. BPE/auto-tuning and semantic retrieval defaults remain unchanged.
- Use targeted checks during development; final required project/package checks on coherent milestones. Synthetic-only data and no provider-body logging.

## Progress

### Done

- [x] Read repository instructions; checked Git. Initially no tracked changes; only the three preserved local paths above.
- [x] Fetched plan branch and read the entire document; copied the document into this implementation branch without merging a PR.
- [x] Created dedicated implementation branch. Installed repository Pi package reports 0.84.3.
- [x] Checked installed command-context declarations: `waitForIdle`, `newSession({ parentSession, setup, withSession })`, `switchSession(..., { withSession })`, replacement context. `withSession` actually exists in this baseline; do not rely on the stale context after replacement.

### Implementation complete (unpublished)

- [x] B: deterministic canonical checkpoint/handoff, verified memory/pin continuation, durable metadata-only recovery journal, kernel-backed inter-process lock, lineage and fresh-context activation. A was gated before B; final complete/package gates also pass.

### Pending

- [x] P0/A: scope-before-LIMIT (regression explicitly reproduces starvation with unscoped candidates), migration 17 source locators, bounded SHA-verified original-source reader, shared discovery, explicit-query reuse, opaque TTL refs, privacy/budgets, opt-in tools and UI commands.
- [x] A gate: real installed Pi SessionManager with synthetic persisted branches/compaction plus P0 offline SDK replacement; no provider calls. Rebuild/idempotence/project isolation/fork/expiry/deletion/source-edit/provider-switch/whole-source classification tested. `jev_verify all` passes (typecheck, complete node-test scope, diff check).
- [x] B: checkpoint and equivalent memory/pin continuation, canonical recoverable journal and markers, inter-process lock, lineage, command-only replacement with fresh context, crash/rebuild tests. Real child-process exits at Prepared/ArchiveVerified/CheckpointReady/TargetCreated/Activated/Verified and SIGKILL lock release pass. Source legacy formats/cycles are blocked without SDK rewrites; symlink aliases share canonical journal identity.
- [x] Final compatibility/package checks and documentation: `jev_verify all`, clean-consumer `pack:check`, quality comparison, persistence-schema budget; contract and ADR 074 added. Windows checks require a Windows host and must not be reported as executed here.

### Blocked

No local gate blocker. A/B targeted and complete final gates plus clean-consumer packaging pass. Windows/Node 22/24 behavior remains unexecuted on this Linux/Node 26 host. `pack:check` correctly references existing `scripts/verify-packages.mjs`; missing `scripts/pack-check.mjs` is not a referenced command and is not a blocker. Registry checking is not applicable to unpublished feature code.

## Key Decisions

- A tools default to current-branch; current-lineage only trusts explicit canonical rebase markers. Project scope is explicit/trusted/opt-in with capped discovery and partial reporting.
- Locator migration 17 preserves all previous migration checksums; upgraded projections without locators rebuild via the existing indexer. References are process/session-bound, ten-minute TTL, 512 cap, reauthorized on every read.
- Explicit recall is lexical-only in this increment and initiates no remote embeddings/provider calls. Existing exact/FTS toggles are respected; automatic semantic retrieval is unchanged.
- Whole-source privacy precedes excerpt selection. History result/query egress is rechecked at context and final provider/native-continuation boundaries, including when managed context/privacy is disabled.
- SQL prefilters mean the defensive `alternateBranchCandidates` counter is normally zero, not a count of all indexed sibling rows; the two integration expectations and contract were updated, with sibling-exclusion assertions preserved.
- Compatibility golden records only new opt-in history/rebase defaults and migrations 17–18; prior defaults, migration 1–16 SQL/checksums and runtime contracts remain pinned.
- Canonical source paths + kernel SQLite writer transactions coordinate aliases/processes, independent of the main index. SQLite lock state has no history/lineage/journal authority. Source formats other than version 3 are rejected before any SDK migration can write them.
- Checkpoints contain the actual current Pi context, verified applicable curated snapshots and unknown verification state. Oversized checkpoints are refused; no provider-generated summary or implicit truncation is introduced. Missing/damaged/excluded provenance removes inherited availability.
- Target pin/session-memory lifecycle overlays preserve source state and provenance. Applicable inherited branch pin IDs are included in existing persistence read/revision checks; public mutation parameters and confirmation policy are unchanged.

- Baseline needs no version adaptation: plan and checkout both use 0.4.13. Verify source/API claims rather than treating the static plan as evidence of implemented functionality.
- New tools/rebase remain opt-in; reuse automatic retrieval and its defaults rather than adding another injector.
- Local progress is also tracked in `TODO-a3cace0a`; this file is the reviewable handoff. Do not edit the user's existing `SESSION_HANDOFF.md`.

## Checks and evidence

- Executed: Git status/log/branch checks, plan fetch/extraction, complete plan read, installed Pi version/declaration inspection.
- Targeted P0 command: `npx vitest run tests/integration/history-rebase-pi-spike.test.ts tests/integration/session-indexer.test.ts tests/unit/pi-runtime-contract.test.ts tests/unit/session-jsonl.test.ts tests/unit/portable-core-boundary.test.ts` — 5 files / 12 tests passed.
- The first spike failed because its source-byte baseline preceded Pi's startup metadata append. The corrected test verifies the original byte prefix and permits only startup model/thinking entries, then requires exact source bytes across replacement and restoration.
- The first `jev_verify node-typecheck` found two actual baseline differences: `noTools` is `"all" | "builtin"`, not boolean; `cacheWarming` is absent from the 0.84.3 typed in-memory settings input. Corrected to `noTools: "all"` and a fully isolated settings file requesting warming off; fail-closed network/stream spies independently enforce zero calls. The spike was rerun alone (1/1 passed), then `jev_verify node-typecheck` passed (workspace builds + root typecheck).
- Real installed SDK behavior verified: command-only replacement uses fresh `withSession` context; the old context throws after replacement; `parentSession` is recorded; source bytes remain intact; switch-back restores source identity. Custom metadata alone does not create a target JSONL before its first assistant message. Rebase must persist canonical staging before activation, not assume a setup marker has reached disk.
- Original release checks are historical and are **not** used to validate A/B. A and B were checked on their own implemented states.
- Final targeted retrieval/egress/privacy/memory batch: 9 files / 94 tests passed before the final extra local-only checkpoint test; the complete final `jev_verify all` then passed node-typecheck (workspace builds + strict root), full node-test and git-diff-check, including that test and compatibility golden. No source edits followed those complete code checks; only documentation/task status updates.
- Final `npm run pack:check`: clean consumer verified core 275 / reference adapter 7 / engine 134 packaged files at unchanged 0.4.13. `npm run quality:compare`: synthetic candidate score 0.9875 vs baseline 0.808156 (four fixtures). `npm run schema:context-persistence`: passed, 1,266 bytes / 317 estimated tokens. These are local/synthetic evidence, not provider/model quality claims.
- No registry check: published 0.4.13 cannot validate this unpublished feature implementation. No session-generation provider call, publication, PR merge, or source deletion performed. Windows/Node 22/24 remain unexecuted. Model calibration is a separate workstream and is not a gate for this feature.

## Final review before feature commit

- The user reported successful manual Recall → Rebase → Recall in the local synthetic sandbox: both original messages were returned as untruncated lineage-ancestor hits, without warnings. This is a reported manual result, not a new provider or cross-platform test.
- Review reproduced a missing staged-target fingerprint check: two new regression cases changed a custom-entry timestamp while leaving checkpoint/link/handoff validation valid, and `jev_verify node-test` failed before the fix.
- Recovery now checks the staged prefix's SHA-256 and byte count before activation. CheckpointReady durably records the fingerprint before atomic target installation. Four added cases cover corruption after TargetCreated/Verified, installed-target recovery from a CheckpointReady journal, and idempotent recovery after legitimate append-only continuation; the six real crash-boundary cases also assert durable fingerprint availability.
- On the corrected source, `jev_verify node-typecheck` and `jev_verify node-test` exited 0. The focused independent Jev advisory remained `review`; it is not described as approval and does not replace the compiler/behavioral checks.
- README command/tool documentation now links the unreleased opt-in feature contract. Model calibration is not part of this review or its release gates.

## Default activation and release request (2026-10-05)

- The user explicitly requested History Recall and Session Rebase enabled by default, editable through Pi, plus commit/push/publication. ADR 074 and the feature contract now record that decision.
- `historyTools.enabled` and `sessionRebase.enabled` now default to `true`; saved overrides remain effective, rebase remains manual, and project-wide scope/semantic/BPE/calibration defaults are unchanged. Pi `/context config set`/`unset` saves typed settings for the next session, matching the existing configuration lifecycle.
- Added tests cover defaults, catalog boolean editing and three-tool activation/isolation. `jev_verify all` passed node-typecheck, the complete node-test scope and git-diff-check on the default-activation source.
- Prepare coordinated 0.5.0 for this additive feature/schema release; the Jev acquired-policy fingerprint must be reloaded by the user after the version change before final gates/publication.

## Next Steps

1. Keep delivery on the feature branch and ADR 074; publication/PR merge has not been performed or authorized. The final review/commit step excludes all three user-local paths.
2. Execute Windows and Node 22/24 host/CI gates before a release; validate directory-durability constraints explicitly. Do not present these Linux synthetic fixtures as cross-platform or live-provider validation.
3. If authorized later, evaluate large-session lineage/checkpoint costs and provider-generated checkpoint summaries with a new explicit budget. This increment deliberately blocks oversized deterministic handoffs.
4. The separate live BPE/auto-tuning expanded → provider-headroom threshold → no-headroom objective remains open.

## Critical Context

- Original plan snapshot: `/tmp/ds4-history-plan.SC5dZD/plan.md`; full reviewable (not committed) copy is at repository root.
- Ordered plan chunks 01–43 were all read; relevant Pi docs read fully so far: extensions, sessions, session-format, SDK, compaction. Further related docs/examples remain to be read.
- Migration 17 projects existing JSONL offsets/raw hashes, with locator-rebuild repair in the existing indexer. Migration 18 projects canonical rebase markers/journal. Portable-core imports remain runtime-neutral; SDK/filesystem session behavior is adapter-only.
- Main surfaces: `src/pi-adapter/{history-service,history-source-reader,session-rebase,rebase-lock}.ts`, `src/extension/context-history-*.ts`, `packages/core/src/{rebase,retrieval/history-*,memory/rebase-inheritance.ts}`. Runtime orchestration, commands and existing confirmed-persistence reads are integrated; new contract: `docs/HISTORY_RECALL_REBASE.md`.
