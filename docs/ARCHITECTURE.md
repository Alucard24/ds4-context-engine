# Architecture

## Current vertical slice

```text
Pi session_start
  -> trusted configuration merge
  -> derived SQLite bootstrap and migrations
  -> validate Pi JSONL v3 header
  -> full index or checkpointed append sync
  -> replay versioned memory/pin custom-entry mutations into transactional projections
  -> when opted in and trusted, checkpoint/replay explicit project mutations from exact-identity sibling Pi sessions
  -> if trusted, canonicalize project root and incrementally index bounded text files
  -> parse TypeScript/JavaScript/Python/Go declaration boundaries through the runtime-neutral parser interface
  -> fall back deterministically to bounded text windows when adapters, syntax, or language support are unavailable
  -> persist only rebuildable symbol/signature/parent/import/reference projections
  -> when semantic retrieval is opted in, refresh source-hash/model-keyed vectors through the runtime embedding port
  -> snapshot Git root/branch/HEAD/dirty paths

Pi context hook
  -> incrementally index newly appended JSONL records
  -> classify/sanitize native messages, system prompt, and active tool definitions for the selected provider
  -> retain protocol/atomic structure while replacing prohibited native spans
  -> map AgentMessage[] back to active SessionEntry provenance
  -> offload exact-source large text tool results to content-addressed objects
  -> preserve tool identity/images and substitute bounded redacted references
  -> snapshot effective system prompt and active tool schemas
  -> resolve exact provider/model overrides and bounded calibration window
  -> derive adaptive recent/history/project limits for the resolved context window
  -> compute calibrated system/tool overhead and message budget
  -> group turns and tool exchanges atomically
  -> preserve current request, labelled ds4:pin groups, and persistent applicable pins
  -> branch-filter pins and fit mandatory pin budget
  -> rank relevant session/project memory under its dedicated budget
  -> select a contiguous, model-adaptive recent tail
  -> derive current-task identifiers, files, errors, phrases and keywords
  -> query exact matches and FTS5 over canonical indexed entries
  -> optionally add bounded cosine-ranked history candidates and deterministic lexical/vector rank fusion
  -> reject active-context duplicates and all alternate-branch candidates
  -> rank, deduplicate, quote and budget historical evidence groups
  -> query exact literal path and qualified/simple declaration indexes ahead of phrase and project FTS5 candidates
  -> optionally add bounded project vectors while retaining exact path/symbol priority
  -> live-validate candidate SHA-256 and reindex only changed-file projections
  -> rank, overlap-deduplicate, quote and budget project source groups
  -> omit prohibited history/project/pin/memory supplements with metadata-only privacy reasons
  -> fit active Pi summaries in the remaining budget
  -> validate hard limit, current request, and tool call/results
  -> return selected messages or fail open to the already privacy-sanitized native context
  -> persist metadata-only Context Manifest, privacy counters, and prompt hash
  -> when opted in, queue the completed metadata-only manifest for deferred quality measurement

Pi agent_settled / shutdown
  -> materialize and persist bounded content-free quality counts without changing the plan

before_provider_request
  -> recheck provider-specific serialized system/messages/tools/content
  -> strip control markers and redact remote credential-like values
  -> return a sanitized payload; replace it with an empty object on enforcement failure
  -> update the pending metadata-only privacy manifest

optional OpenAI Responses provider wrapper
  -> run only for the canonical agent session, managed mode, explicit provider/model profiles, and provider-storage consent
  -> hash the complete sanitized input and non-input request options without retaining payload text
  -> require an exact previous-request + previous-response prefix before sending only the new suffix
  -> set `store: true` and attach the volatile `previous_response_id` only after validation
  -> retry a rejected stale handle once through the complete managed replay before exposing stream events
  -> record metadata-only mode/item counts/retry/invalidation diagnostics; never record the provider handle

optional local runtime KV port (non-Pi adapters)
  -> require opt-in configuration plus a negotiated versioned local-KV capability
  -> apply current privacy policy before runtime-specific prefix/options extraction
  -> hash exact prefix bytes, provider/model/revision, options, privacy policy, runtime revision and capability version
  -> let the runtime port map only the fingerprint to its volatile native handle
  -> replay the complete sanitized payload after miss, stale rejection, unavailable state or runtime restart
  -> report aggregate hits/misses/saved-prefill/replay latency separately from context occupancy
  -> never place handles, prefixes or payloads in canonical history, manifests, SQLite or diagnostics

assistant message_end
  -> attach uncached input plus cache read/write usage to the pending manifest
  -> append one exact provider/model calibration sample
  -> make the robust bounded median available to the next call

tool_execution_end
  -> schedule project refresh for write/edit/bash and unknown tools

context_artifact_search
  -> require current-session/current-branch reference
  -> verify SHA-256 and return bounded redacted literal-match excerpts
  -> apply the persisted artifact classification for the active provider

model_select
  -> mark a provider/model change as a cold cache boundary
  -> invalidate volatile native-continuation state
  -> retain exact-model calibration/profile history and all canonical state
  -> rerun destination privacy policy on the next context build

agent_settled
  -> final incremental session and project index sync
  -> request proactive compaction once per leaf at the resolved model threshold

session_before_compact
  -> map Pi preparation messages to exact canonical entry IDs
  -> privacy-sanitize discarded text/instructions/file lists for the active provider
  -> preflight the complete sanitized request against the calibrated model input budget
  -> when needed, split at contiguous message boundaries while keeping matching tool calls/results atomic
  -> generate and validate each immutable segment against only its own sanitized evidence
  -> resolve the prior root from the active Pi branch only
  -> recursively generate and validate bounded ordered aggregate layers until one root remains
  -> wrap generated nodes with their highest inherited classification for provider-switch safety
  -> atomically persist the complete prepared graph and return only one active root to Pi

session_compact / session_compact_failed
  -> commit or fail prepared summary lifecycle
  -> reconcile Pi JSONL details into rebuildable SQLite state

session_tree / shutdown
  -> invalidate volatile native-continuation state
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
  -> query terms, lexical/vector/fused counts, embedding profile/freshness/fallback, branch blocks, budgets and excerpts

/context project
  -> trust, Git revision, file/snippet/stale/vector counts, retrieval decisions and local excerpts

/context pins | pin | unpin
  -> inspect or append immutable session/branch/project pin mutations

/context memory
  -> inspect, add, explicitly supersede, invalidate or expire durable claims

/context privacy
  -> provider destination, allow set, selected classifications, block/redaction counts and final-check status

/context model
  -> effective profile, override precedence, calibration/outliers, adaptive budgets, cache metrics and switch state

/context continuation
  -> explicit storage consent, provider wrappers, full/native counts, saved items, retries and invalidations without response IDs

/context artifacts
  -> content-addressed object/reference counts, integrity, savings and active-branch IDs

/context rebuild-index
  -> transactional reconciliation from canonical JSONL, memory/pin replay, artifact regeneration and forced project rescan
```

