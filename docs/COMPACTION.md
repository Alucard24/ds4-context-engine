# Custom Compaction

DS4 intercepts Pi's `session_before_compact` event but preserves Pi's cut-point calculation. Raw JSONL history is never deleted or rewritten.

## Flow

1. Pi determines `messagesToSummarize`, optional split-turn prefix, and `firstKeptEntryId`.
2. DS4 maps every source message by exact fingerprint to a canonical branch entry ID.
3. Pi's serializer converts the newly discarded span to bounded conversation text; enabled privacy policy sanitizes conversation, custom instructions, and file paths for the active provider.
4. The active model generates and validates an immutable segment summary against sanitized evidence with cache retention disabled and a fresh routing session ID.
5. If the active branch has a previous DS4 root, a second bounded call aggregates only that root's content with the new segment content; DS4-generated IDs, hashes, kinds, and graph levels remain outside model-visible evidence. A Pi-native predecessor is imported as an explicitly unverified branch node.
6. The highest input classification is wrapped around each generated node, then all nodes are persisted atomically as `prepared`; Pi receives only the active segment or aggregate text.
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

Every section must occur once, in order, and contain content or `- None`. DS4 replaces each unique `Files Read` and `Files Modified` section with one exact path per bullet from Pi's sanitized file-operation inventory before validation; missing or duplicate sections still fail. Backticked exact values must occur in the serialized segment source, ordered child-summary content, or those known file-operation paths. A bounded unsupported exact-value bullet is removed as a whole and recorded as a validation warning; unsupported prose, more than eight affected bullets, or removal above 25% still fails closed to Pi. The prompt explicitly asks the model to omit a bullet whose complete backticked span cannot be copied verbatim. Segment and aggregate outputs are validated independently; either unrepaired failure prevents the whole graph batch from being installed.

An unrepaired exact-value failure reports only the stage, issue code, categorical repair status, unsupported-span count, and affected-bullet count. Repair statuses distinguish an unsupported location, more than eight bullets, removal above 25%, and an unexpected invalid second validation. The disputed text is intentionally absent from logs, UI notifications, and diagnostics because it may contain sensitive source material.

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

Memory and pin custom entries do not participate directly in Pi's LLM context and are not replaced by summary text. Their append-only mutations remain in the session tree, so durable decisions and explicit classifications replay after any number of compactions without depending exclusively on a summary.

When privacy is enabled, local summary generation may consume allowed local-only source, but the stored node inherits `local-only`. A later switch to a remote provider replaces that complete summary before serialization. Old summaries generated while privacy was disabled cannot be retroactively classified if the model removed source markers; rebuild preserves, but cannot invent, that metadata.

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
