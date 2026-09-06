# ADR-062 — Cache-aware context planning

Status: accepted and implemented in the coordinated 0.3.7 release (opt-in, default off; see the [release record](../releases/0.3.7.md)).

## Context

DS4 reduces provider input by selecting a bounded managed context. This is
economically sound when every input token costs the same or when the provider
offers no prompt cache. Providers with a large context window and a large
cache-miss/cache-hit price ratio (for example DeepSeek V4 Flash, roughly 31x
off-peak) invert the trade-off: a small but frequently re-planned prompt can
cost more than a larger stable one, because every re-plan invalidates the
provider prefix cache.

The 0.3.6 planner applies an automatic 64k recent-tail ceiling to all models
above 256k until the conversational tail exceeds the cap. When the cap is
exceeded, the oldest turn leaves and the shared prefix with the previous
request collapses: everything after the first divergence becomes a cache miss.
Whether this is more expensive than a wider tail depends on the workload
(requests per turn, turns per epoch, share of cached reads observed).

The runtime already records cache read/write shares per exact `provider/model`
(volatile calibration plus persisted manifests) and Pi exposes per-million
cost rates on the active model. The portable core never hardcodes prices.

## Decision

- Add an optional economic cost profile to the portable `ModelDescriptor`
  (`input`, `output`, `cacheRead`, `cacheWrite` per million), populated from
  Pi model metadata in `snapshotModel`. Absent fields degrade cache-aware
  planning to the previous behavior.
- Add `context.cacheAware` (default `off`), a policy object with:
  - `mode`: `off` preserves the previous planner exactly; `auto` may extend
    the recent tail when pricing and observed cache shares justify it;
  - `minimumCacheSampleCount`, `minimumCacheReadShare`,
    `minimumMissHitRatio`: hard gates before any extension is eligible;
  - `minimumImprovementRatio`: relative cost improvement required before an
    alternative plan is adopted (hysteresis);
  - `maxTailBudgetShare`: the extended tail may never exceed this fraction of
    the active input budget;
  - `expectedRequestsPerTurn`, `expectedTurnsPerEpoch`, `stickinessEpochs`:
    deterministic cost model horizon plus hysteresis before dropping an
    adopted extended tail.
- In `auto` the runtime computes `context.cacheAware` decision and compares
  two plan candidates (nominal tail vs extended tail) with a deterministic
  epoch cost model:
  - stable plans (original conversation fits their tail cap) pay one cold
    transition per epoch and warm requests afterwards;
  - sliding plans (conversation exceeds their cap) pay a cold request every
    turn of the epoch.
  The extended plan is adopted only when it is cheaper over the whole epoch,
  after the minimum improvement margin.
- The planner accepts an optional `cacheAwareTailTokens` override that bypasses
  the automatic context-window ceiling; it remains bounded by the active/hard
  input budgets and atomic groups, so no hard limit, privacy, pin, current
  request or atomicity guarantee is weakened.
- Manifest `planning.cacheAware` (optional, numbers only, never content)
  records the decision, tail, miss/hit ratio, observed cache share, sample
  count, estimated reusable prefix tokens, estimated request cost and the
  winning candidate. `/context tokens` and `/context explain` surface the same
  metadata. `context.excluded_oversized_turn` and previous guarantees are
  unchanged.
- Add a deterministic synthetic prefix-cache simulator covering the report
  scenarios (append-only under the cap, sliding past 64k, one response per
  prompt, five tool cycles, wide vs sliding tails, model switch, pricing
  comparison). No provider, no credentials, no CI network access.

## Rejected alternatives

- Hardcoding provider prices: rejected, the core stays provider-independent.
- Raising the default tail ceiling globally: rejected, it changes behavior
  for all models (including ones without cache discounts).
- Always extending the tail for eligible models: rejected, the epoch model
  shows the nominal plan can still be cheaper on workloads where the tail
  slides infrequently; the improvement margin keeps the switch conservative.

## Compatibility and validation

Configuration is additive; `context.cacheAware.mode` defaults to `off`, so
`0.3.6` behavior (and manifest absence of the cacheAware block) is preserved.
Automatic behavior is opt-in and requires observed samples plus positive
pricing. The epoch cost is an estimate used only for the comparison; the
actual billing remains whatever the provider reports. The workaround override
(`modelAwareness.overrides` with a large `recentTailTokens`, zeroed retrieval
and disabled compaction) remains available and is unaffected; it is more
aggressive than `mode: "auto"` because it also removes retrieval/project
supplements and compaction, which `auto` deliberately preserves for quality.

Coverage: cache-policy unit tests (prefix, costs, decision gates), config
validation, planner override tests, the synthetic prefix-cache simulator, and
runtime integration tests for off/auto/no-discount/under-budget paths. A
real-provider DeepSeek A/B benchmark remains out of scope and voluntary
(protocol: [CACHE_AWARE_BENCHMARK.md](../CACHE_AWARE_BENCHMARK.md)).