## Context persistence tool boundary

`context_persistence` is a Pi-adapter capability, not a portable-core or reference-adapter API. Its controller calls `Ds4ContextRuntime` directly rather than relaying slash commands. Read actions use bounded keyset/visible-item APIs and emit only allowlisted metadata plus policy-sanitized find previews. Every LLM-callable write fails closed without Pi UI and requires a fresh local confirmation; model-provided consent fields are not accepted.

Pin and Memory mutations resolve provenance from the active Pi branch, revalidate it after confirmation, append the existing `ds4-context-pin-v1` or `ds4-context-memory-v1` record through `pi.appendEntry()`, and then reconcile the disposable projection. Exact revisions bind target state to active session/project/branch context. Project-source include/exclude resolves a volatile `sourceRef` to an internal session identity and updates only coordinated SQLite policy—never Pi JSONL.

Historical tool arguments and results are a provider-egress surface even when general privacy is disabled. A dedicated guard removes content, query, key, reason, paths and raw errors while preserving only action linkage and safe IDs/revisions. Provenance IDs and source paths are runtime-derived; the model cannot supply them in the V1 schema. Post-append failures distinguish an indeterminate append from a known canonical commit with pending projection, so callers are never encouraged to retry blindly.

## Optional anchored editing

After trusted configuration loads at `session_start`, `editing.anchored` can
register a same-name native `edit` wrapper (default off, also gated by `enabled`).
The Pi extension resolves exact `head[upto]tail` ranges inside the native edit read
operation, under Pi's shared file mutation queue, then delegates batch checks,
cancellation, BOM/EOL handling, writing and diffs to native edit. Expansion never
rewrites canonical tool-call arguments. Calls without anchors retain native fuzzy
matching; every edit in an anchored batch must match exactly to prevent native
fuzzy rematching from moving its ranges. Invalid anchored edits fail closed.
No inference-state control is involved.
See [anchored editing](ANCHORED_EDITING.md) and [ADR 059](ADR/059-optional-anchored-editing.md).

## Other optional portable agent tools

