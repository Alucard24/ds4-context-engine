# DS4 Context Engine for Pi

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Pi 0.84.3](https://img.shields.io/badge/Pi-0.84.3-blue.svg)](https://github.com/earendil-works/pi)
[![Node.js >=22.19](https://img.shields.io/badge/Node.js-%3E%3D22.19-339933.svg)](https://nodejs.org/)

DS4 Context Engine is a non-destructive, provider-independent context management layer for [Pi](https://github.com/earendil-works/pi). It keeps Pi's native JSONL session as the canonical history and builds a smaller, inspectable, model-aware working context for each model call.

```text
complete Pi JSONL history
          ↓
DS4 planning, retrieval, summaries and policy
          ↓
bounded active context with provenance
          ↓
Pi provider
```

> **Project status:** M0–M17 are implemented on `main`; M14–M17 begin the planned 0.2.0 line with opt-in quality measurement, structural indexing, hybrid retrieval and cross-session project memory. The latest published Pi adapter and `ds4-context-core` packages remain version `0.1.2`; the adapter targets Pi `0.84.3`.

## Why DS4

Long coding sessions accumulate old decisions, repeated context, large tool outputs and project state faster than any model context window can hold them. DS4 separates durable history from the model's current working set.

It provides:

- deterministic token budgeting with soft and hard input limits;
- preservation of the current request, recent turns and atomic tool call/result groups;
- exact and FTS5 historical retrieval with source provenance;
- opt-in hybrid semantic retrieval with a deterministic local embedding and lexical fallback;
- trust-gated structural project indexing, Git-aware invalidation and bounded source snippets;
- hierarchical, validated, non-destructive compaction summaries;
- persistent pins and append-only durable memory stored canonically in Pi JSONL;
- opt-in checkpointed project-memory replay across exact trusted Pi project sessions;
- content-addressed storage and bounded references for large tool results;
- privacy classifications, secret redaction and provider-specific allow rules;
- model-specific calibration and adaptive context allocation;
- optional verified continuation for eligible OpenAI Responses profiles;
- opt-in metadata-only context-quality metrics and deterministic replay comparisons;
- an inspectable Context Manifest explaining included and excluded material;
- fail-open recovery to Pi's native context path for operational failures.

## Architectural guarantees

1. **Pi JSONL remains canonical.** DS4 never replaces Pi's session format.
2. **SQLite is disposable.** It contains derived projections and can be rebuilt from canonical sources.
3. **Compaction is non-destructive.** Raw history is not deleted or rewritten.
4. **Provenance is preserved.** Retrieved and summarized context identifies its source.
5. **Tool groups remain atomic.** Tool calls are not separated from their results.
6. **Provider state is optional.** Continuation handles and cache state are never canonical.
7. **Operational failures fail open.** Pi can continue with its native context behavior.
8. **Enabled privacy enforcement fails closed.** Restricted content is replaced or the provider payload is rejected instead of being leaked.

## Requirements

- [Pi](https://github.com/earendil-works/pi) `0.84.3`
- Node.js `22.19.0` or newer
- SQLite support provided by Node's built-in `node:sqlite`

Pi is intentionally pinned until extension contract tests validate a newer release.

## Installation

Pi packages execute with the user's full permissions. Review and trust the source before installing this or any other extension.

### From GitHub

```bash
pi install git:github.com/Alucard24/ds4-context-engine
```

To try it for one run without adding it to settings:

```bash
pi -e git:github.com/Alucard24/ds4-context-engine
```

### From npm

Install the public npm package with:

```bash
pi install npm:ds4-context-engine
```

### Local checkout

```bash
git clone https://github.com/Alucard24/ds4-context-engine.git
cd ds4-context-engine
npm ci
npm run check
pi install -l .
```

For extension development without installing the package:

```bash
pi -e ./src/extension/index.ts
```

Restart Pi or run `/reload` after installing or changing the extension.

## Quick start

DS4 starts in managed mode with conservative defaults. No configuration file is required.

After loading the extension, inspect its state:

```text
/context status
/context tokens
/context health
```

Global configuration is loaded from:

```text
~/.pi/agent/ds4-context.json
```

A trusted project can override it with:

```text
.pi/ds4-context.json
```

Use observer mode as a pass-through rollback while retaining diagnostics:

```json
{
  "context": {
    "mode": "observer"
  }
}
```

Disable the extension's behavior without uninstalling it:

```json
{
  "enabled": false
}
```

Project configuration and project source indexing are disabled when Pi reports the project as untrusted.

## Commands

### Inspection

| Command | Purpose |
| --- | --- |
| `/context` or `/context status` | Runtime, session, planner and subsystem status |
| `/context tokens` | Token budget and active-context composition |
| `/context manifest` | Latest Context Manifest |
| `/context explain` | Human-readable planning explanation |
| `/context included` | Items selected for the latest model call |
| `/context excluded` | Items excluded from the latest model call |
| `/context summaries` | Hierarchical summary graph diagnostics |
| `/context retrieved` | Historical retrieval diagnostics |
| `/context project` | Project index and retrieval status |
| `/context privacy` | Classification and provider-policy status |
| `/context model` | Active model profile and calibration |
| `/context quality` | Metadata-only context-quality scores and sample counts |
| `/context continuation` | Native continuation decisions and counters |
| `/context artifacts` | Artifact storage and integrity status |
| `/context compaction` | Last compaction status |
| `/context compact-preview` | Preview compaction diagnostics |
| `/context health` | SQLite and subsystem health checks |
| `/context rebuild-index` | Rebuild derived state from canonical sources |

### Pins and durable memory

```text
/context pins
/context pin [--scope session|branch|project] [--classification LEVEL] <content>
/context unpin PIN_ID [reason]

/context memory
/context memory list
/context memory add [--scope session|project] [--key KEY] [--classification LEVEL] <claim>
/context memory supersede MEMORY_ID [--source ID,ID] <new claim>
/context memory invalidate MEMORY_ID [reason]
/context memory expire MEMORY_ID [reason]
/context memory sources
/context memory exclude SESSION_ID [reason]
/context memory include SESSION_ID
```

Valid privacy classifications are `normal`, `internal`, `sensitive` and `local-only`.

## Configuration reference

The following example shows the main configuration groups. Omitted values use the defaults in [`packages/core/src/config/config.ts`](packages/core/src/config/config.ts).

```json
{
  "enabled": true,
  "context": {
    "mode": "managed",
    "targetFillRatio": 0.7,
    "softLimitRatio": 0.8,
    "hardLimitRatio": 0.9,
    "minimumOutputReserve": 8192,
    "preferredOutputReserve": 32768,
    "recentTailTokens": 64000,
    "maxPinnedTokens": 16000,
    "maxMemoryTokens": 8000,
    "maxRetrievedHistoryTokens": 16000,
    "maxProjectTokens": 20000,
    "maxSummaryTokens": 12000
  },
  "retrieval": {
    "exact": true,
    "fts": true,
    "semantic": false,
    "maxResults": 12,
    "embedding": {
      "mode": "local",
      "provider": "ds4-local",
      "model": "feature-hash-v1",
      "dimensions": 256,
      "remoteProfiles": [],
      "maxSources": 50000,
      "candidatePool": 80,
      "batchSize": 64,
      "queryCacheSize": 64,
      "timeoutMs": 2000
    }
  },
  "project": {
    "enabled": true,
    "maxFiles": 10000,
    "maxFileBytes": 512000,
    "maxTotalBytes": 50000000,
    "snippetLines": 80,
    "snippetOverlapLines": 12,
    "maxResults": 8
  },
  "memory": {
    "enabled": true,
    "crossSession": false,
    "maxProjectSessions": 250,
    "maxPinChars": 4000,
    "maxClaimChars": 2000,
    "maxResults": 12
  },
  "artifacts": {
    "enabled": true,
    "maxInlineToolResultChars": 12000,
    "maxArtifactBytes": 100000000,
    "maxSearchBytes": 50000000,
    "excerptChars": 6000,
    "maxSearchMatches": 12,
    "storeLargeOutputs": true
  },
  "compaction": {
    "enabled": true,
    "mode": "hierarchical",
    "validate": true,
    "segmentTargetTokens": 30000,
    "preserveRecentVerbatim": true
  },
  "privacy": {
    "enabled": false,
    "defaultClassification": "normal",
    "localProviders": ["faux", "ollama", "llama-cpp", "lmstudio"],
    "remoteDefaultAllowed": ["normal", "internal"],
    "remoteProviders": {
      "openrouter": ["normal"]
    },
    "redactSecrets": true
  },
  "modelAwareness": {
    "enabled": true,
    "calibrationWindow": 24,
    "minimumCalibrationSamples": 3,
    "calibrationRatioLowerBound": 0.5,
    "calibrationRatioUpperBound": 2.0,
    "overrides": {
      "openrouter/vendor/model": {
        "contextWindow": 200000,
        "maxRetrievedHistoryTokens": 12000
      }
    }
  },
  "nativeContinuation": {
    "enabled": false,
    "allowProviderStorage": false,
    "profiles": ["openai/*"],
    "maxStateAgeMs": 1800000,
    "retryManagedReplay": true
  },
  "quality": {
    "enabled": false,
    "maxSamples": 1000
  },
  "diagnostics": {
    "storeContextManifest": true,
    "storeFullRenderedContext": false,
    "logLevel": "info"
  },
  "storage": {
    "databasePath": "ds4-context/context.db",
    "busyTimeoutMs": 5000,
    "writeRetryTimeoutMs": 30000,
    "projectIndexLeaseMs": 120000
  }
}
```

Invalid or unknown values are ignored with a warning. Model overrides merge deterministically from `*` to `provider/*` to an exact `provider/model` profile.

## Privacy and provider storage

Privacy enforcement is disabled by default and must be configured for the providers you use. Unknown providers are treated as remote unless explicitly listed as local. `local-only` content is never permitted by a remote allow rule.

Native continuation is also disabled by default. Enabling it requires both explicit storage consent and an exact or provider-scoped profile:

```json
{
  "nativeContinuation": {
    "enabled": true,
    "allowProviderStorage": true,
    "profiles": ["openai/*"]
  }
}
```

Eligible OpenAI Responses requests then set `store: true`. Review the provider's retention policy before enabling this option. DS4 keeps response handles only in volatile memory, verifies exact managed prefixes before reuse and retries once with a full managed replay when recognized continuation state is stale.

See [`docs/PRIVACY.md`](docs/PRIVACY.md) and [`docs/NATIVE_CONTINUATION.md`](docs/NATIVE_CONTINUATION.md).

## Storage and recovery

By default, derived state is stored below Pi's agent directory:

```text
~/.pi/agent/ds4-context/
├── context.db
└── artifacts/
```

The database contains rebuildable indexes, summary metadata, manifests, project projections and calibration data. All Pi sessions share this WAL database: writes use bounded busy-aware transaction replay, and a renewable project lease prevents multiple Pi processes from indexing the same project concurrently. `busyTimeoutMs` controls each SQLite lock wait, while `writeRetryTimeoutMs` bounds the total replay window. Canonical memory and pin mutations remain append-only entries in Pi JSONL. Project files remain canonical for project knowledge. Complete tool results remain in Pi JSONL while the artifact store keeps verified, content-addressed copies for bounded retrieval.

To validate or rebuild derived state:

```text
/context health
/context rebuild-index
```

Deleting DS4's database must not alter a Pi session or project, although derived indexes and calibration data will be regenerated. When `memory.crossSession` is enabled for a trusted project, DS4 discovers bounded sibling Pi JSONL files by exact canonical header identity, incrementally replays their explicit project mutations, and excludes missing or unverifiable sources.

## Development

```bash
npm ci
npm run build:core
npm run typecheck
npm test
npm run check
npm run quality:compare
npm run pack:check
npm pack --dry-run
npm pack --dry-run --workspace ds4-context-core
```

The test suite covers configuration, migrations, canonical JSONL projection, planning, atomic tool groups, retrieval, compaction, project knowledge, artifacts, memory, privacy, model awareness, continuation, the portable-core dependency boundary and Pi extension lifecycle behavior. The package check also builds both tarballs, installs them in a clean temporary consumer and starts the packaged extension with isolated Pi RPC state.

### Portable core

`ds4-context-core` is a compiled ESM package with no Pi dependency. It owns runtime-neutral policy, storage and projections; agent adapters translate native sessions and lifecycle hooks at the boundary. The root `ds4-context-engine` package is the Pi adapter and depends one-way on the core workspace.

### Repository layout

```text
packages/core/src   portable policy, planning, compaction, retrieval and storage
src/pi-adapter      Pi JSONL projection, summary completion and provider integration
src/extension       Pi hooks, commands and fail-open orchestration
tests               core contract, unit, integration, golden and benchmark coverage
scripts             package and release-readiness checks
.github/workflows   continuous integration
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Context planner](docs/CONTEXT_PLANNER.md)
- [Context quality](docs/CONTEXT_QUALITY.md)
- [Context Manifest](docs/CONTEXT_MANIFEST.md)
- [Compaction](docs/COMPACTION.md)
- [Summary graph](docs/SUMMARY_GRAPH.md)
- [Historical retrieval](docs/RETRIEVAL.md)
- [Hybrid semantic retrieval](docs/HYBRID_RETRIEVAL.md)
- [Project knowledge](docs/PROJECT_KNOWLEDGE.md)
- [Artifacts](docs/ARTIFACTS.md)
- [Memory and pins](docs/MEMORY_AND_PINS.md)
- [Privacy](docs/PRIVACY.md)
- [Model awareness](docs/MODEL_AWARENESS.md)
- [Native continuation](docs/NATIVE_CONTINUATION.md)
- [Portable core](docs/PORTABLE_CORE.md)
- [Storage](docs/STORAGE.md)
- [Roadmap 0.2.0](docs/ROADMAP_0.2.0.md)
- [Release process](docs/RELEASING.md)
- [Architecture decisions](docs/ADR/README.md)
- [Original development plan](DS4_Context_Engine_Extension_Piano_Sviluppo.md)

## Roadmap

The original M0–M13 roadmap is complete. `ds4-context-core` now contains the compiled Pi-independent implementation, while runtime-specific behavior remains in the Pi adapter. M14 context-quality metrics, M15 rich symbol indexing and M16 hybrid semantic retrieval are implemented on `main`; semantic ranking remains opt-in and lexical retrieval stays authoritative.

The remaining [0.2.0 roadmap](docs/ROADMAP_0.2.0.md) covers optional learned ranking, a runtime adapter kit with one reference adapter, and optional local KV reuse. Sensitive or transport-specific behavior remains opt-in, and the 0.1 lexical planner stays available as the deterministic fallback.

## Contributing

Issues and focused pull requests are welcome. Before submitting a change:

1. preserve Pi JSONL as canonical history;
2. keep SQLite and artifacts rebuildable;
3. preserve provenance and atomic tool groups;
4. retain strict compaction validation and safe fallback behavior;
5. add or update tests;
6. run `npm run check`, `npm run pack:check` and `git diff --check`.

Please include reproduction steps for bugs and avoid attaching real session files, credentials or private provider payloads.

## License

[MIT](LICENSE)
