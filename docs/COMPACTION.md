# Custom Compaction

DS4 intercepts Pi's `session_before_compact` event but preserves Pi's cut-point calculation. Raw JSONL history is never deleted or rewritten.

## Flow

1. Pi determines `messagesToSummarize`, optional split-turn prefix, and `firstKeptEntryId`.
2. DS4 maps every source message by exact fingerprint to a canonical branch entry ID.
3. Pi's serializer converts the discarded span to bounded conversation text.
4. The active model generates the DS4 summary contract with cache retention disabled and a fresh routing session ID.
5. A deterministic validator checks structure and source support.
6. The summary is persisted as `prepared` and returned to Pi.
7. Pi appends its normal `CompactionEntry` with `fromHook: true`.
8. `session_compact` marks the summary `committed`; failure marks it `failed`.

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

Every section must occur once, in order, and contain content or `- None`. Listed files must occur in source evidence or Pi's cumulative file-operation set. Backticked exact values must occur in the serialized source, previous summary, or cumulative file evidence. Invalid summaries are never installed.

## Provenance and recovery

`CompactionEntry.details` contains cumulative `readFiles` and `modifiedFiles` plus:

- summary and contract versions;
- summary ID and SHA-256 source hash;
- canonical source entry IDs;
- validation status and issue codes;
- retained entry ID and pre-compaction token count;
- trigger, split-turn flag, source message count;
- generation time, provider, and model.

SQLite stores the summary content and lifecycle as a disposable projection. On resume, DS4 reconciles committed Pi entries and can recreate missing summary rows.

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
```

The preview reports thresholds and eligibility; Pi remains authoritative for the exact cut point.
