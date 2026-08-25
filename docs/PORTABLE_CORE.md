# Portable Core

M13 extracts the runtime-neutral implementation into the independently buildable `ds4-context-core` workspace package. The root `ds4-context-engine` package remains the Pi integration.

## Dependency rule

```text
agent runtime
    ↓
runtime adapter
    ↓
ds4-context-core
```

Core never imports an adapter or runtime SDK. The Pi adapter imports core through its public ESM exports.

The core may use Node.js standard-library facilities such as `node:sqlite`, filesystem APIs and cryptographic hashing. Portable means independent of Pi and reusable by another Node-based agent runtime; it does not mean browser-compatible.

## Package contents

`packages/core/src` owns:

- canonical message and model projections;
- token estimation, calibration and context budgets;
- deterministic planning and atomic group validation;
- manifest and provenance models;
- summary contracts, validation and graph records;
- historical and project retrieval;
- project indexing and artifact policy;
- memory/pin materialization;
- privacy classification and provider policy;
- native-continuation eligibility and hash state;
- rebuildable SQLite repositories;
- stable serialization, hashing and logging.

The root adapter owns all Pi-specific behavior:

- Pi message, model and session conversion;
- JSONL branch and custom-entry projection;
- extension lifecycle hooks and commands;
- summary model completion through Pi's registry;
- OpenAI Responses transport wrapping through Pi AI;
- fail-open integration orchestration and privacy fail-closed enforcement.

## Adapter responsibilities

A future runtime adapter must:

1. preserve its runtime's canonical history and expose stable source identifiers;
2. convert native messages to DS4 canonical messages without losing tool-call/result atomicity;
3. describe provider/model limits using the core model projection;
4. supply the current branch, request, system prompt, tools and trusted project path;
5. apply core plans without persisting provider-facing synthetic context as canonical history;
6. append memory/pin mutations to canonical runtime history before materializing derived state;
7. invoke model completion at the adapter boundary for generated summaries;
8. enforce privacy immediately before provider transport;
9. discard or rebuild SQLite and artifact projections safely;
10. fall back to native runtime behavior when operational integration fails.

## Build and exports

```bash
npm run build:core
npm run typecheck
npm test
npm pack --dry-run --workspace ds4-context-core
```

TypeScript sources compile to `packages/core/dist` as ESM JavaScript, source maps and declaration files. The npm package exports a top-level API and fine-grained subpaths such as:

```ts
import { calculateContextBudget } from "ds4-context-core";
import { planManagedContext } from "ds4-context-core/planner/context-planner";
```

The Pi package declares an exact same-release dependency on `ds4-context-core`. Release order is therefore core first, adapter second.

## Enforcement

`tests/unit/portable-core-boundary.test.ts` recursively rejects Pi SDK and adapter imports from core source, then imports the compiled package and exercises portable model/budget policy. Existing integration tests consume core through package exports, so the Pi adapter is tested across the actual package boundary.

## State guarantees

Extraction does not change DS4 state semantics:

- Pi JSONL remains canonical for Pi sessions;
- SQLite remains disposable and rebuildable;
- compaction remains non-destructive and strictly validated;
- provider continuation handles remain volatile;
- planner, retrieval, compaction and persistence failures still fail open at the adapter boundary;
- enabled privacy enforcement still fails closed before remote transport.
