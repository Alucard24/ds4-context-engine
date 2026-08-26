# Context Quality Metrics

M14 adds an opt-in, metadata-only quality layer around the deterministic 0.1 planner. The context hook only queues the completed metadata-only manifest; metric materialization and storage run after `agent_settled` (or during shutdown flush), outside provider planning latency. Measurement never changes selection, ranking, privacy enforcement, provider payloads, or Pi JSONL.

## Configuration

Quality sampling is disabled by default:

```json
{
  "quality": {
    "enabled": true,
    "maxSamples": 1000
  }
}
```

`maxSamples` must be between 1 and 100,000. Retention is bounded in SQLite. Disabling the feature returns before sample scheduling. Enabling it adds only a bounded metadata-reference queue operation to the context path; the more expensive metric pass is deferred.

## Metrics

`context-quality-v1` records deterministic counts and ratios for:

- expected evidence recall;
- irrelevant selected-token ratio;
- duplicate evidence references;
- provenance coverage;
- current-request retention;
- atomic-group validity;
- overflow and planner-fallback rates;
- selected/dropped source-kind counts;
- category budget utilization;
- normalized selection/drop reason counts.

The primary score is versioned with the metric contract:

```text
35% evidence recall
20% relevant-token share
15% provenance coverage
15% current-request retention
10% atomic-group validity
 5% no-overflow/no-fallback reliability
```

A ratio with no applicable denominator is reported as `null` and contributes a neutral value once an aggregate contains labeled evidence. An aggregate with no labeled evidence reports a zero primary score rather than claiming success. Live requests do not have human expected-evidence labels, so their evidence recall remains explicitly unlabeled rather than being assigned a tautological success. Versioned replay fixtures supply expected source IDs and produce labeled recall.

Planning duration is stored and reported separately. It is excluded from deterministic aggregates and golden output because wall-clock time is not byte-stable.

## Privacy and storage

`context_quality_samples` is a disposable SQLite v11 projection. A stored sample contains only:

- schema, metric, corpus, planner and profile versions;
- aggregate source-kind, token, budget and decision counts;
- outcome labels;
- normalized timing values.

It does **not** contain prompts, messages, summaries, memory claims, artifact text, project paths, evidence text, provider payloads, provider response IDs, or raw evidence source IDs. Live source IDs are hashed only while constructing the volatile metric input; only resulting counts are persisted.

Malformed, incomplete, unknown-version, or structurally inconsistent rows are ignored during aggregation. Quality write/read failures are caught independently and cannot replace or block the 0.1 context plan.

Deleting SQLite discards samples without affecting canonical state. Replaying the same versioned local corpus reconstructs byte-identical non-timing aggregates.

## Replay corpus and comparisons

[`quality/corpus-v1.json`](../quality/corpus-v1.json) contains synthetic, sanitized metadata fixtures with task descriptors, expected evidence source IDs, atomic groups, token costs, and planner budgets. It contains no captured user or project text.

Run the 0.1 static-ranking baseline against the task-weighted 0.2 candidate interface:

```bash
npm run quality:compare
```

The final stdout line is stable JSON. Add `-- --timing` to report wall-clock duration separately on stderr. The task-weighted candidate remains evaluation-only. M18 adds a separate sanitized learned-ranking promotion fixture contract that enforces quality, exact-recall, privacy, atomicity, overflow, latency and determinism gates before active ordering is eligible; see [`LEARNED_RANKING.md`](LEARNED_RANKING.md).

## Diagnostics

```text
/context quality
```

The command reports sample counts, labeled coverage, aggregate scores, rates, category utilization, normalized reasons, and separate mean/p95 planning duration. It never renders source content.

## Verification

- `tests/unit/context-quality.test.ts` covers every metric, weighted aggregation, deterministic replay, and live-sample redaction.
- `tests/integration/context-quality-repository.test.ts` covers delete/rebuild equivalence, bounded retention, and corrupt-row isolation.
- `tests/golden/context-quality-comparison.test.ts` locks byte-stable non-timing comparison output.
- `tests/integration/extension.test.ts` covers opt-in runtime recording and `/context quality`.
- `tests/benchmarks/context-quality.bench.ts` measures disabled/enabled context-path scheduling separately from deferred 1,000-item materialization. On the development host, a 1,000-message planner measured `2.5680 ms` p99 with metrics disabled and `2.5929 ms` with enabled scheduling (about `0.97%` overhead); the deferred 1,000-item pass measured `11.6510 ms` p99. These are observational, not portable guarantees.
