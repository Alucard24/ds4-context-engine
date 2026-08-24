# Managed Context Planner

The managed planner is synchronous, deterministic, provider-independent, and does not call an LLM. M6/M7 add bounded historical and project candidates; M8 preprocesses large tool results into verified artifact references while retaining the M3 atomic-turn policy.

## Selection order

1. Replace canonical large text tool outputs with verified bounded artifact references.
2. Estimate the mandatory system prompt and active tool definitions.
3. Derive target and hard message budgets from the active model profile.
4. Group messages by user-turn boundaries.
5. Merge groups linked by assistant tool calls and every matching tool result.
6. Select the current request turn and explicit pin groups as mandatory.
7. Walk older turns newest-first, stopping at the first group that would break the contiguous recent tail, target, or hard limit.
8. Fit source-labelled historical retrieval groups by score under `maxRetrievedHistoryTokens` and the active input target.
9. Fit hash-current project snippet groups by score under `maxProjectTokens` and the remaining input target.
10. Fit active Pi compaction/branch summaries in the remaining summary and input budgets.
11. Restore chronological order, placing historical then project evidence immediately before the current request, and validate the final selection.

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

The retrieval engine produces independent synthetic user-role evidence groups. They are never mandatory: recent turns have priority 100, retrieved history 85, and active summaries 75. Each group is selected or excluded whole, carries its original Pi entry ID, and is represented as `retrieval` in the Context Manifest. If planner validation falls back, every synthetic evidence message is discarded and Pi receives its original `AgentMessage[]` unchanged.

Evidence text is a JSON-quoted historical excerpt with an explicit data-only boundary. It is inserted immediately before the latest real user request, so the current task remains the final message and provider conversation order stays deterministic.

## Project snippets

Trusted project snippets are independent synthetic user-role groups with priority 80: below recent/history and above summaries. Each carries a synthetic source ID plus path, SHA-256, line range, modified flag, score, and Git revision. The project retriever pre-fits `context.maxProjectTokens`; the planner rechecks that dedicated budget together with target/hard input limits.

Project source follows history and precedes the current request. A source group is included whole or excluded whole. Live-hash validation occurs before planning, while planner fallback strips all project and history supplements and returns exactly Pi's native messages.

## Pins

Label an entry in the active Pi context with `ds4:pin` (an optional suffix is allowed). The complete atomic group containing that entry becomes mandatory. Persisted cross-compaction pin reinjection and dedicated pin commands remain scheduled for M9; v1 only recognizes labelled entries already present in Pi's active context.

## Fail-open behavior

DS4 returns Pi's original `AgentMessage[]` when:

- fixed system/tool overhead exceeds the hard input limit;
- current and pinned groups exceed the hard message budget;
- atomic tool validation fails;
- the current user message is absent from the selection;
- final estimated input exceeds the hard limit;
- an unexpected adapter or planner exception occurs.

Expected fallbacks are recorded in the Context Manifest. Set `context.mode` to `observer` to disable all message replacement while retaining manifests and usage calibration.

## Current limits

The planner does not call a model inside the `context` hook. Historical and project retrieval are lexical; semantic reranking is intentionally disabled even if configured. Project symbol extraction is heuristic rather than parser-backed. Artifact search is literal and requires an explicit current-branch Artifact ID. Durable cross-compaction pins and automatic memory extraction remain later milestones.