`editing.postEditReport` derives bounded old/new coordinates, line deltas and
updated context from the actual native patch, independently of anchored editing.
`reading.adaptive` wraps native read with execution-time model-aware default line
limits; explicit limits and image/byte handling stay native. Both wrappers restore
native definitions when disabled and do not initially claim other tool overrides.

`artifacts.adaptiveBudget` is a pure portable-core policy applied per context to
privacy-prepared messages. It uses the calibrated planner budget and estimated
fixed overhead to lower inline/excerpt caps, never raises configured limits, and
preserves source identities and canonical history. Rebuild uses a conservative
floor to reconstruct earlier adaptive references. Normal planner fallback remains
responsible for oversized mandatory context.

`src/tools/bash-job-manager.ts` and `src/extension/bash-job-tool.ts` form a separate
optional local job module. It delegates process execution/cancellation to Pi's
public BashOperations, limits concurrency/log storage, enforces session/branch
ownership and requires local confirmation for starts. Jobs survive compaction but
not session replacement/reload/shutdown; compaction appends bounded metadata only.
There is no new agent loop, SQLite state, automatic model turn or backend KV control.

All new switches are default-off and master-gated. See [portable agent tools](PORTABLE_AGENT_TOOLS.md)
and [ADR 060](ADR/060-optional-portable-agent-tools.md).

## Boundaries

Dependency direction is one-way:

```text
Pi native types and lifecycle                 callback/JSONL runtime
        ↓                                              ↓
ds4-context-engine                        ds4-context-reference-adapter
        └──────────────────────┬───────────────────────┘
                               ↓
                  ds4-context-core (packages/core)
```

`ds4-context-core` is compiled ESM and has no dependency on Pi. Its workspace contains:

- `packages/core/src/adapter`: versioned runtime contract, canonical tool-group validation, isolated capability negotiation, exact local-KV eligibility/replay orchestration and framework-neutral conformance runner;
- `packages/core/src/core`: portable canonical messages, model profiles, robust calibration, adaptive category limits, budgets and token-estimation policy;
- `packages/core/src/continuation`: hashed-prefix continuation decisions without provider transport or response APIs;
- `packages/core/src/config`: runtime-neutral configuration model and filesystem loader;
- `packages/core/src/planner`: atomic grouping, deterministic ranking, fitting, validation and privacy-aware plans;
- `packages/core/src/privacy`: classification markers, provider allow rules, recursive sanitization, secret redaction, fail-closed payload policy and diagnostics;
- `packages/core/src/memory`: mutation projections, conservative contradiction/key detection, scope selection, prompt boundaries, ranking and diagnostics;
- `packages/core/src/artifacts`: atomic content-addressed files, deterministic condensation, redaction, branch-safe literal search, reconciliation and garbage collection;
- `packages/core/src/compaction`: structured summary contract, hierarchical graph model, validation, lifecycle metadata and source hashing;
- `packages/core/src/retrieval`: task descriptors, safe FTS queries, runtime-neutral embedding port, semantic index orchestration, deterministic rank fusion, evidence quoting, quality comparison, deduplication and token fitting;
- `packages/core/src/project`: trust-gated file discovery, hashing, Git state, symbol/chunk extraction, invalidation, retrieval and source quoting;
- `packages/core/src/quality`: versioned replay fixtures/contracts, deterministic metrics, static/candidate comparison and metadata-only aggregation;
- `packages/core/src/ranking`: bounded metadata-only features, classified label contracts, deterministic local training, checksummed model artifacts, aggregate shadow comparison and promotion-gated inference;
- `packages/core/src/persistence`: rebuildable session/project/vector/memory/pin/quality SQLite state, repositories, FTS5, event replay, transactional migrations, storage diagnostics, cooperative database-client leases and offline copy–validate–swap maintenance;
- `packages/core/src/manifest` and `packages/core/src/shared`: runtime-neutral projections, provenance, bounded persisted-manifest serialization, hashing, stable serialization and logging.

The `packages/reference-adapter` workspace is the non-Pi reference adapter: it reads bounded append-only canonical JSONL, injects completion through a host callback, enforces privacy at that callback boundary, rebuilds disposable snapshots and explicitly disables unsupported native features. A local host can inject a handle-free `LocalKvRuntimePort`; the port alone retains native handles and transport while core receives only exact prefix bytes transiently for hashing.

The root `ds4-context-engine` package is the Pi adapter:

- `src/pi-adapter`: byte-safe Pi JSONL reading, provenance mapping, memory/pin and learned-ranking label projection, active label discovery, checkpoints, runtime snapshots, Pi model completion for summaries and the narrow Pi-AI OpenAI Responses transport wrapper;
- `src/extension`: Pi hooks, lifecycle, command presentation and fail-open/fail-closed orchestration.

