# Custom Compaction

DS4 intercepts Pi's `session_before_compact` event but preserves Pi's cut-point calculation. Raw JSONL history is never deleted or rewritten.

## Flow

1. Pi determines `messagesToSummarize`, optional split-turn prefix, and `firstKeptEntryId`.
2. DS4 maps every source message by exact fingerprint to a canonical branch entry ID.
3. Pi's serializer converts the newly discarded span to bounded conversation text; enabled privacy policy sanitizes conversation, previous summary, custom instructions, and file paths for the effective compaction provider (dedicated model when configured and eligible).
4. DS4 estimates the **complete** sanitized request against a calibrated summary-specific input budget, including framing, instructions, file inventories and output contract. With `compaction.directUpdate` enabled, a previous summary plus new source that fits is updated and validated in **one call**, producing an immutable `task-state` node. No predecessor needs only the existing one-segment call. Oversized updates fall through to hierarchical planning; no additional source is truncated to force a fit.
5. The hierarchical path partitions source into ordered contiguous segments capped at `min(compaction.segmentTargetTokens, requestInputLimitTokens)`, where the effective request limit is also bounded by the selected model input budget. The target is soft only for one indivisible atomic group: an individual message or complete tool call/result exchange may exceed it, but must still fit the effective request input limit and is isolated in its own segment. Up to `compaction.maxConcurrentSegments` independent segment requests run concurrently (default 2). Each summary is validated against only its own sanitized evidence. Identities, source/child order and usage accumulation follow source order, not completion order. Cache retention stays disabled and every attempt has a fresh routing session ID.
6. Hierarchical requests recursively aggregate ordered children until one root remains: previous branch summary first, then new segments. Aggregation stays sequential and budget-checked. Direct updates instead link their single node to the predecessor and new canonical source IDs, without generating a synthetic segment or a separate aggregate. DS4-generated IDs, hashes, kinds, and graph levels never become model-visible evidence. A Pi-native predecessor is imported as an explicitly unverified branch node.
7. The highest input classification wraps each generated node, then all nodes are persisted atomically as one `prepared` graph batch. Usage includes every returned direct/segment/aggregate request and transport replay. Pi receives only the final root text and still appends exactly one canonical `CompactionEntry` with `fromHook: true`.
8. `session_compact` commits all nodes and associates the active root with the Pi entry; failure marks the complete prepared batch `failed`.

