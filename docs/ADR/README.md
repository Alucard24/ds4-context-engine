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
| 007 | Core policy remains separable from the Pi adapter | Accepted |
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

Each decision will receive a dedicated record when implementation pressure introduces alternatives or consequences not already covered by the development plan.
