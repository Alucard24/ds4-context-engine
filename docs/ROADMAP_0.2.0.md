# DS4 0.2.0 Roadmap

Status: **planned**. No release date is committed.

Version 0.2.0 focuses on evidence quality, safe project-wide reuse and runtime portability. It extends the released 0.1.0 architecture without changing its canonical-state or failure guarantees.

## Goals

The release targets seven improvements:

1. deterministic context-quality metrics;
2. richer symbol indexing;
3. hybrid lexical and semantic retrieval;
4. cross-session project memory;
5. optional learned ranking;
6. an adapter kit plus one non-Pi reference adapter;
7. optional local KV reuse through an explicit runtime capability.

The existing planner, lexical retrieval and Pi adapter remain the baseline. New behavior that can affect privacy, ranking or provider transport is opt-in until its release gate is satisfied.

## Invariants

Every milestone must preserve these rules:

- Pi JSONL remains canonical for Pi conversation state and memory/pin mutations.
- Live project files remain canonical for project knowledge.
- SQLite contains only disposable projections. Embeddings, symbol graphs, quality aggregates and learned weights are reproducible from canonical sources plus versioned local evaluation inputs, or are discarded when those inputs are unavailable.
- No migration rewrites Pi JSONL or deletes raw history.
- Retrieved content remains quoted, provenance-carrying evidence rather than instructions.
- Tool call/result groups remain atomic.
- Strict compaction validation remains enabled; unsafe output falls back to Pi.
- Remote processing never receives `local-only` content. Semantic and training paths pass through the same privacy policy as prompt construction.
- Manifests and telemetry contain aggregate metadata, hashes and source identifiers, not prompts, private content or provider response IDs.
- Static deterministic ranking remains available as the fallback for every new subsystem.
- A feature-specific failure cannot prevent Pi from continuing with the 0.1 behavior. Privacy enforcement remains fail-closed before remote transport.

## Dependency order

```text
M14 quality baseline ───────────────┐
                                    ├─> M18 learned ranking
M15 symbol index -> M16 semantics ──┤
M17 cross-session memory ───────────┘

M19 adapter kit -> M20 local KV capability
```

M14 is first because adaptive ranking must be measured against a stable baseline. M15 precedes M16 so semantic chunks have structural boundaries. M18 cannot become active until replay evaluation proves it improves over deterministic ranking.

## M14 — Context Quality Metrics

Status: **implemented on `main` for `0.2.0-alpha.1`**. The active planner remains the 0.1 deterministic baseline; quality collection is opt-in and candidate strategies are replay-only.

### Deliverables

- A sanitized replay corpus with expected evidence source IDs and task descriptors.
- Deterministic metrics for evidence recall, irrelevant-token ratio, duplicate evidence, provenance coverage, current-request retention, atomic-group validity, overflow/fallback rate and planning latency.
- Per-category budget utilization and selection/drop reasons in metadata-only diagnostics.
- A comparison harness for 0.1 static ranking versus candidate 0.2 strategies.
- `/context quality` output that exposes aggregate scores and sample counts without content.

### Storage

Quality samples store planner/profile versions, source-kind counts, token totals, decisions, outcome labels and timings. They must not store message, summary, memory, artifact or project text.

### Acceptance

- Replaying an identical fixture produces byte-stable non-timing metric output; wall-clock measurements are reported separately.
- Deleting SQLite and replaying canonical sources reproduces the same quality aggregates.
- Metrics add no more than 10% p95 latency when enabled and effectively no regression when disabled.
- Corrupt or incomplete samples are ignored without affecting planning.

## M15 — Rich Symbol Indexing

Status: **implemented on `main` for `0.2.0-alpha.1`**. Structural parsing remains a disposable local projection; unsupported or invalid source retains deterministic text-window behavior.

### Deliverables

- A parser interface in `ds4-context-core` with deterministic regex fallback.
- Structural chunks for declarations, signatures, parent symbols, imports/references and line ranges.
- Stable symbol IDs derived from project identity, path, file hash and structural location.
- Incremental invalidation at changed-file granularity.
- Initial parser coverage for TypeScript/JavaScript and at least two additional common repository languages, selected by fixture coverage and packaging feasibility.
- Exact symbol, qualified-name and path lookup ahead of fuzzy retrieval.

