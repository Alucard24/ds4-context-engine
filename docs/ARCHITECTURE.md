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
  -> serialize only the newly discarded segment and preserve Pi's retained boundary
  -> generate and validate an immutable segment node
  -> resolve the prior root from the active Pi branch only
  -> generate and validate a bounded aggregate node when a prior root exists
  -> wrap generated nodes with their highest inherited classification for provider-switch safety
  -> atomically persist prepared nodes/edges and return only the active root to Pi

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

## Boundaries

Dependency direction is one-way:

```text
Pi native types and lifecycle
        ↓
ds4-context-engine (src/pi-adapter + src/extension)
        ↓
ds4-context-core (packages/core)
```

`ds4-context-core` is compiled ESM and has no dependency on Pi. Its workspace contains:

- `packages/core/src/core`: portable model profiles, robust calibration, adaptive category limits, budgets and token-estimation policy;
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
- `packages/core/src/persistence`: rebuildable session/project/vector/memory/pin/quality SQLite state, repositories, FTS5, event replay and transactional migrations;
- `packages/core/src/manifest` and `packages/core/src/shared`: runtime-neutral projections, provenance, hashing, stable serialization and logging.

The root `ds4-context-engine` package is the Pi adapter:

- `src/pi-adapter`: byte-safe Pi JSONL reading, provenance mapping, custom mutation projection, active label discovery, checkpoints, runtime snapshots, Pi model completion for summaries and the narrow Pi-AI OpenAI Responses transport wrapper;
- `src/extension`: Pi hooks, lifecycle, command presentation and fail-open/fail-closed orchestration.

The adapter may import core exports. Core source must never import `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `src/pi-adapter` or `src/extension`; an automated boundary test enforces this rule.

## Canonical and derived state

The Pi session JSONL remains canonical for conversation/tool state, inline classification markers, and append-only classified memory/pin custom mutations; live files remain canonical for project knowledge. Native continuation keeps only volatile request/response-item hashes plus the minimum response handle and creates no continuation table or custom entry. SQLite and content-addressed object files store only rebuildable indexes, source-hash/model-keyed vectors, summary nodes/edges, metadata-only manifests, project file/snippet projections, artifact copies/references, materialized memory/pins, calibration data, and bounded metadata-only quality samples. Each aggregate's active text is the Pi compaction summary; non-active nodes created by the same operation are embedded in its details, while older ancestors remain in earlier entries. Deleting the database must never damage or alter a Pi session or project. Reopening a source session replays its memory/pin mutations. Ephemeral sessions keep manifests and graph nodes in memory, disable durable memory/pins/artifacts, and may share the project index because files—not session JSONL—are its durable source.

## Lifecycle

Database resources are opened during `session_start`, not from the extension factory. Eligible provider wrappers are registered after trusted configuration loads, and their volatile continuation manager is reset for every session lifecycle. Resources are closed idempotently during `session_shutdown`. Reload and session replacement therefore cannot reuse stale `SessionManager` instances, database handles, or provider continuation state.

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

Configuration, database, session/project indexing, memory/pin replay, artifact offload/search, retrieval, planning, observer, native continuation, quality measurement, and diagnostics failures are caught at the extension boundary. Session index failures retain the previous transactional snapshot. Cross-session source failures exclude only the unverifiable source and retain explicit diagnostics; they do not disable current-session memory. Historical and project FTS errors degrade to exact matches; embedding consent/privacy/model/timeout/corruption/provider failures degrade to lexical results; project subsystem failure contributes no snippets without disabling session management. Expected planning hazards produce an explicit fallback manifest and discard synthetic evidence.

Privacy is the exception to ordinary fail-open behavior. Once enabled, planner failures return the sanitized native array, preparation failures replace message content with structural placeholders, and provider-payload sanitizer failures return an empty object so the remote request fails rather than receiving unchecked content. Pi 0.84.3 runs provider-payload handlers in extension load order, so DS4 should be loaded last when other extensions can rewrite provider payloads.
