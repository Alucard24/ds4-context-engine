# Proposal — Ship the Pi extension as a self-contained bundle

**Status:** Proposal, not implemented. No build, packaging or runtime change is
part of this document.

## Problem

Pi loads an extension entry point with `jiti.import(extensionPath,
{ default: true })` and keeps the modules already evaluated under that entry for
the life of the process. `/reload` re-imports the entry point, but a dependency
package such as `ds4-context-core` that was already loaded stays cached: a core
rebuilt under a running Pi is not picked up. Until 0.4.6 that surfaced as
`... is not a function` deep inside compaction; 0.4.6 added an engine/core
compatibility guard that detects the mismatch, logs `runtime.core_incompatible`
and keeps the DS4 compaction layer inert, but the operator still has to restart
Pi to run the rebuilt core.

The extension is published with TypeScript sources (`files: ["src", ...]`,
`pi.extensions: ["./src/extension/index.ts"]`) and imports the separately
published `ds4-context-core` through its package subpath exports at runtime.
Because the core is a real dependency in the consumer's `node_modules`, a
`/reload` cannot refresh it.

## Proposal

Bundle the core into the extension artifact so that the code Pi loads is one
module graph with no runtime dependency to refresh.

1. **Build step.** Add `esbuild` (dev dependency, pinned) and a
   `build:extension` script that bundles `src/extension/index.ts` into
   `dist/extension/index.js`:
   - `packages/core/src` is inlined (core is workspace-local, no version skew
     window inside one artifact);
   - `format: esm`, `platform: node`, `target: node22`;
   - keep `@earendil-works/*` and `node:*` external (Pi injects its own copies);
   - `js-tiktoken` stays a normal dependency and external, because the current
     adapter loads it lazily through `createRequire` for the opt-in BPE
     estimator; bundling it would change that lazy path;
   - emit a source map next to the artifact.
2. **Package entry points.** `pi.extensions` and `exports["."]` point to
   `./dist/extension/index.js`; `files` adds `dist` and may keep `src` for
   source-level debugging and for the existing pack inventory checks.
3. **Runtime dependency.** Drop `ds4-context-core` from the root package
   `dependencies` (it remains a published package for direct core consumers and
   for `ds4-context-reference-adapter`). The engine then has no separate core to
   go stale, and the engine/core mismatch class disappears for package installs.
4. **Build ordering.** `prepare` already runs `build:core` and
   `build:adapters`; it gains `build:extension` after them. `npm pack` and
   `npm publish` run `prepare` first, so published tarballs always contain a
   current bundle.
5. **Dev workflow unchanged.** Tests, `tsc --noEmit` and local source loading
   keep importing `src/` and `packages/core/src`; only the published artifact is
   bundled.

## Impact on release checks

- `scripts/verify-packages.mjs` (`pack:check`): the inventory requirements
  change from source paths to include `dist/extension/index.js` (today it
  requires, for example, `src/pi-adapter/compaction-workers.ts`); the clean
  consumer no longer installs `ds4-context-core` for the engine, so the exact
  adapter/core dependency assertion applies to the reference adapter only; the
  packaged-extension smoke test keeps launching Pi against the packed path.
- `scripts/verify-registry-packages.mjs` (`registry:check`): the same inventory
  and import checks; the public core and KV export imports still run against the
  published core package directly, so they do not cover the engine bundle and
  the smoke test through Pi remains the bundle's only end-to-end check.
- `pack:check` and `registry:check` file counts change (added bundle output,
  possibly removed core module from the engine consumer).
- CI commands (`npm run check`, `npm run pack:check`) stay the same; the bundle
  build must be deterministic enough that a rebuilt artifact does not change the
  validated behavior.

## Already-published packages

Published versions are immutable: this proposal cannot and does not touch the
existing `ds4-context-engine` tarballs. The change takes effect from the next
coordinated version. Operators on earlier versions keep the current behavior —
separate core plus the 0.4.6 guard, which converts the failure into one
actionable line instead of a missing function.

## Alternatives considered

- **Keep the separate core and the guard (status quo).** The guard is a
  mitigation, not a fix: a `/reload` after a core rebuild still leaves the
  session with DS4 compaction inert until Pi restarts.
- **Move the core into the extension package and stop publishing
  `ds4-context-core`.** Breaks the reference-adapter contract and the portable
  core boundary described in `AGENTS.md`.
- **Rely on Pi to reload dependency modules.** Not in the extension's control;
  Pi's loader caches evaluated modules by design.
- **Operational workaround (always restart Pi).** No packaging change, but it
  keeps a known trap in the product.

## Risks

- Bundling duplicates core code inside the engine for the package path; the two
  copies (published core, bundled core) can drift in version only if the build
  runs against a different core revision than the one used for publishing the
  core package. Building both from the same commit in `build:extension` avoids
  that.
- Source maps and stack traces move to `dist` paths in production reports; the
  release notes and `docs/` must say so.
- The compatibility guard stays relevant for source-mode runs (`pi` started from
  the repository) and should not be removed.