The parser implementation must not introduce a mandatory native build dependency. A WASM or optional adapter may be used only if clean installation on supported Node versions remains reproducible.

### Acceptance

- False symbol matches are lower than the 0.1 regex baseline on the versioned corpus.
- A file edit invalidates only rows derived from the previous file hash.
- Unsupported or syntactically invalid files fall back to current text chunking.
- Project trust, sensitive-file exclusion and live-hash verification remain enforced.

## M16 — Hybrid Semantic Retrieval

### Deliverables

- A runtime-neutral embedding port; model invocation remains outside core.
- Local embedding as the default supported mode. Remote embedding requires explicit provider/model consent and privacy filtering.
- Derived embedding rows keyed by source hash, chunking version, embedding provider/model and dimensions.
- Hybrid candidate generation using exact identifiers, FTS and vectors.
- Deterministic rank fusion, bounded candidate pools, stable tie-breaking and lexical-only fallback.
- Diagnostics for lexical/vector contribution, model identity, index freshness and fallback reason without storing query or evidence text.

Semantic retrieval does not replace exact matching. Exact paths, symbols, quoted phrases and identifiers retain priority.

### Acceptance

- Hybrid retrieval improves evidence recall on the M14 corpus without exceeding the irrelevant-token regression threshold.
- `local-only` sources and queries never reach a remote embedding provider.
- Model/dimension changes invalidate only the affected derived vectors.
- Missing model, corrupt vector, timeout or provider failure produces a lexical result rather than a planning failure.
- No embedding call occurs in the normal turn when all required vectors and query features are already available locally.

## M17 — Cross-Session Project Memory

### Deliverables

- Discovery of canonical Pi session JSONL files associated with the same trusted canonical project identity.
- Materialization of existing project-scoped memory/pin mutations across those sessions into derived SQLite state.
- Source-session, source-entry, branch, classification, supersession and contradiction provenance for every selected claim.
- Incremental checkpoints per source session and deterministic rebuild after database deletion.
- Explicit diagnostics and commands to inspect contributing sessions and exclude a source session.

Version 0.2.0 does not silently extract new memories from conversation text. A durable item still originates from an explicit canonical memory/pin mutation.

### Acceptance

- No prompt or memory copy is written into project source files or manifests.
- Only sessions for the exact trusted project identity contribute.
- Supersession and branch rules remain deterministic across session order changes.
- Missing, moved, truncated or corrupt session files degrade by excluding unverifiable claims.
- Privacy classification survives materialization and is rechecked for the active provider.

## M18 — Learned Ranking

### Deliverables

- A bounded feature schema based on metadata such as source kind, exact/FTS/vector scores, recency, branch relation, symbol relation, classification eligibility, token cost and prior selection outcome.
- Local training from versioned sanitized replay labels and explicit feedback recorded as classified Pi custom entries; raw text is never a training feature or persisted sample.
- Versioned, checksummed model artifacts with deterministic inference and stable tie-breaking.
- `off`, `shadow` and `active` modes. Shadow mode records aggregate comparison only and does not change context.
- Automatic fallback to the static ranker for missing, incompatible, corrupt or regressing models.

### Promotion gate

The learned ranker may become active only when it:

- improves the primary quality score on held-out repositories;
- does not reduce exact-identifier recall;
- does not increase privacy violations, atomicity failures or overflow;
- stays within the planner latency budget;
- reproduces identical ordering for identical features, model and configuration.

If the gate is not met, 0.2.0 ships shadow mode but keeps static ranking active.

## M19 — Runtime Adapter Kit

### Deliverables

- A documented adapter contract for canonical history snapshots, model limits, tool atomicity, trusted project roots, completion, privacy enforcement and lifecycle shutdown.
- A conformance test kit reusable by adapter packages.
- Capability negotiation so unsupported compaction, provider continuation, embeddings or KV reuse disable only those features.
- One non-Pi reference adapter chosen after a short compatibility spike.
- Packaging rules that keep runtime SDK dependencies outside `ds4-context-core`.

