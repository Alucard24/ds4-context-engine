# Advanced Model Awareness

**Validation status (OpenRouter, synthetic DS4/Pi sessions):** GPT-6-sol, GPT-6-luna and GPT-5.6-terra have each demonstrated multi-turn BPE calibration, a genuinely larger opt-in tail budget, provider usage above the native-window headroom threshold, and withdrawal of that expansion on the next turn in the same session. Historical retrieval and a live tool cycle were verified separately for all three. These bounded experiments do not establish universal tokenizer accuracy, provider-side compaction behavior, or production retrieval quality. `chars-v1` remains the default; BPE and `autoTune` remain opt-in. See the measured runs below.

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
ratio = actualInputTokens / raw selected-estimator estimate
```

Calibration is isolated by exact provider, model ID **and estimator version**; switching from `chars-v1` to BPE never reuses the old ratios. The latest configured window is validated and processed deterministically:

1. reject invalid or zero samples;
2. reject ratios outside the configured hard bounds;
3. compute the bounded median and median absolute deviation (MAD);
4. reject values outside the larger of 0.05, 10% of the median, or three scaled MADs;
5. require `minimumCalibrationSamples` accepted values;
6. use the accepted median as the next-call multiplier.

Until enough samples exist, the multiplier remains `1.0`. The default window is 24 samples, minimum is 3, and hard ratio bounds are 0.5–2.0. Outliers remain counted in metadata but do not influence the applied ratio.

Provider-token capacities are computed first from context window, output reserve, safety margin, and policy ratios. Global hard/soft/preferred input limits are converted into local-estimator units using **at least** a multiplier of 1: observed underestimation may reduce them, but apparent overestimation on short prompts never raises them above nominal model limits. Raw manifest estimates remain uncalibrated so future samples do not feed a corrected estimate back into itself. Adaptive tail/history/project budgets use the accepted multiplier but remain capped by the configured `context.*` maxima even after conversion.

### Optional BPE estimator and measured budget tuning

The default remains `chars-v1`. To opt a profile into local OpenAI `o200k_base` BPE text counting (without fetching vocabulary over the network):

```json
{
  "modelAwareness": {
    "overrides": { "openai/gpt-4o": { "tokenEstimator": "o200k-base-v1" } },
    "autoTune": true
  }
}
```

Use BPE only for a model known to share that encoding. The estimator counts text with BPE in the Pi observer, managed planner and fixed prompt/tool estimates; message wrappers, images, reasoning, provider-specific serialization, indexed retrieval hints, and persisted summaries remain estimates. It does **not** make token counts exact or enable provider-side continuation. If the provider's actual input tokens drift persistently from estimates (median ≥1.25 or ≤0.80 after the calibration minimum, or repeated hard-bound outliers), `/context model` and status surface a metadata-only warning; no prompt content is logged.

`autoTune` is opt-in and starts neutral. After at least eight accepted calibration samples, it expands *automatic* recent-tail, history and project ceilings by at most 12.5% of their nominal values, only if **every valid provider-usage sample** in the calibration window — including ratio outliers excluded from ratio calibration — remains at or below 60% of the current preferred/hard input target. It never raises a ceiling beyond the configured context cap, never overrides an explicit model-specific category limit, and never changes the provider's window, output reserve, safety margin or hard/soft input limits. Without enough evidence or headroom it stays neutral. Any calibration multiplier is applied after this small expansion; tune decisions and warnings are recorded as metadata in the manifest.

## Validation goal for BPE and auto-tuning

**User-requested outcome:** verify long conversations, tools, retrieval, calibration across turns, and auto-tuning safety on the context actually built by DS4/Pi. Single-turn synthetic token probes are preliminary evidence only; they do **not** satisfy this goal or justify declaring the feature complete.

The validation must cover, and report results separately for:

1. Long multi-turn sessions, including large context windows, compaction boundaries, and preservation of the current request.
2. Tool calls and results (including large results): atomic selection, offload, and the estimated versus observed token count.
3. Retrieved history and project context: relevance, budget selection, and whether relevant older material survives planning.
4. Consecutive turns on the **same** provider/model and estimator profile: provider usage correlation, accepted/rejected calibration samples, changes to the applied ratio, and isolation when models or estimators change.
5. Opt-in auto-tuning: evidence thresholds, configured and hard limits, outliers, insufficient headroom, and no regression in retrieval or context integrity when limits expand.

Use local, deterministic integration tests where possible. If real provider calls are needed, require a **new explicit call and input-size limit** before sending anything; the earlier single-turn budgets are exhausted. Report any scenario not verified as *not verified*, rather than treating the synthetic pilot as an end-to-end result. Do not change the default estimator or enable auto-tuning by default on the strength of that pilot.

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

## Local validation progress and outstanding provider evidence

`tests/integration/model-aware-real-context.test.ts` exercises the Pi `context` and `message_end` hooks over canonical multi-turn JSONL without any network transport. A long branch with a tool call/result verifies atomic selection and retrieval of an older decision under a BPE-managed budget. Successive turns verify that eight correlated usage records are required before opt-in expansion, that estimator/model switches isolate calibration, and that a new near-limit usage record withdraws the expansion even when its ratio is excluded from calibration. `tests/unit/model-aware-estimator.test.ts` also checks explicit overrides, configured caps, and the high-usage outlier regression.

**Local integration checks inject usage; they are not independent provider measurements.** A separately authorized, bounded live probe (`scripts/verify-model-aware-real-session.mjs`) used a temporary Pi JSONL session, DS4's actual hooks, synthetic content, `openrouter/openai/gpt-4o-mini`, and Pi-normalized provider usage. Eight successive short calls accumulated calibration samples; on the ninth call the manifest showed eight accepted samples, applied ratio 0.677157, and opt-in `autoTune: expanded`. That ninth call did **not** contain the intended appended long branch: Pi had already constructed its runner, and its manifest estimated only 1,940 input tokens. It is not evidence for long-context tuning.

A second, fresh Pi session with the long branch seeded *before* runner construction produced 83 original messages; DS4 selected 21 groups, excluded 21, retrieved the older `cobalt-713` decision, and included both the synthetic tool-call assistant entry and tool result. For that request, the BPE-based manifest estimate was **23,492** input tokens and provider usage was **23,196**. This is **one** live, untuned long-session/tool/retrieval measurement; it does not prove stable drift across lengths or models. The earlier [single-turn pilots](PROVIDER_TOKEN_DRIFT_BENCHMARK.md) remain separate. The two runs together attempted 10 calls and conservatively reserved 217,678 of the authorized 250,000 estimated-input-token limit (per-call ceiling 64,000; 16-call ceiling). All temporary session data was deleted.

A subsequent, separately authorized probe (`scripts/verify-model-aware-calibrated-session.mjs`) seeded a 28-turn synthetic history and tool call/result **before starting the same Pi session**. Eight real provider calls calibrated BPE on that long context; the ninth measured **23,926 estimated / 23,486 actual input tokens**, eight accepted samples, `autoTune: expanded`, and retrieval of the old decision with the historical tool call and result included. This verifies expansion on a real long context after calibration in one session, not just across separate sessions. Across this probe **11 calls** reserved **588,052/600,000** estimated input tokens (80,000 per-call limit); no further provider requests were made under that authorization.

The attempted higher-occupancy request used **37,552 estimated / 37,464 actual tokens**, below the 60%-of-target withdrawal threshold (**53,760** for this model/configuration). The following turn still reported `expanded`: **withdrawal is not verified live**. That larger turn also excluded the historical tool/retrieval groups, an observed quality limit under that selected context, not proof of an auto-tuning regression. The local Pi compaction-boundary test covers summary preservation under BPE. A separately bounded **one-request** live compaction probe (`scripts/verify-model-aware-compaction-session.mjs`) preseeded the canonical Pi compaction entry before starting Pi; the DS4 managed manifest included its summary and measured **250 estimated / 244 actual** provider input tokens. This used one further call under the third authorization, bringing that budget to **10 calls / 181,069 estimated input tokens reserved**. It checks the provider-bound context *after* a synthetic compaction entry, not live summary generation. At that point, live tool execution and high-usage withdrawal remained unverified; both were tested in the later authorized round below. Model variety and production retrieval quality still remain outside these bounded probes. A third bounded probe (`scripts/verify-model-aware-safety-session.mjs`) reached **60,509 actual input tokens** (>53,760), but only **seven** of eight preceding short-call samples had been accepted; the manifest at the high-usage request showed seven accepted samples and `insufficient-samples`, not an expanded policy. Thus it **does not** test withdrawal. The safety probe attempted **9 calls**, reserving **169,006** estimated input tokens, and stopped without a follow-up call. It now gates the expensive request on eight *accepted* samples and seeds a stable synthetic prefix, but has not been rerun. Its temporary session was deleted; the remaining third-round budget after the separate compaction request cannot fit a new calibration/high-usage/follow-up sequence under the preflight limits. No live tool execution was attempted in that round because the automatic multi-request cycle was not yet safely capped per request. Those results alone did not verify withdrawal or tool execution.

A final, separately authorized round verified the outstanding **synthetic** provider-path scenarios on the same OpenRouter/GPT-4o-mini profile. After a stable synthetic prefix, eight usage samples were accepted; the ninth short turn showed `expanded`. The next request reported **60,708 estimated / 60,640 actual** input tokens, above the **53,760** headroom threshold; the following turn reported **60,795 estimated / 60,722 actual** and `no-headroom` (recent-tail limit decreased from **27,699** to **24,564**). `scripts/verify-model-aware-safety-session.mjs` used **11/15** calls and **292,818/350,000** estimated-input tokens reserved (maximum 80,000 per call). This demonstrates withdrawal on measured provider usage, not merely a synthetic injected sample.

With the remaining budget, `scripts/verify-model-aware-live-tool.mjs` gated **each** Pi provider request at `ModelRuntime.streamSimple`, disabled cache warming/retry/compaction, and executed a single synthetic tool. The first request included its tool schema and used **105** provider input tokens; the second included the actual tool result and used **139**. Exactly **two** requests and one tool execution occurred. The final fourth-round total was **13/15 calls, 317,119/350,000** estimated-input tokens reserved. Only aggregate counters and booleans were reported; temporary synthetic sessions were removed.

These bounded live measurements, together with the canonical Pi JSONL integration tests, cover long context, historical and executed tools, retrieval, between-turn calibration, compaction-boundary context, and auto-tuning withdrawal **for this synthetic OpenRouter/GPT-4o-mini profile**. They do not establish universal accuracy for other providers/models, real private sessions, arbitrary compaction generation, or production retrieval quality.

### Native-window checks for Sol, Luna and Terra — separately authorized

The Pi catalog exposed a **1,050,000-token window** for each OpenRouter model `openai/gpt-6-sol`, `openai/gpt-6-luna`, and `openai/gpt-5.6-terra`. One additional authorization limited their *combined* probes to **42 provider attempts, 600,000 estimated input tokens / 2,500,000 controlled characters per request, and 4,800,000 estimated tokens / 15,000,000 controlled characters total**. `scripts/verify-model-aware-triad.mjs` and `scripts/verify-model-aware-triad-followup.mjs` gated **every** Pi request at `ModelRuntime.streamSimple`, including tool continuations; no real sessions, credentials, prompt bodies, responses or raw upstream errors were logged. Temporary canonical Pi JSONL sessions were deleted.

The first probe consumed **30 calls / 1,433,445 tokens / 3,679,430 characters reserved**. For *each* model, nine calibration calls in the same seeded long session led to at least eight accepted usage samples. The tenth call measured **36,027 BPE-estimated / 35,503 Pi-normalized actual input tokens**, `autoTune: expanded`, with the historical tool call and result included. **This did not verify retrieval**: the decision was still in the 64k recent tail and therefore had not been fetched by retrieval; the probe correctly stopped before tool execution and the high-occupancy turn. At this native profile, the reported `expanded` status did **not** demonstrate a larger recent-tail limit: its configured 64k cap was already saturated.

The second probe seeded **70 turns before Pi session construction**, putting the old decision outside the default recent tail. It consumed nine more calls (one retrieval request and an actual **two-request, one-execution** synthetic tool cycle per model). The decision was both retrieved and included, the historical tool call/result stayed included, and the new tool schema appeared in the first provider request with its actual result in the second. Per-model provider usage for the retrieval request was **63,050 / 63,049 / 63,053** tokens (Sol/Luna/Terra), against BPE estimates **63,699 / 63,698 / 63,702**. All three tool cycles completed. These are measurements of the DS4/Pi managed context, not three single-turn tokenizer prompts.

The three remaining authorized requests measured large BPE-managed input, **one per model**. The selected current user turn was included, and Pi reported **381,501 / 381,502 / 381,502** input tokens against manifest estimates **381,593 / 381,594 / 381,594**. The historical call/result were present, but the old decision was **not** selected; the oversized prompt did not ask about that decision, so this is **not** a valid retrieval-quality test. The request generator targeted 462k from the *raw* canonical history, but DS4 excluded older history and the selected provider input remained ~381.5k. Thus all three requests were **below** the native-window auto-tuning withdrawal threshold of **441,000** (60% of the 735k preferred target), and far below the full 1.05M window. They were fresh sessions without eight accepted calibration samples; **none tests `expanded → high provider usage → no-headroom` on these models**. Do not report the triad's auto-tuning safety or category expansion as live-verified at its native window; the deterministic local matrix in `tests/unit/model-aware-estimator.test.ts` covers only injected samples and caps. The entire authorization was used: **42/42 calls**, **3,296,138/4,800,000** estimated input tokens and **9,357,266/15,000,000** controlled characters reserved. No more provider calls are authorized under it. The historical probes now reject `--live` under this exhausted authorization. **After** those measurements, their local high-input sizing was corrected to require at least 470k BPE tokens in the selected current user text (rather than in raw canonical history), with a second gate immediately before provider transport; unit tests cover the discarded-history regression and per-call preflight. This correction was **not** run against a provider and cannot retroactively validate withdrawal.

Across these specific synthetic shapes, BPE manifests slightly overestimated provider usage, but no universal correction follows. At this earlier point native-window compaction generation, production retrieval quality and live high-usage auto-tune withdrawal for Sol/Luna/Terra were unverified; the later withdrawal runs below close **only the last of those gaps**. The later probes check actual category growth (not merely `expanded` status), a selected current turn above 470k BPE tokens, usage above 441k, and withdrawal in the same Pi session. Their temporary opt-in category ceilings are 80k/40k/40k because the default native tail ceiling is already equal to its configured maximum of 64k and cannot grow; the probes do not establish expansion under unchanged category defaults. BPE and auto-tuning remain opt-in; no default or provider-storage policy was changed.

### Native-window withdrawal round (later, opt-in categories)

With a separate explicit cap of 39 calls, 3,800,000 reserved input tokens and 11,000,000 controlled characters, the same-session Pi/DS4 probe used temporary category ceilings 80k/40k/40k to expose a **real** tail expansion. It ran 34 provider requests (3,375,536 estimated input tokens reserved; 9,845,274 controlled characters). For **GPT-6-sol and GPT-6-luna**, each session accepted at least eight calibration samples; the expanded tail exceeded the same-ratio no-tune baseline (about 72,922 versus 64,819 estimator tokens). A later request used **475,703 provider input tokens** (BPE estimate 475,790), above the 441,000 provider-token headroom threshold. On the next request, `autoTune` was `no-headroom` and the tail equalled its no-tune baseline (64,805); actual provider input was 471,846/471,844. The selected current turn, historical decision, call and result were present before the large request. The large input and follow-up did **not** retain the unrelated old decision/tool group; these measurements do not establish production retrieval quality.

For **GPT-5.6-terra**, calibration and real expansion passed in that first round, but its high-input request was blocked **before transport** by the cumulative budget/character caps: the probe had incorrectly budgeted the follow-up as short even though Pi resends the large preceding turn. The temporary session was then disposed. A **separately authorized Terra-only run** used a fresh synthetic Pi/DS4 session and counted *both* large requests. It made 12 provider calls (1,449,079 estimated tokens and 4,310,843 characters reserved, under separate 13-call / 1,900,000-token / 6,000,000-character maxima). After at least eight accepted calibration samples, Terra's tail grew to 72,922 estimator tokens versus a same-ratio untuned baseline of 64,819. The large request used **475,707 provider input tokens** (BPE estimate 475,794), above the 441,000 threshold. On the next turn, provider input was **471,852** (estimate 471,929), `autoTune` was `no-headroom`, and the tail returned to **64,805**, exactly its untuned baseline at that turn's ratio. The historical decision/call/result and current turn were included before the large request; unrelated older groups were excluded during the large request. **This verifies the defined live high-usage expansion/withdrawal scenario for all three models, not a general retrieval or compaction guarantee.** Both probes are now locked against replay; defaults remain unchanged.

## Performance and tests

`tests/benchmarks/model-awareness.bench.ts` measures a bounded 200-sample calibration analysis and repeated 32k/128k/200k profile resolution. Unit and golden tests cover deterministic tiers, override precedence, robust outlier rejection, cache accounting, and calibrated budgets. Integration tests switch local/remote providers and 32k/128k/200k models while checking profile isolation, privacy re-enforcement, canonical JSONL preservation, SQLite cache metrics, and profile reuse. For a separately authorized, bounded real-provider measurement of both estimators against Pi SDK usage, see [PROVIDER_TOKEN_DRIFT_BENCHMARK.md](PROVIDER_TOKEN_DRIFT_BENCHMARK.md); it does not substitute for DS4 manifest measurements in a live session.
