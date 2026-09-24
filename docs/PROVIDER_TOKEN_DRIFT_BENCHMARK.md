# Live provider token-drift probe (opt-in)

This developer-only, **source-checkout-only** probe (the script is not included in the published npm package) compares DS4's raw `chars-v1` and `o200k-base-v1` estimates with **Pi SDK provider usage** for synthetic, single-turn text. It does not start a Pi session, read session JSONL or SQLite, record responses, or change DS4 configuration. It never prints API keys, requests, response bodies or raw upstream error messages. It requires local Pi provider authentication and network access. The probe runs only with `--live`; without that flag it prints the bounded plan.

```bash
npm run build:core
node scripts/compare-provider-token-drift.mjs \
  --model openrouter/openai/gpt-4o-mini \
  --model deepseek/deepseek-v4-flash \
  --model openai-codex/gpt-5.4-mini
# After inspecting the dry-run budget, add --live to make real calls.
```

The script accepts repeated `--model provider/model-id` and optional `--sizes 512,4096,48000`. **Per invocation**, it refuses more than 12 model calls or 200,000 total input characters (system prompt included), disables SDK request retries, and imposes a 45-second deadline per call. Multiple invocations have separate caps: track their cumulative spend yourself. Output is one metadata-only JSON report on stdout. The SDK's catalog-derived USD cost is an estimate, not a bill; a provider can still charge for failures or retries outside this script's control. If you pipe output to a file, keep it outside the repo unless you intentionally want to publish the aggregate metadata.

For each successful call, `actualInputTokens = usage.input + usage.cacheRead + usage.cacheWrite`; the cached fractions are **not** extra tokens on top of that sum. `residualTokens = actual - rawEstimate` (positive means underestimation), and `underestimationPctOfActual = max(0, residual) / actual × 100`. Adjacent slopes use differences across prompt sizes for a single exact provider/model, removing most fixed framing. BPE counts only text; both estimators use the same DS4 message/system overhead. No raw provider payload is available from this probe, so the result does **not** prove the accuracy of DS4's full observer in a live Pi extension chain (tools, images, privacy, cache/continuation, and later extensions differ). Compare `/context model`, `/context tokens`, and manifest `actualInputTokens` versus `estimatedInputTokens` in an ordinary consented Pi session for that second step. Never copy session text or auth files into the report.

## First observed run — 24 September 2026, 10:09–10:13 UTC

User-approved cumulative envelope: 12 call attempts and 200,000 input characters. Three invocations totalled **12 attempts and 195,176 planned input characters**: 9 calls/158,382 characters, a single Codex diagnostic call/574 characters, then 2 calls/36,220 characters. Success: 8; failure/missing usage: 4. Synthetic multilingual/code-like repeated text; no private session data. Sizes below are user-message characters; system prompt is included in estimates and the total envelope. These are observations, **not** a representative multi-session cost or quality benchmark.

| Provider / requested model | User chars | Real input¹ | `chars-v1` | BPE `o200k-base-v1` | BPE residual (real − estimate) |
|---|---:|---:|---:|---:|---:|
| OpenRouter / `openai/gpt-4o-mini` | 512 | 190 | 161 | 196 | −6 |
| OpenRouter / `openai/gpt-4o-mini` | 4,096 | 1,436 | 1,057 | 1,442 | −6 |
| OpenRouter / `openai/gpt-4o-mini` | 48,000 | 16,668 | 12,033 | 16,674 | −6 |
| DeepSeek / `deepseek-v4-flash`² | 512 | 179 | 161 | 196 | −17 |
| DeepSeek / `deepseek-v4-flash`² | 4,096 | 1,388 | 1,057 | 1,442 | −54 |
| DeepSeek / `deepseek-v4-flash`² | 48,000 | 16,172 | 12,033 | 16,674 | −502 |
| OpenRouter / `deepseek/deepseek-v4-flash` | 4,096 | 1,387 | 1,057 | 1,442 | −55 |
| OpenRouter / `deepseek/deepseek-v4-flash` | 32,000 | 10,785 | 8,033 | 11,124 | −339 |

¹ Pi's normalized provider usage: input + cache read + cache write. Some long requests reported cached reads (up to 1,408 tokens); they were included exactly once. Successful responses produced 1–3 output tokens. ² DeepSeek reported response model `deepseek-flash`, an alias of the requested ID; no equivalence to OpenRouter routing is assumed.

