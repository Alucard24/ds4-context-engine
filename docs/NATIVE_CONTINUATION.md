# Optional Native Continuation

M12 adds an opt-in OpenAI Responses optimization without making provider state canonical.

## Decision

Pi 0.84.3 exposes two relevant integration surfaces:

- `before_provider_request` can replace the serialized payload, but it cannot transparently retry the same model call after a provider rejects stale state;
- `registerProvider(..., { streamSimple })` can delegate to Pi's built-in serializer/transport while observing the terminal stream and retrying before any partial assistant event is exposed.

DS4 therefore registers a narrow provider wrapper only for explicitly configured providers. The wrapper delegates to Pi's built-in `openai-responses` implementation. It does not implement authentication, HTTP, SSE parsing, tool serialization, usage accounting, or model discovery itself.

OpenAI conversation IDs were evaluated but are not enabled in M12. `previous_response_id` is the smaller state primitive, requires no second canonical conversation tree, and can always fall back to the full managed replay. Pi's `openai-codex-responses` transport already has its own connection-scoped cached continuation and is not replaced by this wrapper.

## Explicit provider-storage consent

Native continuation is disabled by default. Eligible requests require both:

```json
{
  "nativeContinuation": {
    "enabled": true,
    "allowProviderStorage": true,
    "profiles": ["openai/*"],
    "maxStateAgeMs": 1800000,
    "retryManagedReplay": true
  }
}
```

`allowProviderStorage` acknowledges that DS4 changes eligible OpenAI Responses payloads from Pi's default `store: false` to `store: true`. Provider-side retention and deletion are governed by the selected provider. `maxStateAgeMs` limits only reuse of the volatile local handle; it does not delete provider-side data.

Profiles must be exact `provider/model` values or explicit `provider/*` wildcards. A global wildcard is rejected. Model IDs may contain `/`, for example `proxy/vendor/model`.

A trusted project configuration may enable this feature. Configuration from an untrusted project remains ignored by the existing trust gate.

## Request algorithm

For an eligible main-agent request, after all Pi `before_provider_request` handlers have produced the final privacy-sanitized payload, DS4:

1. normalizes the full request to `store: true`;
2. hashes every full `input` item independently with deterministic SHA-256;
3. hashes all non-input request options, including model, tools, output settings, and cache settings;
4. compares the current input prefix with:

```text
previous full request input
+ previous serialized response output items
```

5. only on an exact hash match sends:

```json
{
  "previous_response_id": "<volatile handle>",
  "input": ["only new suffix items"],
  "store": true
}
```

6. otherwise sends the complete DS4-managed payload and establishes a new chain from the successful response.

The manager retains hashes plus the minimum volatile response handle. It does not retain prompt text, tool payloads, or response output text. The provider handle is never logged or copied into a Context Manifest. Pi may persist the provider's normal `AssistantMessage.responseId` in canonical JSONL; DS4 adds no custom canonical entry or SQLite continuation table.

## Transparent managed-replay retry

If a continuation request is rejected before streaming starts and the provider error identifies invalid, expired, unknown, or missing previous-response state, the wrapper:

1. suppresses that unstarted error event;
2. clears the volatile handle;
3. rebuilds the request through Pi's normal serializer and all payload hooks;
4. retries once with the complete managed replay and no `previous_response_id`.

Unrelated failures such as authentication or rate limiting are not retried by this layer. Errors after a stream has started are never replayed because doing so could duplicate visible output or tool effects. Pi's ordinary retry policy remains available after DS4 returns a terminal failure.

## Conservative invalidation

State is discarded on:

- provider or model switch;
- session branch/tree navigation;
- successful compaction;
- session shutdown/reload or degraded runtime;
- local state age above `maxStateAgeMs`;
- changed model/tools/output/cache request options;
- any managed-context prefix mismatch, including changed summaries, privacy filtering, project evidence, pins, memory, or active tools;
- empty deltas;
- missing provider response IDs or non-reconstructable response items;
- provider request/stream failure.

Nested DS4 summary calls use a fresh Pi `sessionId` and are never opted into provider storage or continuation. Observer-mode calls also remain unchanged.

## Privacy and canonical state

The continuation transform runs after Pi's payload callback chain, so it only removes an already checked prefix and adds state metadata. It never reintroduces classified content. If enabled privacy enforcement replaces a failed payload with `{}`, continuation is skipped and the provider call fails closed as before.

The full Pi JSONL history, DS4 summaries, memory/pins, and Context Manifests remain sufficient for managed replay. Deleting or expiring provider state affects optimization only.

## Diagnostics

Use:

```text
/context continuation
/context manifest
/context status
/context health
```

Diagnostics expose only:

- enabled/consent/profile/wrapper state;
- full versus continuation request counts;
- full/sent/omitted input-item counts;
- state age, generic fallback/invalidation reason, and retry outcome;
- warning counts.

They never expose provider response IDs or provider payload content.

## Tests and performance

Unit tests cover exact/wildcard eligibility, consent validation, cold establishment, exact suffix derivation, option/prefix/age invalidation, nested-call exclusion, and response-ID non-disclosure. Stream tests cover pre-stream stale-handle replay and refusal to retry unrelated failures. Integration coverage verifies provider registration, metadata-only manifests/SQLite, and branch invalidation.

`tests/benchmarks/native-continuation.bench.ts` hashes and verifies a 1,000-item managed prefix. On the development host it measured about 2.88 ms mean and 5.39 ms p99, below the existing 50 ms context-operation target; this is not a portable guarantee.

A real Pi 0.84.3 isolated RPC E2E used a local OpenAI Responses-compatible HTTP server for three turns. It observed full → one-item delta → rejected stale delta → automatic full replay, with `store: true`, successful retry diagnostics, canonical JSONL preservation, metadata-only manifests, SQLite integrity/FK checks, and zero `extension_error` events.
