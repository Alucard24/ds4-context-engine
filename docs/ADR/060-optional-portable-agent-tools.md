# ADR 060 — Optional portable DS4 agent improvements

Status: accepted and implemented; included in the coordinated 0.3.4 release. Backend integration remains excluded.

## Boundary

Pi remains the agent runtime and JSONL remains canonical history. These changes add optional tool behavior, not another agent loop. No inference rewind, forced sampling, native KV handles, database migration or dependency upgrade is included.

Four independently default-off switches, also gated by `enabled`:

- `editing.postEditReport`: bounded report from the actual native unified patch, including changed old/new ranges, line delta and post-edit context. Works independently of `editing.anchored`.
- `reading.adaptive`: choose the default `read` limit from the execution-time model window (120 / 240 / 500 lines at <=8192 / <=16384 / larger windows). Explicit limits, images, cancellation and native byte caps remain native. No shared `more` cursor.
- `artifacts.adaptiveBudget`: lower inline/excerpt limits according to the calibrated context budget after output/safety reserves and estimated fixed overhead. Never increase configured limits. Preserve minimum reference metadata, canonical results, provenance, privacy, atomic tool groups and normal planner fallback. This is an estimate, not a guaranteed fit or reentrant compaction trigger.
- `jobs.enabled`: opt-in `bash_job` module in this repository, separate from the portable core and existing `bash`. A single start/status/stop/list tool manages local jobs through Pi's public local BashOperations.

## Editing and reading

Do not take over missing or visibly overridden native tools. Restore native definitions when an already-enabled instance loads disabled configuration. Fresh disabled loads register no override. Render the real native diff; report failures must not turn a successful write into an apparent failure. Limit report regions, context and escaped text; never re-read a potentially changed file for reporting. Retain ADR 059's strict mixed-anchor batch behavior.

## Adaptive artifacts

Use provider-facing privacy-sanitized messages only, and the same calibrated model budget as the planner. Keep all configured storage/search caps. Share the available text budget among candidate results, with a metadata floor bounded by the configured maximum. Missing/invalid budget data keeps static behavior. Rebuild uses the conservative adaptive floor so artifacts from earlier small-budget contexts remain reconstructible. No policy values or canonical messages are mutated. Do not replace a result with a larger estimated result.

## Local jobs

- Require an active built-in local `bash`, no conflicting `bash_job`, explicit configuration, project trust, and local UI confirmation for every start. No UI means no start. This separate tool does not inherit other extensions' bash-only permission policies or SDK shell options.
- Use opaque job IDs, not arbitrary PIDs. Owner is the current session plus the originating branch entry. Status/stop/list never cross that boundary.
- At most 4 concurrent jobs and 16 retained records. Default timeout 300 seconds, hard maximum 3600 seconds. Cap each log at 8 MiB and stop on overflow or log-write failure.
- Logs are raw local files in a private temporary directory, not SQLite state. Responses contain bounded quoted head/tail excerpts and a local output path. Keep completed jobs until bounded eviction or session cleanup; explicitly report output truncation and stop reason.
- Cancellation while start is pending stops the new job. Once start returns, the job has an independent lifetime; cancelling status does not stop it. Stop and shutdown use native process-tree cancellation. No promise of rollback, daemon ownership or restart survival.
- Stop jobs and remove temporary logs on session replacement, reload and shutdown. Stop jobs made invisible by branch navigation. Compaction preserves processes and appends a bounded canonical metadata snapshot without launching another model turn; status must be refreshed before acting on old snapshots.
- Completion marks project indexing dirty. Never launch automatic follow-up turns.

## Verification

Cover independent opt-ins/default-off paths, legacy missing config, argument mutation, native matching and line endings, explicit read limits/images/model changes, estimated budgets/provenance/privacy/rebuild, process caps/timeouts/aborts/ownership/cleanup/compaction, and clean-consumer packaging. Linux process tests do not establish successful Windows execution; the native Pi backend owns platform-specific process handling.

Implementation validation: `npm run check` passed 78 files / 485 tests, including real local bash execution, stop and timeout. Quality comparison and persistence schema gates passed. Clean-consumer packaging passed with Pi 0.84.3 and eight real registry scenarios (core 231 files, reference adapter 7, engine 83). Packaging used a staging copy with the canonical root package manifest; pre-existing user `package.json` changes and `.serena/` were excluded. No provider-token/latency benchmark or Windows execution claim is made. That implementation validation preceded release preparation. See the [0.3.4 release record](../releases/0.3.4.md) for final release gates and publication evidence.
