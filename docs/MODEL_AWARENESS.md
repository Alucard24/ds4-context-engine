# Advanced Model Awareness

M11 resolves an independent deterministic planning profile for every exact `provider/model`. Pi's model descriptor remains the default source for context window, output ceiling, reasoning, and image support; explicit DS4 overrides can repair provider metadata or tune category limits without changing canonical session state.

## Profile resolution

Overrides merge from least to most specific:

```text
*
provider/*
provider/model-id
```

Supported fields are:

```text
contextWindow
maxOutputTokens
safetyMarginTokens
recentTailTokens
maxRetrievedHistoryTokens
maxProjectTokens
```

Unknown fields, malformed keys, non-integer token limits, impossible output/window combinations, and unsafe calibration settings reject that configuration source. Global and trusted-project override maps merge by key. Project configuration remains subject to Pi's project trust decision.

Example:

```json
{
  "modelAwareness": {
    "enabled": true,
    "calibrationWindow": 24,
    "minimumCalibrationSamples": 3,
    "calibrationRatioLowerBound": 0.5,
    "calibrationRatioUpperBound": 2.0,
    "overrides": {
      "*": { "safetyMarginTokens": 2048 },
      "ollama/*": { "recentTailTokens": 16000 },
      "openrouter/vendor/model": {
        "contextWindow": 200000,
        "maxRetrievedHistoryTokens": 12000
      }
    }
  }
}
```

Setting `modelAwareness.enabled` to `false` disables calibration, profile overrides, and adaptive history/project retrieval. The pre-M11 model-adaptive recent-tail safety ceiling remains active.

## Adaptive category budgets

With no explicit override, category ceilings derive from the resolved context window and remain bounded by the corresponding `context.*` maximum:

| Context window | Recent tail | Historical retrieval | Project retrieval |
|---|---:|---:|---:|
| up to 40k | 12k | 4k | 4k |
| up to 128k | 24k | 8k | 12k |
| up to 256k | 32k | 16k | 20k |
| larger | 64k | 32k | 32k |

The default `context.recentTailTokens` is 64k so these automatic tiers are effective by default. Category limits are independent: a small model does not spend its entire input on retrieval, while a large model can retain more verbatim work and source evidence.

## Model-specific token calibration

Each successful assistant response is correlated with one pending Context Manifest. Provider input is defined exactly as Pi defines request input usage:

```text
actualInputTokens = input + cacheRead + cacheWrite
ratio = actualInputTokens / raw chars-v1 estimate
```

Calibration is isolated by exact provider and model ID. The latest configured window is validated and processed deterministically:

1. reject invalid or zero samples;
2. reject ratios outside the configured hard bounds;
3. compute the bounded median and median absolute deviation (MAD);
4. reject values outside the larger of 0.05, 10% of the median, or three scaled MADs;
5. require `minimumCalibrationSamples` accepted values;
6. use the accepted median as the next-call multiplier.

Until enough samples exist, the multiplier remains `1.0`. The default window is 24 samples, minimum is 3, and hard ratio bounds are 0.5–2.0. Outliers remain counted in metadata but do not influence the applied ratio.

Provider-token capacities are computed first from context window, output reserve, safety margin, and policy ratios. Planner limits are then converted into local-estimator units by dividing by the accepted multiplier. Raw manifest estimates remain uncalibrated so future samples do not feed a corrected estimate back into itself. Adaptive tail/history/project budgets use the same conversion.

## Provider cache metrics

Schema v10 stores separate per-call values for:

```text
input_tokens
cache_read_tokens
cache_write_tokens
```

The manifest records the finalized call's three values, total provider input, and read/write shares. The active model profile reports aggregate totals and shares over its calibration window. Error, aborted, missing, zero-usage, duplicate-response, or uncorrelated messages create no sample.

Cache metrics are observational. Stable deterministic ordering and unchanged system/tool prefixes make cache reuse possible, but the provider decides whether a prefix is reusable. M12's separately configured native continuation may attach a real provider response handle only after exact hashed-prefix validation; it never fabricates a handle or treats cache/continuation state as canonical. See [`NATIVE_CONTINUATION.md`](NATIVE_CONTINUATION.md).

## Model and provider switches

`model_select` records source (`set`, `cycle`, or `restore`), previous profile, whether the exact profile was seen before, and cache disposition. A change to a different provider/model is treated as a cold cache boundary and invalidates volatile native-continuation state. Switching back reuses that exact model's calibration history and adaptive policy, not another model's ratio.

Every subsequent `context` call rebuilds provider-facing context from canonical Pi JSONL and current derived indexes. It reruns privacy classification for the new destination, so a local-to-remote switch can remove `local-only` content while a later switch back to an allowed local model can recover it from canonical state. No switch mutates or truncates the session, memory/pin mutations, project source, artifact bytes, or summary provenance.

## Manifest and diagnostics

The metadata-only Context Manifest includes:

- profile key, effective window/output/safety margin, and matched override keys;
- calibration window, bounds, accepted/rejected/outlier counts, median, and applied ratio;
- adaptive nominal and estimator-adjusted category limits;
- cache totals/shares over the model window;
- switch source, prior profile, reuse flag, and cache disposition;
- finalized per-call uncached input, cache-read, cache-write, and total input usage.

It never stores prompt text, provider payloads, cache keys, headers, classified spans, or credentials.

Use:

```text
/context model
/context tokens
/context manifest
/context status
```

## Performance and tests

`tests/benchmarks/model-awareness.bench.ts` measures a bounded 200-sample calibration analysis and repeated 32k/128k/200k profile resolution. Unit and golden tests cover deterministic tiers, override precedence, robust outlier rejection, cache accounting, and calibrated budgets. Integration tests switch local/remote providers and 32k/128k/200k models while checking profile isolation, privacy re-enforcement, canonical JSONL preservation, SQLite cache metrics, and profile reuse.
