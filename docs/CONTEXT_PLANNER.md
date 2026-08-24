# Managed Context Planner

The managed planner is synchronous, deterministic, provider-independent, and does not call an LLM. M6 adds bounded lexical retrieval candidates while retaining the M3 atomic-turn policy.

## Selection order

1. Estimate the mandatory system prompt and active tool definitions.
2. Derive target and hard message budgets from the active model profile.
3. Group messages by user-turn boundaries.
4. Merge groups linked by assistant tool calls and every matching tool result.
5. Select the current request turn and explicit pin groups as mandatory.
6. Walk older turns newest-first, stopping at the first group that would break the contiguous recent tail, target, or hard limit.
7. Fit source-labelled historical retrieval groups by score under `maxRetrievedHistoryTokens` and the active input target.
8. Fit active Pi compaction/branch summaries in the remaining summary and input budgets.
9. Restore chronological order, placing evidence immediately before the current request, and validate the final selection.

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

## Retrieved history

The retrieval engine produces independent synthetic user-role evidence groups. They are never mandatory: recent turns have priority 100, retrieved history 85, and active summaries 75. Each group is selected or excluded whole, carries its original Pi entry ID, and is represented as `retrieval` in the Context Manifest. If planner validation falls back, every synthetic evidence message is discarded and Pi receives its original `AgentMessage[]` unchanged.

Evidence text is a JSON-quoted historical excerpt with an explicit data-only boundary. It is inserted immediately before the latest real user request, so the current task remains the final message and provider conversation order stays deterministic.

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

The planner does not call a model inside the `context` hook. Retrieval is lexical and session-local; semantic reranking is intentionally disabled even if configured. Project knowledge, artifact externalization, durable cross-compaction pins, and automatic memory extraction remain later milestones.
