# ADR-061 — Bounded compaction latency optimizations

Status: accepted and implemented; coordinated 0.3.5 publication explicitly authorized by the user on 2026-09-05. See the [release record](../releases/0.3.5.md) for validation and publication evidence.

## Context

Pi normally updates previous summary plus discarded messages in one request. DS4 previously always summarized new segments first and then generated an aggregate when a predecessor existed. Independent segments ran sequentially and summary inputs reused the ordinary context fill target. This can add avoidable calls; provider latency and summary quality still require controlled real-provider comparisons.

## Decision

- Add `compaction.directUpdate` (default true): estimate the complete sanitized update prompt, including previous summary, cumulative file evidence, custom instructions, split-turn instructions and output contract. If it fits, generate and validate one immutable `task-state` node with the predecessor as a child, canonical source IDs from both spans, and a hash bound to both the new source and predecessor identity/hash/content. With no predecessor, the existing one-segment path remains sufficient. Oversized updates use bounded hierarchical segmentation/aggregation, not truncation.
- Add `compaction.inputBudget` (`summary` default, or `context`). Summary mode uses the calibrated hard input limit instead of the ordinary active/fill target. Additionally bound input by model context minus safety margin and the actual summary output cap, converted to estimator units. Do not raise model/configured hard limits, remove calibration, reduce safety margins, or reuse ordinary context space reserved for output. Context mode preserves the old active target (also respecting actual summary output headroom).
- Add `compaction.maxConcurrentSegments` (default 2, range 1–2). Only independent segment requests overlap. Allocate identities and assemble graph/usage in source order, not completion order. On failure stop scheduling, abort siblings, await their settlement before fallback, and persist no partial graph. Cancellation remains cooperative; provider work already accepted may still be billed. Aggregation remains ordered and bounded.
- Expose process-local metadata-only timings for preparation, segment/direct generation, aggregation, graph preparation/persistence and total DS4 hook duration, plus chosen path, effective provider/model, direct prompt size and concurrency. Timings use a monotonic clock, include retries and local validation within generation, and are wall times (not sums of overlapping calls). They are not canonical evidence, are not persisted in JSONL, and do not measure a subsequent native Pi fallback.
- Preserve schema-v2 compaction metadata, the existing `task-state` kind, source/classification/validation contracts, Pi cut points, atomic tool exchanges, fresh routing IDs, retry policy, canonical JSONL and all-or-nothing graph preparation. `segmentSummaryId` refers to the update node itself on a direct update; do not invent a segment that was never generated.

## Compatibility and validation

Configuration is additive; absent fields use the new defaults. The old scheduling path can be compared using `directUpdate=false`, `inputBudget=context`, and `maxConcurrentSegments=1`. The compaction master switch still delegates to Pi when disabled. The original local implementation excluded versioning and publication; the user subsequently authorized the coordinated 0.3.5 release. No dependency upgrade, live database maintenance or Pi upgrade is part of this change.

Cover exact budget boundaries and calibration/output reserve, predecessor-only exact evidence and privacy, native predecessor warnings, source ordering/provenance/hash/rebuild, bounded concurrency and out-of-order completion, cancellation/failure/transport retry drainage, and no graph persistence before full success. Retain hierarchical regression coverage explicitly even where default routing now chooses a direct update. Automated call counts and synchronization tests establish scheduling behavior, not a promise of 40-second compactions or unchanged semantic quality on real provider outputs.
