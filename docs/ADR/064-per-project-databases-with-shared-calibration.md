# 064 — Per-project databases with shared token calibration

**Date:** 2026-09-25
**Status:** Accepted
**Related:** [002](002-pi-jsonl-canonical-sqlite-rebuildable.md), [058](058-bounded-manifest-storage.md), [063](063-fts-rowid-key-mappings.md)

## Context

The storage plan decided **D1**: keep one shared SQLite projection at
`~/.pi/agent/ds4-context/context.db` for every Pi session and explicitly avoid
per-session *or per-project* databases. That projection is deliberately
derived, rebuildable and disposable.

The session index (`entries`, `entries_fts`) is the table that actually grows
with total indexed history, and automatic eviction remains deferred until an
on-demand rehydration path is verified. A single file therefore also means a
single growth boundary, a single write lock and a single point of physical
reset shared by unrelated projects. Content is already partitioned logically
by `sessions.project_path`, `project_states`, `project_files` and
`project_memory_sessions`; the file boundary was the only thing missing.

The one piece of genuinely global learning is token calibration. Schema v10's
`token_calibration` is keyed by exact `provider + model + estimator_version`
and has **no project column**: a naive per-project split would restart
calibration for every project (minimum 3 samples, 8 accepted for the opt-in
`autoTune` expansion), weakening exactly the BPE/auto-tuning path it should
protect.

## Decision

Add `storage.scope: "agent" | "project"` (default `"project"`) to the storage
configuration:

- `agent` keeps the previous shared-database behavior and remains selectable.
- `project` derives one database per trusted canonical project root:
  `projects/<sha256(canonicalRoot)[0..32]>.db`, next to the configured agent
  database. Untrusted projects, broad roots (home directory, filesystem root)
  and any resolution failure fall back to the agent database.

Both files receive the **same schema and the same migrations**; there is no
schema fork and migrations 1–15 are untouched. The split changes only which
repository each handle is used for:

- the agent database keeps `token_calibration` (shared learning);
- the project database keeps the session index, project index, context
  manifests, summary graph, memory/pin projections, embeddings, quality
  samples and artifact metadata; artifact object bytes move to
  `projects/artifacts/<project-digest>/` so the orphan garbage collector,
  which only sees references in the current database, can never delete
  another project's objects;
- `resource_leases` and the client lease stay per file, protecting each
  database independently.

With `project`, a calibration sample is derived from the project manifest and
inserted into the agent database with `manifest_id = NULL` (the column and its
partial unique index already allow this). The two writes are intentionally
**not** one cross-database transaction: losing one calibration sample is
harmless, whereas losing manifest/usage consistency is not. In `agent` scope
the previous single transaction is unchanged. Manifest pruning only detaches
calibration rows in `agent` scope; the project database's calibration table
stays empty.

Every project database starts empty and is rebuilt from canonical Pi JSONL,
project files and memory/pin `CustomEntry` records. The previous shared
database is left untouched: with the default change, existing users cold-start
their per-project indexes while their existing calibration remains available
in the agent database.

## Consequences

- Physical isolation per project: separate growth, separate write lock,
  "reset project state" = remove one file, and no eviction needed to bound a
  single project's index.
- Calibration stays global: a sample learned in project A is immediately
  visible in project B for the same provider/model/estimator.
- Default behavior changes. A pre-existing shared database becomes the agent
  database (calibration and old manifests) and is no longer the active
  projection for new sessions. This requires a minor release and release
  notes; `storage.scope: "agent"` restores the old layout.
- Maintenance and diagnostics become per file: `/context storage` reports the
  active project database and, when split, the shared agent database;
  `ds4-context-storage inspect|compact|recover --database <path>` must be
  pointed at each file.
- `storage.databasePath` now names the agent database; project databases
  derive from its directory. A manually configured per-project path keeps
  working, but the derived `projects/` directory is the supported layout.
- D1 is superseded by this ADR; the development plan keeps the original text
  with an explicit amendment pointer.
