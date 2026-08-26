# ds4-context-core

Runtime-neutral core of [DS4 Context Engine](https://github.com/Alucard24/ds4-context-engine).

The package contains deterministic context policy and rebuildable local projections without importing Pi or any other agent runtime. Runtime integrations translate their native sessions and models at the adapter boundary.

## Included

- versioned runtime adapter contract and framework-neutral conformance runner;
- canonical messages and token estimation;
- model profiles, calibration and context budgets;
- deterministic planning and atomic tool groups;
- Context Manifest generation;
- validated hierarchical compaction records;
- exact, FTS and deterministic hybrid rank fusion;
- runtime-neutral embedding port, derived vector storage and quality comparison;
- runtime-neutral structural symbol parsing with deterministic regex fallback;
- project knowledge and artifact storage;
- append-only memory and pin materialization;
- privacy classification and provider policy;
- optional continuation state decisions;
- deterministic metadata-only context-quality replay and comparison;
- bounded learned-ranking features, local training, checksummed artifacts and promotion evaluation;
- rebuildable SQLite repositories.

## Install

```bash
npm install ds4-context-core
```

Core and Pi adapter releases use matching versions. The core package is published first because the adapter depends on that exact version.

## Usage

```ts
import {
  calculateContextBudget,
  createDefaultConfig,
  createModelProfile,
} from "ds4-context-core";

const config = createDefaultConfig();
const profile = createModelProfile({
  provider: "example",
  id: "model",
  contextWindow: 128_000,
  maxTokens: 16_000,
});
const budget = calculateContextBudget(profile, config.context);
```

Fine-grained ESM subpath exports are available, for example:

```ts
import { planManagedContext } from "ds4-context-core/planner/context-planner";
import { compareQualityStrategies } from "ds4-context-core/quality/context-quality";
import { DeterministicRegexSymbolParser } from "ds4-context-core/project/symbol-parser";
import type { EmbeddingPort } from "ds4-context-core/retrieval/embedding";
import { SemanticEmbeddingIndex } from "ds4-context-core/retrieval/semantic-index";
import { rankCandidates } from "ds4-context-core/ranking/learned-ranker";
import { runRuntimeAdapterConformance } from "ds4-context-core/adapter/conformance";
import { negotiateRuntimeCapabilities } from "ds4-context-core/adapter/runtime-adapter";
```

## Adapter boundary

An adapter is responsible for:

1. projecting runtime-native messages into canonical DS4 messages;
2. identifying the active session, branch, provider and model;
3. supplying canonical history and project trust state;
4. applying the planned context through runtime hooks;
5. invoking model completion while enforcing privacy immediately before transport;
6. persisting canonical mutations in the runtime's own history;
7. negotiating optional runtime capabilities independently;
8. shutting down idempotently and falling back to the native runtime path on integration failure.

The Pi implementation lives in the root `ds4-context-engine` package under `src/pi-adapter` and `src/extension`. The separately packaged `ds4-context-reference-adapter` demonstrates the same contract with canonical JSONL and an injected completion callback. See the repository's Runtime Adapter Kit documentation for conformance and packaging rules.

## Portability guarantee

`packages/core/src` may import Node.js standard-library modules, but it must not import:

- `@earendil-works/pi-ai`;
- `@earendil-works/pi-coding-agent`;
- `src/pi-adapter` or `src/extension`.

A boundary test enforces this rule.

## License

[MIT](LICENSE)
