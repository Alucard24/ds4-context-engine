# 067 — Detect an engine/core artifact mismatch before compaction runs

**Date:** 2026-09-27
**Status:** Accepted
**Related:** [`docs/RELEASING.md`](../RELEASING.md)

## Context

A machine reported, right after a Pi `/reload`:

```text
Warning: DS4 compaction unavailable; using Pi default.
(0 , _summaryContract.classifyUnsupportedExactValueSpans) is not a function
```

The message was read as an installation mismatch, but every artifact on disk was
current: `packages/core/dist/compaction/summary-contract.js` in the checkout and
the npm-installed `ds4-context-core@0.4.3` both export the symbol (the core is
ESM, so the export is an `export function` declaration, not an
`exports.<name>` assignment). No stale file existed.

The remaining explanation is process-local module state. Pi loads extension
sources through jiti (`dist/core/extensions/loader.js`) and re-imports the
extension entry when its cache generation changes — which is what `/reload`
does — while modules that were already evaluated for that process, including the
`ds4-context-core` dependency, keep their loaded instance. An extension source
newer than the core module instance it resolved therefore calls a symbol that
the cached core does not have. The failure costs the whole compaction attempt and
reports a symptom (`is not a function`) that points at DS4 rather than at the
process state.

## Decision

- `packages/core/src/version.ts` exports `CORE_VERSION`, bumped with the two
  adapters by the coordinated release process.
- `src/pi-adapter/core-compatibility.ts` inspects the engine↔core contract at
  runtime: version equality plus the presence of the core entry points this
  extension calls (`buildSummaryPrompt`,
  `classifyUnsupportedExactValueSpans`). The inspection is a pure function, so
  it is testable without a broken installation.
- The guard runs on session start — so a `/reload` reports the state
  immediately, before any compaction is attempted — and again as the first
  statement of the guarded compaction attempt.
- On a mismatch the engine logs `runtime.core_incompatible`, notifies once with
  a single-line actionable message, sets the runtime `lastError`, and **does not
  create the compaction coordinator**: DS4 compaction stays inert, `/context
  compaction` reports `enabled: false` with the reason, and Pi compacting with
  its own default is the only behaviour left rather than a half-finished DS4
  run.
- The guard never throws from the extension load path: Pi treats an extension
  load error as fatal (`main.js` exits with code 1), so a stale core must not
  prevent Pi from starting.
- The message carries both remedies in order: rebuild the checkout
  (`npm ci && npm run build:core && npm run build:adapters`) or update the
  installed package (`pi update --extensions`), then **restart Pi**, because a
  `/reload` keeps the already-loaded core module.

## Consequences

- A stale core no longer surfaces as `... is not a function`; it surfaces as one
  line naming both versions, the missing entry point and the exact command to
  run.
- `CORE_VERSION` must stay imported from the package root. A *missing file* is a
  module-resolution failure, while a *missing named export* of an existing module
  arrives as `undefined` through the CommonJS interop Pi uses for extension
  sources — which is the only form the guard can inspect.
- Version equality is strict, which matches the synchronized versioning rule:
  after a version bump the core must be rebuilt before the extension is used.
- The guard detects and bounds the failure; it does not invalidate the module
  cache. A rebuilt core still requires a restarted Pi process, and `/reload`
  alone remains insufficient for core changes. Shipping the extension as a
  self-contained artifact would remove that dependency, and is left as a
  separate packaging decision.
