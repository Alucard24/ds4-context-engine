# Context Planner v1

The v1 planner is synchronous, deterministic, provider-independent, and does not call an LLM.

## Selection order

1. Estimate the mandatory system prompt and active tool definitions.
2. Derive target and hard message budgets from the active model profile.
3. Group messages by user-turn boundaries.
4. Merge groups linked by assistant tool calls and every matching tool result.
5. Select the current request turn and explicit pin groups as mandatory.
6. Walk older turns newest-first, stopping at the first group that would break the contiguous recent tail, target, or hard limit.
7. Fit active Pi compaction/branch summaries in the remaining summary and input budgets.
8. Restore original chronological order and validate the final selection.

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

## Deliberate M3 limits

Planner v1 does not call a model inside the `context` hook, retrieve historical events, index project knowledge, externalize artifacts, or create pins automatically. M4 compaction can provide an active Pi summary, which planner v1 fits as a summary candidate; hierarchical summary graphs remain scheduled for M5.
