# Local KV Reuse

M20 adds an opt-in, runtime-neutral prefix/KV capability for local inference runtimes. KV state is only an inference optimization: it is not canonical history, memory, retrieval evidence, a Context Manifest source, or a SQLite projection.

Pi does not expose native KV handles and continues to report `local-kv-reuse` as unsupported. The callback/JSONL reference adapter can exercise the capability when its host injects a `LocalKvRuntimePort`; no provider SDK is added to core or the reference package.

## Boundary

```text
runtime/provider payload
        ↓
adapter privacy enforcement
        ↓
runtime-specific prefix/options extraction from sanitized payload
        ↓
core exact-byte eligibility hashes
        ↓
volatile LocalKvRuntimePort lookup + transport
        ├─ exact hit ───────────────> cached completion
        └─ miss/rejected/unavailable -> full prompt replay
```

Core receives the provider-ready prefix only long enough to hash it. It returns metadata-only component hashes and an aggregate fingerprint. A runtime port maps that fingerprint to its own volatile handle. Handles never cross the port, and core has no API for serializing them.

## Configuration and negotiation

Configuration is disabled by default:

```json
{
  "localKvReuse": {
    "enabled": false
  }
}
```

Enabling configuration is not sufficient. The active adapter must independently declare a versioned `local-kv-reuse` capability and provide a `LocalKvRuntimePort`. Unsupported or malformed declarations disable KV reuse without affecting history, privacy, completion fallback, or any other capability.

A reference-adapter host opts in explicitly:

```ts
const adapter = new JsonlReferenceRuntimeAdapter({
  // canonical history, model, privacy, and ordinary transport options...
  localKv: {
    enabled: true,
    port: myVolatileKvPort,
    runtimeRevision: "llama-runtime-build-42",
    modelRevision: "model-checksum-abc",
    prepare(sanitizedPayload) {
      return {
        promptPrefix: exactProviderPrefixBytes(sanitizedPayload),
        systemOptions: providerSystemOptions(sanitizedPayload),
        toolOptions: providerToolOptions(sanitizedPayload),
        prefixTokenCount: 32_000,
        contextTokenCount: 40_000,
      };
    },
  },
});
```

`prepare()` receives only the payload returned by adapter privacy enforcement. Remote destinations never enter the local KV path.

## Exact eligibility

`deriveLocalKvEligibility()` uses `local-kv-eligibility-v1`. An eligible fingerprint includes independent SHA-256 components for:

- exact provider, model, and model revision;
- exact UTF-8/string or byte prefix;
- deterministic JSON-compatible system and tool options;
- privacy policy version and local destination;
- runtime identity, runtime revision, and capability implementation version.

Identifiers are not case-folded or wildcard-matched. Prefix bytes are not normalized. Option object keys are ordered only for deterministic serialization; values, array order, missing/undefined values, and system/tool separation remain significant. Functions, symbols, binary option values, accessors, custom prototypes, circular values, and non-finite numbers are ineligible instead of being hashed ambiguously.

Any changed prefix byte, provider/model identity, model revision, system/tool option, privacy version, runtime revision, or capability version produces a different fingerprint. Disabled configuration, unsupported capability, remote destination, invalid identifiers, an empty prefix, or invalid token counts bypass reuse.

## Runtime port and replay

`LocalKvRuntimePort` deliberately exposes no handle:

```ts
interface LocalKvRuntimePort {
  tryReuse(request): Promise<
    | { status: "hit"; output: unknown; savedPrefillTokens: number; prefillLatencyMs: number }
    | { status: "miss" | "rejected" | "unavailable" }
  >;
  fullReplay(request): Promise<{
    output: unknown;
    prefillTokens: number;
    prefillLatencyMs: number;
  }>;
  shutdown?(): Promise<void>;
}
```

The runtime owns fingerprint-to-handle lookup, eviction, provider transport, and restart cleanup. `LocalKvReuseController` treats thrown lookup errors and malformed lookup results as unavailable state. Every miss, stale rejection, unavailable state, or runtime restart invokes `fullReplay()` with the complete sanitized payload. If the injected KV full replay itself fails, the reference adapter retries the complete sanitized payload through its ordinary native transport.

Adapter shutdown calls optional port shutdown once. Cache deletion, eviction, process loss, or runtime restart therefore changes performance only; it cannot change canonical state or prevent a full replay.

## Aggregate diagnostics

`local-kv-diagnostics-v1` contains numbers only:

- requests, eligible requests, and bypasses;
- hits, misses, rejected states, unavailable states, full replays, and transport failures;
- reusable prefix tokens and total context-occupancy tokens;
- saved prefill tokens;
- full-replay prefill tokens and runtime-reported prefill latency.

Diagnostics never include provider/model text, prefix or payload content, component fingerprints, runtime handles, credentials, provider response IDs, or output. Per-request completion metadata keeps `contextTokens`, `savedPrefillTokens`, `replayPrefillTokens`, and `prefillLatencyMs` as separate fields; context occupancy is never reported as cache savings.

## Privacy and persistence

Privacy enforcement precedes runtime-specific prefix extraction and hash verification. A remote payload is sanitized and sent through ordinary transport without consulting local KV state. An enabled local policy is still applied before extraction. A prior cached state cannot authorize material excluded by the current privacy policy because the policy version and sanitized exact prefix are both part of eligibility.

No KV handle or prefix copy is written to:

- Pi JSONL or reference canonical JSONL;
- Context Manifests;
- DS4 SQLite;
- learned-ranking artifacts;
- adapter/core diagnostics.

There is no M20 database migration. Deleting all volatile runtime KV state requires no DS4 rebuild and no canonical-history migration.

## Verification and benchmark

Unit and reference-adapter integration tests cover exact hits, changed bytes/options, provider/model/privacy/runtime invalidation, cache loss, stale rejection, unavailable state, full replay, privacy-before-verification, aggregate-only diagnostics, idempotent shutdown, and unchanged canonical JSONL.

`tests/benchmarks/local-kv.bench.ts` hashes a synthetic 32,000-token reusable prefix inside a 40,000-token context and separately benchmarks a warm completion whose simulated runtime metadata reports 32,000 saved prefill tokens and `0.5 ms` prefill latency. On the development host, exact eligibility averaged about `0.259 ms` and the warm controller path about `0.248 ms`. These are observational, not portable provider-latency guarantees; the benchmark intentionally reports runtime prefill latency/token savings separately from context occupancy.
