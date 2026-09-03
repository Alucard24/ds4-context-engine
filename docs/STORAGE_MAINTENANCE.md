# Offline SQLite Storage Maintenance

DS4 keeps `context.db` as disposable derived state, while Pi session JSONL and live project files remain canonical. Normal runtime retention stops unbounded manifest growth and makes deleted pages reusable. It does not promise that an existing high-water SQLite file shrinks physically.

Physical compaction is therefore an explicit offline operation. It is never model-callable, never runs at startup, and never edits Pi JSONL or project files.

## Commands

The root package installs:

```text
ds4-context-storage inspect --database <exact-path>
ds4-context-storage compact --database <exact-path>
ds4-context-storage recover --database <exact-path>
```

`inspect` is metadata-only and read-only. `compact` and `recover` require an interactive local TTY; there is no V1 `--yes` option. The database path is mandatory and is normalized before use.

Typical default path:

```text
~/.pi/agent/ds4-context/context.db
```

Do not run `compact` until every Pi process that may use that database is closed. On Linux, an additional read-only holder check can be made with:

```text
fuser -v context.db context.db-wal context.db-shm
```

The utility never terminates a process.

## Online diagnostics first

With Pi running:

```text
/context health
/context storage
```

`/context storage` reports only schema, journal mode, file/page sizes, manifest and calibration counts, current-project aggregate counts, artifact totals, convergence state, and categorical maintenance reasons. It does not expose manifest rows, messages, claims, snippets, tool payloads, SQL, or raw SQLite errors.

A storage warning makes overall health display `WARN`, but it does not make SQLite corruption checks fail and does not alter the provider request.

## Cooperative exclusion protocol

Each new file-backed `ContextDatabase` client creates a private lease under:

```text
context.db.clients/<client-id>.json
```

The lease contains only protocol version, client ID, PID, creation time, and a database-path fingerprint. The database is opened only after a two-phase check for:

```text
context.db.maintenance.lock
```

The maintenance utility creates that lock exclusively and refuses compaction when a verified client is alive or a lease/PID is ambiguous. Verified dead-client leases may be removed. A process started during maintenance sees the lock, does not open SQLite, and leaves Pi on its existing fallback path. Database close occurs before client-lease removal.

Older DS4 versions do not create leases, so the interactive assertion that every Pi instance is closed remains mandatory.

## Compact protocol

`compact` performs these phases:

1. validate exact path, regular-file type, stage-file absence, schema 15, migration checksums, `quick_check`, and foreign keys;
2. acquire the maintenance lock and refuse active or ambiguous clients;
3. verify conservative free space for backup, working copy, candidate, and safety margin;
4. create a standalone SQLite backup using `node:sqlite.backup()` from a read-only source connection;
5. validate that backup;
6. create an exclusive working copy from the backup;
7. on the working copy only, retain 128 newest manifests, retain 200 calibration samples per exact profile, detach calibration from deleted manifests, and rewrite retained manifests through the bounded serializer;
8. checkpoint and close the working copy;
9. create `context.db.compact-ready` with `VACUUM INTO`;
10. validate quick/FK/schema checks, hard manifest bounds, protected-table counts and private full-row digests, and source-exclusion keys;
11. persist swap state, retire the source and its WAL/SHM sidecars, install the candidate, fsync, and validate again;
12. remove temporary working/retired files, release the lock, and retain exactly one fixed backup.

The fixed files are:

```text
context.db.maintenance-work
context.db.compact-ready
context.db.precompact.bak
context.db.swap-old
context.db.maintenance-state.json
```

Existing stage or backup files are never overwritten. A failure before swap leaves the source in place. A failure during swap attempts immediate restoration of the retired source and sidecars. Persisted state supports deterministic recovery after process interruption.

## Recover

Use `recover` only when a prior operation reports recovery state or leaves `context.db.maintenance-state.json`.

The command fails closed on ambiguous combinations. Depending on the persisted phase it will:

- remove uninstalled staging while retaining the source;
- restore the retired source after an interrupted first rename;
- keep a valid installed candidate and clean the retired source;
- restore the retired source when the installed candidate fails validation.

Every database selected for use is checked again. Persisted state is accepted only when every fixed path matches the selected database. Recovery does not guess from timestamps or file sizes and never overwrites the fixed backup.

## Post-maintenance checks

After successful compaction:

1. retain `context.db.precompact.bak`;
2. reopen Pi;
3. run `/context health` and `/context storage`;
4. verify expected Pin, Memory, and local project-source exclusion behavior;
5. dogfood normal model calls;
6. remove the backup manually only after the observation period succeeds.

If rollback is needed, close Pi before invoking recovery or manually restoring the validated standalone backup. No storage rollback requires a Pi JSONL change.

## Packaging and privacy

Package verification rejects database, WAL, SHM, backup, candidate, work, retired swap, lock, state, client-lease, JSONL, `.pi`, and `.serena` paths. Protected-table digests are compared only in process and are never printed. CLI output is bounded to phases, counts, sizes, schema/check status, exact user-selected local paths, and categorical recovery guidance.
