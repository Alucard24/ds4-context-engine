# Hierarchical Summary Graph

The summary graph preserves every validated historical summary while keeping Pi's active compaction text bounded.

## Node model

```text
segment S1 (raw entries 1..N)       level 0
segment S2 (raw entries N+1..M)     level 0
                 \                 /
                  aggregate A1      level 1
                            \
segment S3 (raw entries M+1..K) ---- aggregate A2  level 2
```

A node has an immutable ID, kind, content, SHA-256 source hash, raw source IDs, ordered child IDs, graph level, validation state, model metadata, and lifecycle. Current compaction creates one segment. If the active branch already has a root, it also creates one aggregate with ordered children `[previousRoot, newSegment]`. Only the new root is returned as Pi's `CompactionEntry.summary`.

The aggregate input is always two bounded child summaries, so generation cost and active prompt size do not grow with raw session length. Graph depth can grow, but old node text is never concatenated wholesale into later prompts.

## Provenance

- Segment hashes cover canonical source messages, direct file evidence, and ordered Pi entry IDs.
- Aggregate hashes cover ordered child IDs, kinds, levels, and source hashes.
- Aggregate `sourceEntryIds` are the transitive union of child sources.
- `summary_edges` preserves child order with `child_order`.
- Graph levels must strictly increase from child to parent.
- Existing IDs cannot be reused with different immutable content, kind, source hash, creation time, or level.

The current segment is embedded in schema-v2 Pi details when an aggregate is active. An imported Pi-native previous summary is stored as a warning-level `branch` node because its original source provenance is unavailable. Legacy DS4 schema-v1 summaries are accepted as level-zero segments.

## Branch isolation

Aggregation resolves the previous root by matching `preparation.previousSummary` to a DS4 compaction entry in `event.branchEntries`. It never selects the session-global newest summary. Alternative branch roots remain queryable but cannot enter the current branch automatically.

`/context summaries` marks the active root and its transitive child path with `*`. Other committed roots represent alternate branches or historical graph heads.

## Atomic lifecycle

1. Generate and validate the new segment.
2. Generate and validate the aggregate when a predecessor exists.
3. Insert all new rows, raw-source links, and edges in one SQLite transaction as `prepared`.
4. Return the active root and canonical graph metadata to Pi.
5. Commit the whole batch after Pi appends `CompactionEntry`, or fail it after `session_compact_failed`.

If any generation, validation, topology, or storage operation fails, no partial graph batch is installed and Pi's native compaction remains the fallback.

## Reconstruction

SQLite is disposable. Rebuild order follows canonical Pi JSONL append order:

1. index all raw session entries;
2. normalize each DS4 compaction detail record;
3. restore embedded nodes created by that compaction;
4. restore the active node and its ordered edges;
5. associate the active node with the Pi compaction entry ID.

This reconstructs segment and aggregate history without storing a second canonical event log.
