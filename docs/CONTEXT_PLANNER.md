# Managed Context Planner

The managed planner is synchronous, deterministic, provider-independent, and does not call an LLM. M9 adds event-sourced persistent pins and durable memory while retaining historical/project retrieval, artifact preprocessing, and the M3 atomic-turn policy.

## Selection order

1. Replace canonical large text tool outputs with verified bounded artifact references.
2. Estimate the mandatory system prompt and active tool definitions.
3. Derive target and hard message budgets from the active model profile.
4. Group messages by user-turn boundaries.
5. Merge groups linked by assistant tool calls and every matching tool result.
6. Select the current request, labelled pin groups, and applicable persistent pins as mandatory.
7. Enforce `maxPinnedTokens`, then fit relevant durable memory under `maxMemoryTokens`.
8. Walk older turns newest-first, stopping at the first group that would break the contiguous recent tail, target, or hard limit.
9. Fit source-labelled historical retrieval groups by score under `maxRetrievedHistoryTokens` and the active input target.
10. Fit hash-current project snippet groups by score under `maxProjectTokens` and the remaining input target.
11. Fit active Pi compaction/branch summaries in the remaining summary and input budgets.
12. Restore deterministic order—pins, memory, history, project, current request—and validate the final selection.

The recent-tail ceiling adapts to model size:

| Context window | Maximum automatic tail |
|---|---:|
| up to 40k | 12k |
| up to 128k | 24k |
| up to 256k | 32k |
| larger | 64k |

`context.recentTailTokens` can lower these ceilings.

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

## Fail-open behavior

DS4 returns Pi's original `AgentMessage[]` when:

- fixed system/tool overhead exceeds the hard input limit;
- persistent/native pins exceed the pin or hard message budget;
- atomic tool validation fails;
- the current user message is absent from the selection;
- final estimated input exceeds the hard limit;
- an unexpected adapter or planner exception occurs.

Expected fallbacks are recorded in the Context Manifest. Set `context.mode` to `observer` to disable all message replacement while retaining manifests and usage calibration.

## Current limits

The planner does not call a model inside the `context` hook. Historical/project retrieval and memory ranking are lexical; semantic reranking is intentionally disabled even if configured. Project symbol extraction is heuristic, artifact search is literal, and memory/pin creation is manual-first. Automatic memory extraction remains disabled until conservative confirmation and privacy policy exist.
