# DS4 0.2.0 Release Readiness

This document is the release-candidate hardening record for the 0.2 line. It does not announce a release. A candidate is publishable only after the commands below pass on a clean commit and the exact published registry artifacts pass the post-publication check.

## Frozen compatibility surface

The 0.2 release line freezes three additive contracts:

| Surface | Frozen value | Change rule |
|---|---|---|
| configuration | `ds4-context-config-v1` | Existing keys, types, validation, and defaults do not change within 0.2. Additive work requires an explicit review and remains opt-in. An incompatible shape requires a new schema version. |
| SQLite projection | schema `15` | Migrations 1–15 are immutable. New projection changes append a migration; existing SQL/checksums are never rewritten. |
| runtime adapter | `runtime-adapter-v1` / `runtime-history-v1` | The four capability IDs and v1 behavior are fixed. Incompatible adapter or history changes require a new contract version. |

`tests/golden/compatibility-0.2.0.json` pins the full default configuration, every migration name/checksum, adapter/history/conformance versions, capability IDs, and local-KV contract versions. The golden test is intentionally strict: an intentional post-0.2 contract must create a new fixture rather than silently updating this one.

## Upgrade and rebuild

A 0.1.0/0.1.2 derived database ends at schema 10. Opening it with 0.2 applies migrations 11–15 in order. `tests/integration/upgrade-rebuild.test.ts` creates an exact schema-v10 database with recorded historical checksums and legacy session/project rows, upgrades it, and verifies that the original projections are unchanged while new tables remain empty.

A 0.1 configuration remains valid. Newly introduced behavior retains safe defaults:

- semantic retrieval: disabled;
- cross-session memory: disabled;
- context-quality recording: disabled;
- learned ranking: `off`;
- local KV reuse: disabled;
- embedding defaults: local only.

Complete deletion of `context.db`, `context.db-wal`, and `context.db-shm` loses only projections. Rebuild coverage is distributed by canonical source:

- session entries and FTS: `tests/integration/session-indexer.test.ts`;
- memory/pins and supersession: `tests/integration/memory-extension.test.ts`;
- cross-session project mutations, corruption, and source exclusion: `tests/integration/cross-session-memory.test.ts`;
- project files/snippets and semantic vectors: `tests/integration/project-knowledge.test.ts` and `tests/unit/semantic-index.test.ts`;
- artifact references/objects: `tests/integration/artifact-extension.test.ts`;
- quality aggregates from the versioned local corpus: `tests/integration/context-quality-repository.test.ts`;
- reference-adapter snapshots: `tests/integration/reference-adapter.test.ts`.

Pi JSONL, reference-adapter JSONL, and live project files are never deleted by a rebuild.

## Long-session and provider-switch hardening

`tests/integration/long-session.test.ts` replays a 1,201-message session through 24 managed planning cycles. It verifies:

- the current request remains byte-for-byte present;
- selected input remains below the model hard input limit without planner fallback;
- the canonical JSONL file is unchanged;
- the session index contains one row per canonical entry with no duplicate growth;
- bounded quality retention remains at its configured maximum;
- disabled manifests, embeddings, memory, and pins create no rows.

`tests/integration/model-awareness-extension.test.ts` switches 32k, 128k, and 200k local/remote profiles. It verifies exact-model calibration isolation, cold/reused profile state, adaptive budgets, override precedence, and privacy re-enforcement on every destination change. Native continuation and local-KV tests independently reject stale state after model/runtime changes and fall back to full replay.

## Release-gate matrix

| Gate | Evidence |
|---|---|
| 0.1 regressions and package boundaries | `npm run check`, `npm run pack:check` |
| disposable projection rebuild | rebuild tests listed above |
| lexical-only operation | default config plus retrieval/runtime fallback tests |
| local and explicitly remote embedding privacy | `tests/integration/privacy-extension.test.ts`, `tests/unit/semantic-index.test.ts` |
| cross-session branch/supersession/corruption/isolation | `tests/integration/cross-session-memory.test.ts` |
| learned-ranking promotion or shadow-only fallback | `tests/unit/learned-ranker.test.ts`, `tests/unit/ranking-adapter.test.ts` |
| Pi/reference adapter conformance | `tests/unit/pi-runtime-contract.test.ts`, `tests/integration/reference-adapter.test.ts` |
| feature-disabled p95 ≤ 110% of 0.1 | `npm run latency:check -- <0.1.2-core-root>` |
| long-session integrity and bounded growth | `tests/integration/long-session.test.ts` |
| matching package versions and clean consumers | `npm run pack:check`; after publish, `npm run registry:check -- <exact-version>` |
| minimum Node and current LTS | CI matrix: Node `22.19.0` and `24.x` |
| migration/privacy/limitations/rollback docs | this document, `STORAGE.md`, `PRIVACY.md`, adapter/KV documentation |

The latency check loads exact `ds4-context-core@0.1.2` and the local 0.2 build in one process, runs the same deterministic feature-disabled 401-message fixture, alternates samples to reduce host drift, and rejects a p95 ratio above `1.10`. The comparison contains only timings and package versions.

## Candidate validation

Install the exact stable baseline into an isolated temporary project, then run:

```bash
BASELINE_DIR="$(mktemp -d)"
printf '{"private":true}' > "$BASELINE_DIR/package.json"
npm install --prefix "$BASELINE_DIR" --ignore-scripts --no-audit --no-fund \
  --package-lock=false ds4-context-core@0.1.2

npm ci
npm run check
npm run pack:check
npm run latency:check -- "$BASELINE_DIR/node_modules/ds4-context-core"
git diff --check
git status --short
rm -rf "$BASELINE_DIR"
```

After publishing all three packages in dependency order, verify registry bytes rather than local tarballs:

```bash
npm run registry:check -- 0.2.0-rc.1
```

The registry check accepts an exact version, never a mutable dist-tag. It installs all three public packages plus the supported Pi SDK into a fresh project, validates matching exact core dependencies, imports core and local-KV exports, runs compiled reference conformance, runs the packaged quality corpus, and starts the published Pi extension through isolated offline RPC state.

## Rollback

SQLite is forward-only. A 0.1 binary correctly refuses to open schema 15; do not edit `schema_migrations`, checksums, or `PRAGMA user_version` to force a downgrade.

To roll back the Pi adapter:

1. stop every Pi process using the shared database;
2. retain all Pi session JSONL and project files;
3. remove or archive only `context.db`, `context.db-wal`, `context.db-shm`, disposable artifacts/embeddings, and the learned-ranking model;
4. install the desired 0.1 package and let it create a fresh derived database, or point it at a new `storage.databasePath`;
5. leave reference-adapter canonical JSONL untouched if that adapter was used.

New 0.2 configuration keys are ignored by 0.1 with warnings, but removing them reduces operator ambiguity. Disabling semantic retrieval, cross-session memory, ranking, quality, continuation, and local KV before rollback is optional because none of those states is canonical.

## Known limitations

- Active learned ranking still requires explicit promotion metadata; otherwise static ordering remains authoritative.
- Pi exposes no local KV handles and reports that capability as unsupported.
- The reference adapter is an inspectable callback/JSONL implementation, not a production streaming runtime.
- Remote embeddings require exact provider/model consent and enabled privacy filtering.
- Runtime quality samples are unlabeled for evidence recall; the versioned replay corpus supplies deterministic labels.
- Derived manifest/calibration history grows with completed provider turns when persistence is enabled; it contains metadata only and can be discarded with the database.