Adapters may import core exports. Core source must never import `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `src/pi-adapter`, `src/extension` or a reference-adapter source path; an automated boundary test enforces this rule. Runtime SDK dependencies belong only to their adapter package.

## Canonical and derived state

The Pi session JSONL remains canonical for conversation/tool state, inline classification markers, append-only classified memory/pin mutations and metadata-only learned-ranking feedback/replay labels; live files remain canonical for project knowledge. Volatile `context_persistence` source-reference/revision maps and derived project-source exclusion policy are local process/SQLite state and are never canonical. Native continuation keeps only volatile request/response-item hashes plus the minimum response handle and creates no continuation table or custom entry. SQLite and content-addressed object files store only rebuildable indexes, source-hash/model-keyed vectors, summary nodes/edges, metadata-only manifests, project file/snippet projections, artifact copies/references, materialized memory/pins, calibration data, and bounded metadata-only quality samples. The checksummed learned-ranking model is a separate disposable local artifact reconstructed from canonical labels; it contains bounded weights and aggregate gate metadata, never raw text. Each aggregate's active text is the Pi compaction summary; non-active nodes created by the same operation are embedded in its details, while older ancestors remain in earlier entries. Deleting the database must never damage or alter a Pi session or project. Reopening a source session replays its memory/pin mutations. Ephemeral sessions keep manifests and graph nodes in memory, disable durable memory/pins/artifacts, and may share the project index because files—not session JSONL—are its durable source.

## Lifecycle

Database resources are opened during `session_start`, not from the extension factory. Before a file-backed database is opened, the runtime performs a two-phase maintenance-lock check around creation of a private process client lease. A maintenance lock prevents the open and leaves Pi on the existing degraded fallback; a maintenance utility refuses active or ambiguous leases. Eligible provider wrappers are registered after trusted configuration loads, and their volatile continuation manager is reset for every session lifecycle. Resources are closed idempotently during `session_shutdown`, with SQLite closed before the client lease is released. Reload and session replacement therefore cannot reuse stale `SessionManager` instances, database handles, or provider continuation state.

## SQLite choice

M0 uses Node's built-in `node:sqlite` `DatabaseSync`. This avoids a native third-party runtime dependency while matching Pi's Node `>=22.19.0` requirement. Access is wrapped inside `ContextDatabase`, so replacing the driver does not affect core or Pi-adapter code.

Session entries use a scoped key (`session_id:entry_id`) because Pi's short entry IDs are guaranteed unique only inside one session. The original Pi entry ID remains stored separately for provenance and parent traversal.

Database settings:

- WAL for file-backed databases;
- foreign keys enabled;
- 5-second busy timeout;
- transactional, checksummed migrations;
- FTS5 tables created by schema migration;
- containing/client-lease directories mode `0700` and database/protocol files mode `0600` where supported;
- global manifest retention of 128 with online prune bounded to 32 rows and 8 MiB;
- persisted manifest projection preferred at 256 KiB and hard-skipped above 1 MiB after deterministic excluded-only rollup;
- provider usage updated in scalar columns without rewriting the manifest JSON;
- physical compaction only through the explicit offline maintenance state machine.

## Failure policy

Configuration, database, session/project indexing, memory/pin replay, artifact offload/search, retrieval, planning, observer, native continuation, quality measurement, and diagnostics failures are caught at the extension boundary. Manifest serialization/persistence/retention failure never changes a planned provider request; the complete manifest remains in memory and usage calibration falls back to a bounded volatile sample when correlation is unavailable. A maintenance lock prevents SQLite startup and emits only categorical local diagnostics while Pi continues on fallback. Session index failures retain the previous transactional snapshot. Cross-session source failures exclude only the unverifiable source and retain explicit diagnostics; they do not disable current-session memory. Historical and project FTS errors degrade to exact matches; embedding consent/privacy/model/timeout/corruption/provider failures degrade to lexical results; project subsystem failure contributes no snippets without disabling session management. Expected planning hazards produce an explicit fallback manifest and discard synthetic evidence.

Privacy is the exception to ordinary fail-open behavior. Once enabled, planner failures return the sanitized native array, preparation failures replace message content with structural placeholders, and provider-payload sanitizer failures return an empty object so the remote request fails rather than receiving unchecked content. Pi 0.84.3 runs provider-payload handlers in extension load order, so DS4 should be loaded last when other extensions can rewrite provider payloads.
