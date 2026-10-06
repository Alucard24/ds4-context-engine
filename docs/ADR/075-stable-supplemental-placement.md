# ADR-075 — Stable placement for per-turn supplements

Status: accepted (PR #2 squash-merged as `d2519f3`; per-kind placement added in a follow-up commit). All alternatives are opt-in; `latest-user` preserves the default 0.5.2 behavior.

## Context

`planManagedContext` splices the supplements (pinned context, durable memory, project source,
retrieved evidence) immediately before the newest user message. That is the natural place for
them: the model reads them as part of the turn being answered.

Moving that splice can break a reusable request prefix. With a non-empty unchanged block and
otherwise append-only history, the first divergence from the preceding request is at the old
insertion point: the unchanged earlier conversation can still be reused, but the block and
following tokens must be processed again. This does not imply that the whole conversation
always misses the cache.

The PR author reported the following measurements on a local engine (Strata 0.1.39b, IQ3_XXS, RTX 5070 Ti, `--max-context 262144`,
`--mmap-experts`) with a three-turn conversation and unchanged supplement text — a 760-character
pinned context plus a 7,590-character project source, the two blocks the Pi extension sent:

| placement | request | reused | re-read | prefill |
|---|---|---:|---:|---:|
| `latest-user` | 2 | 10,518 of 12,969 | 2,451 | 10.2–13.1 s |
| `latest-user` | 3 | 10,518 of 13,019 | 2,501 | 13.0 s |
| `stable-prefix` | 2 | 12,890 of 12,969 | 79 | 1.6 s |
| `stable-prefix` | 3 | 12,934 of 13,003 | 69 | 1.3 s |

The reusable prefix was exactly the system prompt plus the tool definitions in the first case
(10,518 tokens) and the entire previous request in the second.

## Decision

Add `context.supplementalPlacement`:

- `latest-user` (default) — the current behavior, unchanged.
- `stable-prefix` — splice the supplements after the leading `system`/`developer` messages,
  ahead of the first native user turn.
- `hybrid` — pin/memory/project at that prefix, retrieval immediately before the newest native
  user message. Relative order within each placement is preserved.

Stable placement removes one source of divergence; it is not a guarantee that request N is a
byte-for-byte prefix of N + 1. Selected blocks, retained native history, system/tools, request
options and provider serialization must also remain compatible. Compaction, a sliding tail,
budget-driven selection and query-dependent memory/project ranking can break reuse.

With `stable-prefix`, a changed early block invalidates the following suffix, not an unchanged
system/developer prefix. With `latest-user`, divergence begins later, but can also include
conversation tokens following the old insertion point. `hybrid` keeps volatile retrieval near
the current turn without moving unchanged pin/memory/project blocks. Memory/project content
can still change; all three modes remain explicit choices, and the default stays `latest-user`.

## Consequences

- Default behavior, manifests and the database are unchanged; only a config key is added.
- One append path records message positions, classifications, privacy reasons and source
  metadata together. Native pin indices map through actual planned positions across both
  insertion points; filtered source-less supplements do not shift them.
- Synthetic supplements are independent atomic groups. They cannot absorb a following native
  assistant/tool prefix and relabel it as pin/memory/project evidence. Native call/result
  relations still merge normally and incomplete selected exchanges still fail validation.
- With no native user message, no supplements are injected. Fallback still returns the native
  input and its classifications, with all supplements removed.

## Compatibility and validation

The original PR's two tests cover unchanged default placement and a growing, retained
conversation with unchanged prefix content. The original branch passed local `npm ci`, the
approved `npm test` and `npm run typecheck` checks, and the observed GitHub Node 22.19.0 / 24.x
checks. The author's 112-file / 875-test report refers to that original branch.

Follow-up regressions cover leading system/developer roles, two-point native pin remapping,
classification/privacy reasons, selected and excluded provenance, source-less filtering,
changing retrieval, no-user inputs, budget fallback and native leading tool exchanges.
Disabling isolated supplement boundaries reproduced the leading-exchange regressions before
the fix; after restoring them the behavioral suite passed. The config catalog/loader tests
round-trip all modes and reject invalid enums/types; the golden default remains `latest-user`.

The Strata timings above were not reproduced during this review. No live provider calls were
made; these deterministic checks do not establish real-engine cache savings or complete the
separate long-conversation BPE/auto-tuning objective.
