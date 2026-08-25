# Releasing DS4

DS4 publishes two packages with the same version:

1. `ds4-context-core`, the runtime-neutral compiled package;
2. `ds4-context-engine`, the Pi adapter.

The adapter has an exact dependency on the matching core version, so the core package must always be published first.

## Prerequisites

- use a clean `main` checkout synchronized with `origin/main`;
- use a supported Node.js release and npm account authorized for both package names;
- verify that both `package.json` files use the intended version;
- verify that `ds4-context-engine` depends exactly on that version of `ds4-context-core`;
- do not include session data, `.pi` state, databases, credentials, or provider payloads.

The automated package check enforces matching versions, the exact core dependency, bounded tarball inventories, clean consumer installation, core ESM exports, and packaged Pi extension startup through isolated RPC state.

## Validate

```bash
npm ci
npm run check
npm run pack:check
git diff --check
git status --short
```

CI runs the same checks on the minimum supported Node.js version and the current Node.js LTS line. `npm run pack:check` uses a temporary directory and removes it when complete. Set `DS4_KEEP_PACK_TMP=1` only when diagnosing a failed package check.

Review both public tarballs before publishing:

```bash
npm pack --dry-run --workspace ds4-context-core
npm pack --dry-run
```

## Version

Keep the root package, core workspace, and exact adapter dependency synchronized. For a future version stored in `$VERSION`:

```bash
npm pkg set version="$VERSION"
npm pkg set version="$VERSION" --workspace ds4-context-core
npm pkg set dependencies.ds4-context-core="$VERSION"
npm install --package-lock-only
npm run pack:check
```

Review `package.json`, `packages/core/package.json`, and `package-lock.json` before committing the release change.

## Publish

Authenticate with npm, verify the active account, and publish in dependency order:

```bash
npm whoami
npm publish --workspace ds4-context-core --access public
npm publish --access public
```

If core succeeds but adapter publication fails, fix the adapter release and retry it with the same version. Do not rewrite or unpublish a valid core release merely to make the two commands appear atomic.

After both registry packages are available:

1. install them in a fresh temporary project and rerun the package smoke check if registry propagation was delayed;
2. create and push the signed or annotated `v$VERSION` tag;
3. create the GitHub Release from that tag;
4. update installation documentation if registry names or requirements changed.

Never move an existing release tag or publish different contents under an existing version.