- OpenRouter GPT-4o-mini: raw `chars-v1` median actual/estimate **1.358562**; raw BPE median **0.995839**. At 48k chars, chars/4 underestimated by 4,635 tokens (27.81% of actual), while BPE overestimated by 6 tokens. Adjacent BPE slopes were 1.000 and 1.000.
- Direct DeepSeek: raw chars median **1.313150**; BPE median **0.962552**. At 48k chars, chars/4 underestimated by 4,139 tokens (25.59% of actual), while BPE overestimated by 502 tokens. Adjacent BPE slopes were 0.970305 and 0.970588. Close agreement here does **not** establish that DeepSeek uses OpenAI's tokenizer or justify turning BPE on for that model by default.
- OpenRouter DeepSeek: two valid samples; raw chars median **1.327396**, BPE median **0.965692**. At 32k chars, chars/4 underestimated by 2,752 tokens; BPE overestimated by 339. Two samples are insufficient to validate a persistent drift warning or tuning.
- `openai-codex/gpt-5.4-mini`: three initial attempts produced no usable usage; one later 512-character diagnostic returned `request-failed` with sanitized category `other` and no HTTP status. The local Pi auth resolver did return a credential, but the reason for the probe failure remains **unverified**. Do not infer its tokenizer drift, account availability in the interactive TUI, or provider-side token consumption from these calls. Direct `openai/gpt-4o-mini` API auth was not configured in the Pi runtime used by this probe; OpenRouter is a distinct route.

**Interpretation:** Three sizes with one call each do not establish statistical reliability or cover large context windows, tools, images, prefixes reused across turns, or output-heavy workflows. `chars-v1` remains the default; existing per-model calibration may compensate after enough **accepted same-profile samples**. The first small sample can be excluded by MAD filtering, so three different-size wire calls need not become three accepted DS4 calibration samples. Keep BPE and `autoTune` opt-in; do not port Hub's fixed 3.5% margin from these measurements. For promotion or automatic budget changes, collect a repeated same-size and mixed-size sample with matching DS4 manifest estimates and actual provider usage under an explicitly authorized, separately bounded run.

## Second observed run — 24 September 2026, 10:35 UTC

A separate, explicitly approved envelope covered **12 call attempts and up to 100,000 input characters**. The dry run planned exactly 12 attempts and 99,816 characters: `--sizes 512,16000` for three requested OpenAI models through each of OpenRouter and Codex. The live probe produced six OpenRouter usages and six Codex failures; it did not read session data.

| Route / requested model | User chars | Real input¹ | `chars-v1` | BPE `o200k-base-v1` | BPE residual |
|---|---:|---:|---:|---:|---:|
| OpenRouter / `openai/gpt-6-sol` | 512 | 189 | 161 | 196 | −7 |
| OpenRouter / `openai/gpt-6-sol` | 16,000 | 5,564 | 4,033 | 5,571 | −7 |
| OpenRouter / `openai/gpt-6-luna` | 512 | 189 | 161 | 196 | −7 |
| OpenRouter / `openai/gpt-6-luna` | 16,000 | 5,564 | 4,033 | 5,571 | −7 |
| OpenRouter / `openai/gpt-5.6-terra` | 512 | 189 | 161 | 196 | −7 |
| OpenRouter / `openai/gpt-5.6-terra` | 16,000 | 5,564 | 4,033 | 5,571 | −7 |

¹ Pi-normalized input includes cached tokens once. Each 16,000-character call reported `cacheWriteTokens = 5,561` and zero cache-read tokens. Those were **writes**, not cache hits. Each successful response reported five output tokens. The six equal input counts describe these identical synthetic prompts on this route; they are not proof of identical tokenizers or of how the direct Codex route would count a DS4 session. For each model, the adjacent BPE size slope was exactly 1.000; at 16k characters, raw `chars-v1` underestimated by 1,531 tokens (27.52% of actual), versus BPE overestimating by seven.

For `openai-codex/gpt-6-sol`, `gpt-6-luna`, and `gpt-5.6-terra`, **both sizes failed** without provider usage. The sanitized error classifier returned `quota` for all six, with no HTTP status captured. This is evidence of an SDK-path quota/limit error classification, **not** a verified account balance, an HTTP rejection, or a tokenizer measurement. It does not retroactively identify the earlier `gpt-5.4-mini` failure (classified `other`). No further calls were made beyond this run's approved envelope. Two sizes per exact model remain insufficient for DS4 calibration or auto-tuning conclusions.

## Isolated Pi + DS4 managed-context pilot — 24 September 2026

For a future, **separately authorized** run: build the core (`npm run build:core`), inspect the planned sizes and character count with `node scripts/compare-ds4-manifest-usage.mjs`, then use `node scripts/compare-ds4-manifest-usage.mjs --live` only after setting a new call/character budget. The default mode is pinned to OpenRouter `openai/gpt-6-sol` and a maximum of 12 calls / 120,000 controlled prompt characters per invocation. `--comparison` instead preflights **both** OpenRouter `openai/gpt-6-luna` and `openai/gpt-5.6-terra`, capped at 24 calls / 240,000 controlled characters combined; `--comparison --live` requires its own authorization. A new authorization is required even when repeating either exact plan.

