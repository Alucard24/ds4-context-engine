# ADR 058 — Bound persisted Context Manifests before considering compression

- Status: Accepted
- Scope: SQLite schema 15 and the first storage-containment rollout

## Context

`context_manifests` is diagnostic derived state, but an observed database contained 3,358 rows and about 1.8 GB of serialized manifest JSON. Roughly 95% of a representative large manifest was the inventory of context items that were excluded from the provider request. Large inserts, later JSON rewrites for provider usage, and a global backlog can increase writer-lock duration.

Compression reduces bytes effectively, but adopting compressed payloads under schema 15 would make the JSON column misleading and would add codec, downgrade, migration, corruption, and decompression-limit concerns.

## Decision

1. Keep the latest 128 manifests globally.
2. Limit one online prune to 32 rows and 8 MiB of serialized payload, except that one individually oversized oldest row may be removed to guarantee progress.
3. Keep the runtime manifest complete.
4. Persist complete manifests up to 256 KiB.
5. Above 256 KiB, retain every included item and deterministically sample at most 256 excluded details (first 128 and last 128). Persist complete excluded counts, token rollups, classification/kind aggregates, and stable digests.
6. Skip persistence when the projected payload still exceeds 1 MiB.
7. Keep provider usage authoritative in existing scalar columns and do not rewrite `manifest_json` at `message_end`.
8. Keep up to 200 calibration samples per exact provider/model/estimator profile, independently of manifest retention.
9. Keep SQLite schema version 15 and configuration contract `ds4-context-config-v1` unchanged.
10. Defer payload compression to a separate ADR and append-only migration.

## Consequences

- Included provenance remains complete; excluded historical detail is explicitly marked `excluded-rollup` and is never presented as a complete inventory by the current runtime.
- Earlier schema-15 readers can parse the additive JSON but may mislabel sampled `excluded` details; downgrade support therefore excludes historical excluded-inventory rendering after a rollup has been written.
- Existing databases converge incrementally without a long startup purge.
- Deleted pages are reusable, but reclaiming physical file size requires explicit offline copy–validate–swap maintenance.
- A future compressed representation must define a versioned codec, raw/stored byte limits, payload hash, decompression-bomb protection, downgrade behavior, rebuild behavior, and a new migration. Base64-compressed JSON in `manifest_json` is not permitted under schema 15.
