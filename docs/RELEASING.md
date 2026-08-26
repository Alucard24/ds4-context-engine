# Releasing DS4

DS4 publishes three packages with the same version:

1. `ds4-context-core`, the runtime-neutral compiled package and adapter kit;
2. `ds4-context-reference-adapter`, the non-Pi callback/JSONL reference implementation;
3. `ds4-context-engine`, the Pi adapter.

Both adapters have an exact dependency on the matching core version, so core must be published first.

## Prerequisites

- use a clean `main` checkout synchronized with `origin/main`;
- use a supported Node.js release and npm account authorized for all three package names;
- verify that all three `package.json` files use the intended version;
- verify that both adapters depend exactly on that version of `ds4-context-core`;
- do not include session data, `.pi` state, databases, credentials, or provider payloads.

The automated package check enforces matching versions, exact core dependencies, runtime-SDK isolation, bounded tarball inventories, clean consumer installation, core ESM exports, compiled reference-adapter conformance, and packaged Pi extension startup through isolated RPC state. For the 0.2 line, also confirm the frozen `ds4-context-config-v1`, SQLite schema 15 migration checksums, and `runtime-adapter-v1` compatibility golden.

## Validate

```bash
npm ci
npm run check
npm run pack:check
git diff --check
git status --short
```

For a 0.2 release candidate, compare feature-disabled planning against exact stable `ds4-context-core@0.1.2` on the same host:

```bash
BASELINE_DIR="$(mktemp -d)"
printf '{"private":true}' > "$BASELINE_DIR/package.json"
npm install --prefix "$BASELINE_DIR" --ignore-scripts --no-audit --no-fund \
  --package-lock=false ds4-context-core@0.1.2
npm run latency:check -- "$BASELINE_DIR/node_modules/ds4-context-core"
rm -rf "$BASELINE_DIR"
```

The check rejects a candidate p95 above 110% of the exact 0.1.2 baseline. See [`RELEASE_READINESS_0.2.0.md`](RELEASE_READINESS_0.2.0.md) for the complete gate matrix and rollback procedure.

CI runs the same checks on the minimum supported Node.js version and the current Node.js LTS line. `npm run pack:check` uses a temporary directory and removes it when complete. Set `DS4_KEEP_PACK_TMP=1` only when diagnosing a failed package check.

Review all public tarballs before publishing:

```bash
npm pack --dry-run --workspace ds4-context-core
npm pack --dry-run --workspace ds4-context-reference-adapter
npm pack --dry-run
```

## Version

Keep the root package, both workspaces, and exact adapter dependencies synchronized. For a future version stored in `$VERSION`:

```bash
npm pkg set version="$VERSION"
npm pkg set version="$VERSION" --workspace ds4-context-core
npm pkg set version="$VERSION" --workspace ds4-context-reference-adapter
npm pkg set dependencies.ds4-context-core="$VERSION"
npm pkg set dependencies.ds4-context-core="$VERSION" --workspace ds4-context-reference-adapter
npm install --package-lock-only
npm run pack:check
```

Review `package.json`, both workspace package manifests, and `package-lock.json` before committing the release change.

## Publish

Authenticate with npm, verify the active account, and publish in dependency order:

```bash
npm whoami
npm publish --workspace ds4-context-core --access public
npm publish --workspace ds4-context-reference-adapter --access public
npm publish --access public
```

If core succeeds but an adapter publication fails, fix that adapter release and retry it with the same version. Do not rewrite or unpublish a valid core release merely to make the commands appear atomic.

After all registry packages are available:

1. verify the exact registry artifacts (never a mutable dist-tag):

   ```bash
   npm run registry:check -- "$VERSION"
   ```

   This installs all three packages in a fresh temporary project, checks exact adapter/core dependencies, imports public core/KV exports, runs compiled reference conformance and the packaged quality corpus, and starts the published Pi extension through isolated offline RPC state.
2. create and push the signed or annotated `v$VERSION` tag;
3. create the GitHub Release from that tag;
4. update installation documentation if registry names or requirements changed.

Never move an existing release tag or publish different contents under an existing version.