Fan-out and fan-in are bounded to 32 segment requests, 64 aggregate requests, and 16 aggregate passes. The DS4 transport replay policy is: `compaction.transport.maxAttempts` (default 4, matching Pi's initial call plus three retries) total attempts and `compaction.transport.baseDelayMs` (default 2000 ms, capped at 60 s) backoff, doubling per attempt, abort-aware. Replay never applies to input, usage, rate, authentication, validation, or output-limit failures. A base prompt, individual message, atomic tool exchange, pair of child summaries, or total operation that cannot fit within those limits fails closed. Any mapping, budget, model, output-limit, validation, abort, or storage error returns `undefined` from the hook, allowing Pi's default compaction to run. On segment failure or cancellation DS4 stops scheduling, aborts siblings and awaits all started workers before fallback; no partial graph is installed. Cancellation is cooperative: accepted provider work may still cost tokens, and a provider that ignores abort can delay settlement.

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

Every section must occur once, in order, and contain content or `- None`. DS4 replaces each unique `Files Read` and `Files Modified` section with one exact path per bullet from Pi's sanitized file-operation inventory before validation; missing or duplicate sections still fail. Backticked exact values must occur literally in the serialized segment source, ordered child-summary content, or those known file-operation paths, either as written or in the canonical JSON-escaped rendering of the value. A decoded value whose encoded text is present in the evidence is accepted ([ADR 065](ADR/065-exact-value-escaped-equivalence.md)); the reverse direction — an escaped span whose raw form is present — remains unsupported and is reported as `unescaped-form-present`. Every unsupported span is repaired the same way: the two backticks are retracted and the text stays, so the fact survives as prose and the exact-value claim does not ([ADR 069](ADR/069-retract-quoting-of-every-unsupported-exact-value.md)). No bullet is deleted for an exact-value failure, the eight-bullet and 25% removal bounds no longer apply to it, and the repaired summary is re-validated: any remaining structural problem still fails closed to Pi, and every backticked value that survives is still verified literally or as its canonical JSON-escaped rendering. The prompt requires every backticked span to be one contiguous excerpt copied as-is and forbids assembling one span from separately supported values (a setting name with its value, a path with a line range, a command with its flags), and it gives the model a cheaper alternative than composing: backtick only the fragments that are themselves contiguous with the joining text outside the backticks, or write the value as ordinary text without backticks, keeping the bullet. A bullet is omitted only when the fact itself has no support in the evidence ([ADR 066](ADR/066-quoting-downgrade-and-span-adjacency.md)). Every segment is validated independently against only its own sanitized source and deterministic file inventory. Every aggregate is validated independently against only the sanitized content of its ordered children and cumulative deterministic file inventory. A direct update is validated against both the sanitized previous summary and new source, plus cumulative sanitized file evidence; previous-summary-only exact values remain valid evidence. Custom focus instructions are not factual evidence. Any unrepaired failure prevents the whole graph batch from being installed.

A fail-closed compaction reports only the stage, issue codes, the repair status, the unsupported-span count and the affected-bullet count. An exact-value repair either retracts the quoting (`downgraded`) or is not needed; a summary that is still invalid after the retraction is reported as `post-downgrade-invalid` and remains a structural failure. The disputed text is intentionally absent from logs, UI notifications, and diagnostics because it may contain sensitive source material.

The same failure carries a class-only span report on the fallback warning (`unsupportedSpanClasses`): rejected-span count, affected bullets, length buckets, character shapes (spaces, backslashes, escape sequences, separators, quotes, typographic characters, JSON punctuation), and how each distinct span relates to the evidence — escaped or unescaped rendering, collapsed whitespace, case or typographic variant, one-character deletion, two separately present values joined into one span — adjacent in one source with nothing but joining punctuation and spaces between them (`composed-adjacent-present`) or found at unrelated positions (`composed-two-present-parts`) — or no near-miss (every applicable lookup ran and found nothing). The adjacency question separates a join that re-renders a contiguous evidence region from an association the evidence never contains: a joiner gap holds no letters, digits or line breaks, so two parts on separate lines are not adjacent. The report contains class names and counters only, never span text, and it is observation-only: neither validation nor the repair consults the relations, because every unsupported span is downgraded whatever its class. It exists to separate a summarizer that invents values from one whose rendering or composition rules differ from the validation domain, which would call for opposite prompt or model changes. The first production report produced by the 0.4.4 diagnostics attributed 9 of 14 rejected spans to composition, 2 to a one-character deviation, 2 to absence and 1 to the length limit, with no rendering class left at all.

Three relations mark spans that were *not* analysed, and they must never be read as invention. `not-classified-length` means the span exceeds the near-miss length limit (96 characters); `not-classified-partial` means its share of the budget ran out; `not-classified-budget` means the shared budget was already exhausted. To keep the histogram interpretable, transformed-form lookups cover every distinct span before any near-miss analysis starts, and each near-miss candidate may spend only an equal share of what remains (at least 32 lookups, never more than the budget left). The report also carries `spansClassifiedCheap` (span occurrences attributed by a transformed-form relation), `corpusSources`, `probeBudget` and `probesUsed`, so a run can be read without guessing how much of the budget was consumed. The shared budget defaults to 24000 evidence-source scans, where one lookup scans every corpus source once. `escaped-form-present` is not expected in reports from 0.4.4 on: validation accepts the canonical escaped rendering and the classifier consumes the same predicate, so such spans no longer reach it; the class stays in the taxonomy for compatibility. `classificationComplete` is false when the shared budget or a per-span share stopped an analysis; a `not-classified-length` span does not clear it, because that limit is deterministic rather than a resource shortfall.

## Provenance and recovery

The engine checks its own contract with the loaded core at session start and at the start of every compaction attempt: `CORE_VERSION` must equal the extension version and the core entry points the extension calls must be present. Because Pi loads extension sources from TypeScript but keeps dependency modules loaded for the life of the process, a core rebuilt under a running Pi stays stale in memory and a `/reload` is not enough to pick it up; without the check the first missing export surfaced as `... is not a function` deep inside generation. A mismatch now logs `runtime.core_incompatible`, notifies once with the versions and the failing entry point, and leaves the compaction coordinator uncreated, so `/context compaction` reports `enabled: false` with that reason and Pi's own compaction is the only behaviour left. The guard is detection only: it never changes validation, repair behaviour or the fail-closed decision, and it never throws while the extension is loading, because Pi treats an extension load error as fatal ([ADR 067](ADR/067-core-version-guard.md)).

`CompactionEntry.details` contains cumulative `readFiles` and `modifiedFiles` plus:

- summary and contract versions;
- active and newly created segment IDs;
- node kind, graph level, ordered child IDs, and SHA-256 source hash;
- transitive canonical source entry IDs;
- validation status and issue codes;
- retained entry ID and pre-compaction token count;
- trigger, split-turn flag, source message count;
- generation time, provider, and model.

For aggregate and direct-update compactions, details also embed every non-active node created by that operation. Direct updates reuse the schema-v2 `task-state` kind, set `segmentSummaryId` to their own node ID, increment the predecessor's level, and include the union of previous/new canonical source IDs. Their hash binds the new source hash to predecessor ID, hash, content and level. Prior nodes are never rewritten; no unused segment is fabricated. The active node content remains `CompactionEntry.summary`; prior ancestors remain in earlier canonical entries. SQLite stores content, ordered edges, direct/transitive sources, graph level, and lifecycle as a disposable projection. On resume or after deleting the database, DS4 replays Pi entries in append order and recreates the complete graph.

Memory and pin custom entries do not participate directly in Pi's LLM context and are not replaced by summary text. Their append-only mutations remain in the session tree, so durable decisions and explicit classifications replay after any number of compactions without depending exclusively on a summary.

When privacy is enabled, local summary generation may consume allowed local-only source, but the stored node inherits `local-only`. A later switch to a remote provider replaces that complete summary before serialization. Old summaries generated while privacy was disabled cannot be retroactively classified if the model removed source markers; rebuild preserves, but cannot invent, that metadata.

Pi 0.84.3 locates the post-compaction entry by summary text, which can surface an older entry when deterministic test summaries are identical. DS4 therefore correlates commit with its pending summary ID and resolves the matching newly appended entry from `SessionManager`, never by text equality.

## Dedicated compaction model and thinking

By default the active session model generates summaries, exactly as in previous releases. A dedicated model can be opted into:

```json
{
  "compaction": {
    "model": { "provider": "anthropic", "id": "claude-sonnet-4-5" },
    "summary": { "thinking": "medium" }
  }
}
```

Semantics:

- when `compaction.model` is absent, the active session model is used for budget, segmentation, requests, and record provenance;
- when present, the model is resolved once per compaction through the model registry and used uniformly for input budget, segmentation, sanitization, segment/aggregate requests, and `provider`/`model` provenance in summary records;
- the dedicated model must exist, be configured with auth, and accept text input; otherwise DS4 logs a warning and falls back to the session model — compaction is never blocked by configuration;
- `compaction.summary.thinking` defaults to `off` and applies only to summary requests: `off` keeps the pre-existing request shape (no thinking fields), while other levels map per API (`thinkingEnabled`/`effort` for `anthropic-messages`, `samplingParams.reasoning_effort` for OpenAI-compatible APIs) and are ignored for unsupported providers;
- `context.maxSummaryTokens` remains a session-level limit and does not rise for the dedicated model; the minimum with the model's `maxTokens` still applies.

## Latency controls

The current defaults favor bounded request size while retaining direct updates and bounded parallelism:

```json
{
  "compaction": {
    "directUpdate": true,
    "inputBudget": "context",
    "segmentTargetTokens": 30000,
    "maxRequestInputTokens": 64000,
    "maxOperationInputTokens": 2000000,
    "maxConcurrentSegments": 2
  }
}
```

`segmentTargetTokens` is the soft partition target for source segments. `maxRequestInputTokens` is the hard estimated-input cap applied to every direct-update, segment, aggregate, and retry attempt; the effective request limit is the minimum of this value and the safe model input budget. An indivisible message or complete tool exchange above that limit fails closed to Pi's native compaction rather than creating an oversized DS4 request.

`maxOperationInputTokens` bounds the sum of estimated prompt tokens reserved immediately before all provider attempts in one DS4 compaction, including transport retries and concurrently scheduled segments. Exceeding it aborts remaining DS4 work and falls back without committing a partial summary graph. Defaults are 64,000 per request and 2,000,000 per operation; both must be positive integers, and the operation limit must be at least the configured request limit.

- `directUpdate`: one validated previous-summary plus new-source request when the entire prompt fits the effective request input limit. Set false to always retain the segment-then-aggregate route. Validation or provider failures still fall back to Pi, not an unvalidated update.
- `inputBudget`: `context` (default) uses the ordinary context fill target (`activeInputBudget`). `summary` is an explicit throughput-oriented opt-in that permits the calibrated `hardInputLimit`. Both are additionally capped by `(context window - safety margin - actual summary output cap) / calibration ratio`, rounded down, and never exceed the configured/model hard limit. Existing output reservations remain conservative; ordinary session planning and proactive thresholds are unchanged. The conservative default reduces request-size peaks but can produce more segments and calls; it is not a guarantee of provider fit or lower total token use.
- `maxConcurrentSegments`: integer **1–2**, default 2. Only independent segments overlap, including their retries. Aggregates do not run until their children have completed. Use 1 for sequential execution or providers with restrictive concurrent-request limits. Rate-limit failures are not transport-retried.

For an old sequential-path comparison set `directUpdate=false`, `inputBudget=context`, `maxConcurrentSegments=1`. To reproduce the `0.3.5` throughput-oriented budget, set `inputBudget=summary`. All features remain behind the existing compaction/master switches. Settings are applied on session load; after upgrading the package or rebuilding a development checkout, fully restart Pi to avoid stale compiled-core modules. No schema migration is required.

Mock-provider regression tests verify fewer calls, bounded overlap, exact budget boundaries, validation, privacy, immutable provenance and JSONL rebuild. They do **not** establish real-provider wall-time gains, semantic equivalence of generated summaries, or a guaranteed completion time. See [ADR-061](ADR/061-compaction-latency.md).

## Transport retry policy

Summary requests are replayed only for transport-classified failures (thrown transport errors or `stopReason: "error"` responses whose message matches network/timeout patterns). The DS4 replay policy uses **four total attempts** (the initial call plus up to three retries), matching Pi's standard retry count, and can be tuned per deployment:

```json
{
  "compaction": {
    "transport": {
      "maxAttempts": 4,
      "baseDelayMs": 2000
    }
  }
}
```

- `compaction.transport.maxAttempts`: total attempts per direct update, segment or aggregate call, integer 1–10, default 4. With 1, no transport failure is retried.
- `compaction.transport.baseDelayMs`: base backoff before the first replay, integer 0–60000, default 2000. The delay doubles per attempt (2000, 4000, 8000, …) and is capped at 60 s.
- Replays use a fresh routing session per attempt; diagnostics expose only stage, failed/next attempt, max attempts, and delay.
- Aborts (including during backoff) never trigger replay; non-transport failures are never retried; usage is summed across replayed responses.

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

The preview reports thresholds and eligibility; Pi remains authoritative for the exact cut point. Runtime diagnostics additionally report the effective provider/model, chosen path (`direct-update` or `hierarchical`), budget mode, calibrated input budget, estimated new-source and full-update prompt sizes, logical summary calls (excluding retries), generated segment count, aggregate-call count, concurrency cap, and completed transport-retry count without source content. Monotonic wall timings cover preparation, generation (direct or parallel segments, including validation and retries), aggregation, graph preparation/persistence, and total DS4 hook time. Parallel generation time is elapsed wall time, not a sum of overlapping requests. Total time excludes Pi's subsequent canonical append or native fallback. Timings survive the in-process commit/fallback notification, but are not persisted in JSONL or reconstructed as fake durations after restart. Metadata-only `compaction.timings` is emitted at `debug` for successful and failed attempts. Failed validation additionally embeds the class-only `unsupportedSpanClasses` report in the `compaction.custom_fallback` warning, so a failing compaction can be diagnosed from logs alone without reproducing the session or reading its content. Each retry emits only stage, failed/next attempt, maximum attempts, and delay at `debug`. Routine `summary_graph_prepared` and `summary_graph_committed` lifecycle events are also emitted only at `debug`; fallback, failure, persistence, and reconciliation problems remain actionable warnings. Oversized-group and bounded-operation errors expose only numeric budgets/counts, never rejected source text. Provider failures are reduced to metadata-only categories such as `input-limit`, `usage-limit`, `rate-limit`, `authentication`, or `transport`; raw provider error details are not logged or shown. The proactive-threshold TUI notification remains a user-visible `info` notice because it explains why an automatic compaction started.
