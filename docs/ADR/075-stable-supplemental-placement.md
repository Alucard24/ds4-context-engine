# ADR-075 — Stable placement for per-turn supplements

Status: proposed (opt-in; the default `latest-user` preserves 0.5.2 behavior).

## Context

`planManagedContext` splices the supplements (pinned context, durable memory, project source,
retrieved evidence) immediately before the newest user message. That is the natural place for
them: the model reads them as part of the turn being answered.

It is also the worst place for a prompt cache. Every turn moves the splice to a new index, so
request N is never a prefix of request N + 1: the first divergence is the first supplement, and
everything after it — the whole conversation — is a cache miss. The same block, byte for byte,
is re-read on every turn.

Measured on a local engine (Strata 0.1.39b, IQ3_XXS, RTX 5070 Ti, `--max-context 262144`,
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
  ahead of the first user turn. Their text does not change from turn to turn, so request N stays
  a prefix of request N + 1 and only the new turn is processed.

The trade-off is the mirror image. With `stable-prefix` a *changed* block invalidates everything
after it (a full re-prefill), while `latest-user` re-reads only the block itself. Reserve
`stable-prefix` for supplements that change rarely (pins, durable memory, project source); keep
per-turn retrieved evidence at `latest-user`.

## Consequences

- Default behavior, manifests and the database are unchanged; only a config key is added.
- The planner keeps one insertion point for all supplements, so the choice is coarse: the whole
  supplement set moves together.

## Compatibility and validation

Coverage: two planner unit tests (the default keeps supplements immediately before the latest
user message; with `stable-prefix` the previous plan is a prefix of the next one while the
conversation grows, and is not with the default), the config catalog entry, config validation,
and the 0.2 compatibility fixture extended with the new default. Full suite (112 files, 875
tests) and `tsc --noEmit` clean.

## Open question for review

Per-kind placement — `pin`/`memory`/`project` in the stable prefix, `retrieval` at
`latest-user` — follows directly from the trade-off above and would be the natural next step.
This change keeps one placement for all supplements to stay reviewable.
