# Managed Context Planner

The managed planner is synchronous, deterministic, provider-independent, and does not call an LLM. M11 resolves an exact provider/model profile, robust estimator calibration, and adaptive category limits before M10 privacy-aware selection, while retaining event-sourced memory/pins, historical/project retrieval, artifact preprocessing, and atomic turns.

## Selection order

1. Classify and sanitize native messages, system prompt, and active tool definitions for the provider destination.
2. Replace allowed canonical large text tool outputs with verified bounded artifact references and preserve their classification.
3. Estimate the sanitized mandatory system prompt and active tool definitions.
4. Resolve exact model overrides and a bounded calibration window, then derive estimator-adjusted target, hard, recent-tail, historical, and project budgets.
5. Group messages by user-turn boundaries.
6. Merge groups linked by assistant tool calls and every matching tool result.
7. Select the current request, labelled pin groups, and applicable allowed persistent pins as mandatory.
8. Enforce `maxPinnedTokens`, then fit relevant allowed durable memory under `maxMemoryTokens`.
9. Walk older turns newest-first, stopping at the first group that would break the contiguous recent tail, target, or hard limit.
10. Privacy-filter and fit source-labelled historical retrieval groups under `maxRetrievedHistoryTokens`.
11. Privacy-filter and fit hash-current project snippets under `maxProjectTokens`.
12. Fit active allowed Pi compaction/branch summaries in the remaining summary and input budgets.
13. Restore deterministic order—pins, memory, history, project, current request—and validate privacy, atomicity, current-turn presence, and hard limits.

Recent and retrieval ceilings adapt to model size:

| Context window | Maximum automatic tail | Historical retrieval | Project retrieval |
|---|---:|---:|---:|
| up to 40k | 12k | 4k | 4k |
| up to 128k | 24k | 8k | 12k |
| up to 256k | 32k | 16k | 20k |
| larger | 64k | 32k | 32k |

The corresponding `context.*Tokens` setting can lower each automatic ceiling; an exact model override can replace it. An accepted model-specific `actual / chars-v1` ratio converts provider-token capacities into local-estimator units without changing the raw estimate recorded for future samples. See [`MODEL_AWARENESS.md`](MODEL_AWARENESS.md).

## Atomicity

A user turn is selected as a whole. Assistant messages containing one or more tool calls are merged with all matching tool-result messages. A selected call without every result, or a selected result without its call, invalidates the plan.

## Artifact preprocessing

Artifact condensation occurs before atomic grouping. It preserves `toolCallId`, `toolName`, `isError`, and all non-text content, so a multi-tool assistant request and every result remain one valid atomic group. The full text stays canonical in Pi JSONL; only the provider-facing copy changes. A planner fallback returns artifactized native messages only when offload itself succeeded, and never includes history/project supplements.

## Retrieved history

The retrieval engine produces independent synthetic user-role evidence groups. They are never mandatory: recent turns have priority 100, durable memory 90, retrieved history 85, project snippets 80, and active summaries 75. Each group is selected or excluded whole, carries its original Pi entry ID, and is represented as `retrieval` in the Context Manifest. If planner validation falls back, every synthetic evidence message is discarded and Pi receives its original `AgentMessage[]` unchanged.

Evidence text is a JSON-quoted historical excerpt with an explicit data-only boundary. It is inserted immediately before the latest real user request, so the current task remains the final message and provider conversation order stays deterministic.

## Project snippets

Trusted project snippets are independent synthetic user-role groups with priority 80: below recent/history and above summaries. Each carries a synthetic source ID plus path, SHA-256, line range, modified flag, score, and Git revision. The project retriever pre-fits `context.maxProjectTokens`; the planner rechecks that dedicated budget together with target/hard input limits.

Project source follows history and precedes the current request. A source group is included whole or excluded whole. Live-hash validation occurs before planning, while planner fallback strips all project and history supplements and returns exactly Pi's native messages.

## Pins and durable memory

Entry labels beginning with `ds4:pin` still make their complete native atomic group mandatory. M9 additionally materializes explicit `/context pin` mutations from Pi custom entries. Session pins cross branch/compaction boundaries; branch pins require their creation leaf on `getBranch()`; project pins require the same trusted project path. They are synthetic user-role groups with priority 950 and must fit `context.maxPinnedTokens` as a whole.

Durable memory is independently ranked at priority 90. Exact request terms and normalized keys outrank recent fallback items. When at least one item matches, unrelated items are removed; otherwise at most three recent items provide continuity. The memory manager pre-fits `memory.maxResults` and `context.maxMemoryTokens`, and the planner rechecks target/hard limits.

Both categories are inserted before historical/project evidence and immediately before the real current user turn. Manifest source IDs are pin/memory IDs with separate canonical source provenance.

## Privacy fitting

Native messages are sanitized rather than removed, preserving complete current turns and tool batches. Pin, memory, retrieval, and project supplements are independent groups: any supplement containing a provider-prohibited block is omitted whole and receives an `excluded due to privacy policy` manifest item. Classification is carried into selected/excluded planner metadata and does not alter ranking within the allowed set.

The final provider hook rechecks actual provider-specific serialization. This protects system/tool payloads and compaction calls that do not pass through normal planner selection. See [`PRIVACY.md`](PRIVACY.md).

## Fail-open behavior

With privacy disabled, DS4 returns Pi's original `AgentMessage[]` when:

- fixed system/tool overhead exceeds the hard input limit;
- persistent/native pins exceed the pin or hard message budget;
- atomic tool validation fails;
- the current user message is absent from the selection;
- final estimated input exceeds the hard limit;
- an unexpected adapter or planner exception occurs.

Expected fallbacks are recorded in the Context Manifest. With privacy enabled, the fallback baseline is the sanitized native array—not raw Pi messages—and an unexpected privacy failure replaces content/payload fields instead of sending unchecked data. Observer mode disables planning but still enforces enabled privacy policy and records manifests/usage calibration.

## Current limits

The planner does not call a model inside the `context` hook. Model calibration uses only finalized provider usage and deterministic local statistics. Historical/project retrieval and memory ranking are lexical; semantic reranking is intentionally disabled even if configured. Project symbol extraction is heuristic, artifact search is literal, and memory/pin creation is manual-first. Automatic memory extraction remains disabled; M10 supplies policy enforcement but not an automatic classifier or confirmation workflow. Provider-payload coverage targets Pi 0.84.3's supported serializers, and DS4 must load after any extension allowed to replace payloads when strict final ordering is required.
