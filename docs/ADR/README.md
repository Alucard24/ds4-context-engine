# Architecture Decision Records

The initial decisions from the development plan are accepted:

| ADR | Decision | Status |
|---|---|---|
| 001 | Pi remains the agent runtime | Accepted |
| 002 | Pi JSONL is the canonical source; SQLite is rebuildable | Accepted |
| 003 | Compaction creates derived artifacts and never destroys raw history | Accepted |
| 004 | The Pi `context` hook is the primary integration point | Accepted |
| 005 | Lexical and exact retrieval precede semantic retrieval | Accepted |
| 006 | Provider continuation/cache state is non-canonical | Accepted |
| 007 | Core policy is published separately from the Pi adapter | Accepted |
| 008 | Fail open to Pi's native behavior | Accepted |
| 009 | Use built-in `node:sqlite` behind a storage adapter for M0 | Accepted |
| 010 | Scope Pi's short entry IDs by session in the derived database | Accepted |
| 011 | Validate append-only checkpoints by byte offset and physical-line hash | Accepted |
| 012 | Persist Context Manifests without prompt or message content | Accepted |
| 013 | Correlate each assistant response with the most recent pending manifest | Accepted |
| 014 | Use deterministic whole-turn fitting and fail open on unsafe plans | Accepted |
| 015 | Treat `ds4:pin` labels on active entries as mandatory atomic groups | Accepted |
| 016 | Preserve Pi's compaction cut point and replace only summary generation | Accepted |
| 017 | Reject invalid custom summaries and fall back to Pi's generator | Accepted |
| 018 | Store summary provenance in canonical Pi details and derived SQLite rows | Accepted |
| 019 | Keep summary nodes immutable and represent replacement only with parent-child edges | Accepted |
| 020 | Resolve the aggregation predecessor from Pi's active branch, never session-global recency | Accepted |
| 021 | Embed newly created non-active nodes in Pi details for complete graph reconstruction | Accepted |
| 022 | Correlate compaction commits by pending summary ID, not duplicate summary text | Accepted |
| 023 | Rank literal identifiers and phrases ahead of FTS; semantic retrieval stays optional | Accepted |
| 024 | Inject automatic historical evidence only from Pi's active branch | Accepted |
| 025 | Treat retrieved text as JSON-quoted data and discard it on planner fallback | Accepted |
| 026 | Never enumerate or query project knowledge without Pi project trust | Accepted |
| 027 | Validate live file hashes before injection and retain prior snippets only as stale derived rows | Accepted |
| 028 | Treat project source as JSON-quoted untrusted data and discard it on planner fallback | Accepted |
| 029 | Record Git revision metadata but keep live files, not Git or SQLite, canonical | Accepted |
| 030 | Keep full tool results canonical in Pi JSONL; condense only provider-facing copies | Accepted |
| 031 | Address artifact objects by verified SHA-256 and separate deduplicated bytes from source references | Accepted |
| 032 | Permit artifact search only by explicit current-branch reference with bounded redacted literal excerpts | Accepted |
| 033 | Disable artifact offload for observer and ephemeral sessions | Accepted |
| 034 | Persist memory and pin mutations as versioned Pi custom entries; keep SQLite materialized | Accepted |
| 035 | Require manual creation and explicit supersession; never silently overwrite durable claims | Accepted |
| 036 | Make branch pins conditional on their creation leaf appearing in Pi's active branch | Accepted |
| 037 | Treat pins as user-confirmed mandatory context and memory as quoted historical data | Accepted |
| 038 | Share project-scoped state only for the same trusted canonical project path | Accepted |
| 039 | Disable durable memory and pin mutation for observer and ephemeral sessions | Accepted |
| 040 | Treat every provider as remote unless its exact ID is explicitly configured local | Accepted |
| 041 | Reject `local-only` in all remote allow rules and prevent marker-based downgrades | Accepted |
| 042 | Sanitize native context before planning and omit prohibited synthetic source groups whole | Accepted |
| 043 | Recheck provider-specific serialization in `before_provider_request` without logging payloads | Accepted |
| 044 | Fail closed with placeholders/empty payload when privacy enforcement fails | Accepted |
| 045 | Persist pin/memory/artifact/summary classifications through their canonical or rebuildable metadata | Accepted |
| 046 | Load DS4 last when later extensions could replace provider payloads | Accepted |
| 047 | Keep native continuation disabled until provider storage is explicitly acknowledged | Accepted |
| 048 | Wrap only explicitly profiled OpenAI Responses providers and delegate serialization/transport to Pi | Accepted |
| 049 | Send a continuation delta only after exact request-option and request-plus-response prefix hashes match | Accepted |
| 050 | Retry rejected stale continuation state once with the complete managed replay before exposing output | Accepted |
| 051 | Keep continuation handles volatile and exclude them from manifests, logs, and DS4 persistence | Accepted |
| 052 | Compile `ds4-context-core` as ESM and keep the Pi adapter dependency one-way | Accepted |

Each decision will receive a dedicated record when implementation pressure introduces alternatives or consequences not already covered by the development plan.
