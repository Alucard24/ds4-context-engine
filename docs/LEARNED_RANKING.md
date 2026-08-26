# Learned Ranking

M18 adds an optional metadata-only linear ranker while preserving the deterministic static ranker as the universal fallback.

## Modes

```json
{
  "ranking": {
    "mode": "shadow",
    "modelPath": "ds4-context/ranking-model.json",
    "minimumTrainingSamples": 20,
    "maxTrainingSamples": 10000,
    "maxLatencyMs": 10
  }
}
```

- `off` does not load or evaluate a learned model.
- `shadow` evaluates a valid model, records only aggregate rank disagreement, and keeps static selection unchanged.
- `active` changes supplemental-candidate ordering only when the checksummed artifact contains a successful promotion report. Missing, incompatible, corrupt, unpromoted, or regressing artifacts fall back to static ranking.

`off` is the upgrade default. Privacy filtering, mandatory pins, current-request retention, category budgets, atomic groups, and hard input limits remain authoritative in every mode.

## Bounded feature schema

`ranking-features-v1` contains only a source-kind enum and ten finite normalized numbers:

- static score;
- exact-match score;
- FTS score;
- vector score;
- recency;
- active-branch relation;
- symbol relation;
- classification eligibility;
- token cost;
- prior selection outcome.

All numbers are bounded to `[0, 1]`. Candidate text, excerpts, prompts, file paths, symbols, claims, provider payloads, and credentials are not model features. Stable candidate and repository identities are SHA-256 hashes in canonical labels.

## Canonical labels and local training

Explicit feedback is appended through Pi as a classified `ds4-context-ranking-feedback-v1` custom entry:

```text
/context ranking feedback useful CANDIDATE_ID --classification internal
/context ranking feedback irrelevant CANDIDATE_ID --classification local-only
```

Only candidates from the latest managed context are accepted. A feedback entry contains schema/version, feedback ID, timestamp, classification, label source, label, two hashes, and the bounded feature vector. It contains no candidate text. Sanitized replay labels use the same schema with `labelSource: "replay"`.

Train a local shadow artifact from the active canonical Pi branch:

```text
/context ranking train
```

Training is deterministic for the same unique labels and timestamp, requires both useful and irrelevant examples, and is bounded by `minimumTrainingSamples` and `maxTrainingSamples`. The artifact is written with mode `0600` where supported. Training never calls a provider and does not make the resulting artifact active.

## Artifact integrity and deterministic inference

`ranking-model.json` uses schema version `1`, feature version `ranking-features-v1`, algorithm `bounded-linear-centroid-v1`, bounded weights, training counts, a deterministic model ID, and a SHA-256 checksum over its stable JSON payload. Inference uses rounded finite arithmetic and resolves equal scores by static score and then candidate ID.

The model artifact is local derived state. Deleting it preserves Pi JSONL labels and restores static ranking. A newly trained artifact can be reconstructed from canonical labels.

## Promotion gate

`evaluateRankingPromotion()` in `ds4-context-core/ranking/learned-ranker` evaluates sanitized held-out fixtures. `withRankingPromotion()` seals the resulting report into a new checksummed artifact. Promotion succeeds only when all of these conditions hold:

- primary quality score improves;
- exact-identifier recall does not regress;
- privacy violations do not increase;
- atomicity failures do not increase;
- overflow does not increase;
- measured p95 latency stays within budget;
- repeated inference yields identical ordering;
- the configured minimum number of held-out repositories is represented.

An artifact without an eligible report can run in shadow mode but cannot alter context in active mode.

## Diagnostics

```text
/context ranking
/context health
/context manifest
```

Ranking diagnostics include mode/status, versions, model identity, promotion state, label counts, malformed/duplicate counts, candidate count, top-rank disagreement, pairwise disagreements, mean rank shift, inference duration, and fallback reason. Shadow diagnostics and Context Manifests contain aggregate comparison only—never candidate IDs, labels, features, or text.
