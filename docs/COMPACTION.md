# Custom Compaction

DS4 intercepts Pi's `session_before_compact` event but preserves Pi's cut-point calculation. Raw JSONL history is never deleted or rewritten.

## Flow

1. Pi determines `messagesToSummarize`, optional split-turn prefix, and `firstKeptEntryId`.
2. DS4 maps every source message by exact fingerprint to a canonical branch entry ID.
3. Pi's serializer converts the newly discarded span to bounded conversation text.
4. The active model generates and validates an immutable segment summary with cache retention disabled and a fresh routing session ID.
5. If the active branch has a previous DS4 root, a second bounded call aggregates that root with the new segment; a Pi-native predecessor is imported as an explicitly unverified branch node.
6. All newly created nodes are persisted atomically as `prepared`; Pi receives only the active segment or aggregate text.
7. Pi appends its normal `CompactionEntry` with `fromHook: true`.
8. `session_compact` commits all nodes and associates the active root with the Pi entry; failure marks the prepared batch `failed`.

Any mapping, model, output-limit, validation, or storage error returns `undefined` from the hook, allowing Pi's default compaction to run.

## Required summary contract

```text
## Objective
## User Constraints
## Durable Decisions
## Completed Work
## Current State
## Files Read
## Files Modified
## Commands / Tests
## Errors / Risks
## Open Questions
## Next Actions
## Critical Exact Values
```

Every section must occur once, in order, and contain content or `- None`. Listed files must occur in source evidence or Pi's cumulative file-operation set. Backticked exact values must occur in the serialized segment source or ordered child summaries. Segment and aggregate outputs are validated independently; either failure prevents the whole graph batch from being installed.

## Provenance and recovery

`CompactionEntry.details` contains cumulative `readFiles` and `modifiedFiles` plus:

- summary and contract versions;
- active and newly created segment IDs;
- node kind, graph level, ordered child IDs, and SHA-256 source hash;
- transitive canonical source entry IDs;
- validation status and issue codes;
- retained entry ID and pre-compaction token count;
- trigger, split-turn flag, source message count;
- generation time, provider, and model.

For aggregate compactions, details also embed every non-active node created by that operation. The active node content remains `CompactionEntry.summary`; prior ancestors remain in earlier canonical entries. SQLite stores content, ordered edges, direct/transitive sources, graph level, and lifecycle as a disposable projection. On resume or after deleting the database, DS4 replays Pi entries in append order and recreates the complete graph.

Pi 0.84.3 locates the post-compaction entry by summary text, which can surface an older entry when deterministic test summaries are identical. DS4 therefore correlates commit with its pending summary ID and resolves the matching newly appended entry from `SessionManager`, never by text equality.

## Proactive trigger

After a settled turn, DS4 computes:

```text
segment threshold = fixed system/tools + adaptive recent tail + segmentTargetTokens
proactive threshold = min(model soft limit, segment threshold)
```

It requests compaction at most once per session leaf. Pi's native threshold and overflow compactions remain active independently.

## Diagnostics

```text
/context compaction
/context compact-preview
/context summaries
```

The preview reports thresholds and eligibility; Pi remains authoritative for the exact cut point.