The user separately authorized **up to 12 calls / 120,000 controlled input characters** to OpenRouter `openai/gpt-6-sol` only. `scripts/compare-ds4-manifest-usage.mjs` first checked a local sandbox without provider traffic, then made **12 single-turn calls**, with three repeats at each size (512, 4,096, 12,000 and 20,000 synthetic user characters). Planned synthetic user + fixed system text was **110,568 characters**. This limit counts controlled prompt text, **not** Pi-generated framing or serialized protocol bytes. No existing Pi session history was used; each Pi session and DS4 database was isolated in a temporary directory, with no tools, project content, native continuation, or auto-tuning. DS4's managed `context` hook and its `o200k-base-v1` profile override were active. The script stops on a missing/mismatched manifest or missing usage rather than fabricating a measurement.

| Synthetic user chars | First observed DS4 manifest estimate | First actual input¹ | First residual (actual − estimate) | Repeats |
|---:|---:|---:|---:|---:|
| 512 | 220 | 209 | −11 | 3 |
| 4,096 | 1,467 | 1,456 | −11 | 3 |
| 12,000 | 4,210 | 4,199 | −11 | 3 |
| 20,000 | 6,983 | 6,972 | −11 | 3 |

All **12** calls had matching `managed` manifests and Pi-normalized provider usage, with **exactly −11 tokens** of residual in each call. Token counts varied by about one or two between identically sized repeats, but the residual stayed fixed. The largest relative overestimate was **5.26% of actual input** on the first 512-character call (11/209); at 20,000 characters it was about **0.16%**. `cacheReadTokens` was zero, while longer calls reported mostly cache **writes**; no claim of cache hits or exact billed usage follows from those fields.

¹ `totalInputTokens` in the DS4 manifest (the same Pi-normalized `input + cacheRead + cacheWrite` metric used by model-awareness calibration), not independently obtained provider invoice data. Because the selected estimator was BPE, this pilot did **not** produce an alternative `chars-v1` DS4 manifest for the same wire requests. These are fresh one-turn sessions with one synthetic prompt shape and a maximum of ~7k actual tokens; they do not validate multi-turn prefixes, tool schemas/results, retrieval, real project text, larger windows, other requested models, or production auto-tuning. The 12 samples are independent sessions, **not** 12 accepted samples in one persistent DS4 calibration profile. Keep BPE opt-in and `autoTune` off by default; do not apply an inferred fixed framing correction or Hub's fixed 3.5% drift allowance from this pilot.

## Separately authorized Luna/Terra managed-context comparison — 24 September 2026

A subsequent authorization covered **at most 24 calls / 240,000 controlled synthetic input characters combined** on OpenRouter `openai/gpt-6-luna` and `openai/gpt-5.6-terra`; no Codex traffic was authorized. `node scripts/compare-ds4-manifest-usage.mjs --comparison` preflighted **24 calls / 221,136 controlled characters**. `--comparison --live` completed **12 calls per model**, with three fresh, isolated Pi+DS4 managed sessions per model at each synthetic user size (512, 4,096, 12,000, 20,000 characters). No existing session history, project content, tools, auto-tuning, or native continuation entered the requests. All 24 calls had matching manifests and Pi-normalized provider input usage; there were no reported failed rows.

| Model | First 512-character DS4 BPE estimate | First actual input¹ | Repeats per size | Residual on all 12 calls |
|---|---:|---:|---:|---:|
| OpenRouter / `openai/gpt-6-luna` | 220 | 209 | 3 | −11 tokens |
| OpenRouter / `openai/gpt-5.6-terra` | 219 | 208 | 3 | −11 tokens |

In every size group for both models, each of the three residuals was **−11 tokens**; each group reported zero `cacheReadTokens`. This replicates the small, constant **overestimate** observed for Sol on this specific one-turn synthetic shape. It does **not** establish a provider-independent 11-token correction, tokenizer equivalence across arbitrary text, long-window accuracy, model calibration from a continuous session, or safe budget auto-tuning. The combined 24-call authorization is exhausted. A later, separate authorization covered multi-turn, historical and executed tools, retrieval, and large selected inputs for all three OpenRouter models; see [native-window checks](MODEL_AWARENESS.md#native-window-checks-for-sol-luna-and-terra--separately-authorized) for results and the remaining unverified high-usage auto-tune withdrawal. Codex diagnosis still needs separate approval; keep BPE opt-in and `autoTune` off by default.