### Acceptance

- Core imports no runtime SDK and passes the existing boundary test.
- The reference adapter passes canonical-history, rebuild, privacy, fallback and lifecycle conformance tests.
- Unsupported capabilities have explicit diagnostics and safe behavior.
- Pi remains fully compatible and shows no regression when the new adapter kit is installed.

## M20 — Local KV Capability

### Deliverables

- An optional adapter capability for local inference runtimes that expose reusable prefix/KV state.
- Eligibility based on exact provider/model, prompt-prefix hash, tool/system options, privacy policy and model revision.
- Conservative invalidation on every prefix, model, option, privacy or runtime change.
- Aggregate hit/miss/saved-prefill diagnostics without cache handles or content.
- Full-prompt replay after any stale, rejected or unavailable KV state.

KV state is an inference optimization, not memory, retrieval evidence or canonical history. Core decides eligibility from hashes; the runtime adapter owns cache handles and transport.

### Acceptance

- Identical eligible prefixes reuse KV state; any changed byte or option rejects reuse.
- Cache loss and runtime restart produce a transparent full replay.
- No cache handle is persisted in Pi JSONL, manifests or DS4 SQLite.
- Privacy filtering runs before prefix verification and cannot be bypassed by cached state.
- Benchmarks report prefill latency/token savings separately from context occupancy.

## Configuration and compatibility

Configuration additions are additive and schema-validated. Names are finalized during each milestone, but the feature groups will map to:

- quality measurement;
- structural project indexing;
- semantic retrieval and embedding policy;
- cross-session project memory;
- learned-ranking mode/model;
- runtime capabilities and local KV reuse.

Semantic retrieval, cross-session memory, learned active ranking and local KV reuse default to disabled for upgrades from 0.1. Existing 0.1 configurations retain their behavior. Unknown or invalid new configuration fails safely through the existing configuration fallback path.

SQLite schema changes use forward migrations plus complete rebuild tests from canonical sources. No 0.2 feature may require a canonical-history migration.

## Delivery sequence

### `0.2.0-alpha.1`

- M14 quality corpus, metrics and comparison harness.
- M15 parser interface, structural chunks and fallback.

### `0.2.0-alpha.2`

- M16 local hybrid retrieval behind an opt-in flag.
- M17 cross-session materialization behind an opt-in flag.

### `0.2.0-beta.1`

- M18 learned ranker in shadow mode.
- Privacy, rebuild, corruption and performance hardening for M14–M18.

### `0.2.0-beta.2`

- M19 adapter contract, conformance kit and reference adapter.
- M20 local KV capability for runtimes that support it.

### `0.2.0-rc.1`

- Upgrade/rebuild testing from 0.1.0 state.
- Long-session dogfooding and provider-switch tests.
- Registry package smoke tests, documentation and release notes.
- Freeze config, database and adapter-contract schemas for 0.2.0.

## Release gates

Version 0.2.0 is ready only when:

1. all 0.1 tests and package-boundary checks still pass;
2. new projections rebuild from canonical sources after complete SQLite deletion;
3. lexical-only operation remains available with no embedding, rank model or KV runtime;
4. privacy E2E tests cover local and explicitly remote embedding paths;
5. cross-session tests cover branch, supersession, corruption and project-identity isolation;
6. learned ranking passes its promotion gate or remains shadow-only;
7. Pi and the reference adapter pass the shared conformance suite;
8. feature-disabled p95 planning latency regresses by no more than 10% from the versioned 0.1 baseline;
9. long-session tests show no canonical corruption, avoidable overflow or unbounded derived growth;
10. `ds4-context-core` and every adapter package use matching versions and pass clean registry-consumer smoke tests;
11. CI passes on the minimum supported Node version and the current LTS line;
12. migration, privacy, limitations and rollback behavior are documented.

## Deferred beyond 0.2.0

Unless required to satisfy a release gate, 0.2.0 does not include automatic memory extraction, summary consensus, a hosted DS4 backend, web UI, visual graph UI, autonomous online training, automatic context-policy tuning or multiple production-grade non-Pi adapters. These remain candidates for later releases.
