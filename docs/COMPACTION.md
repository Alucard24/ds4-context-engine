# Custom Compaction

DS4 intercepts Pi's `session_before_compact` event but preserves Pi's cut-point calculation. Raw JSONL history is never deleted or rewritten.

## Flow

1. Pi determines `messagesToSummarize`, optional split-turn prefix, and `firstKeptEntryId`.
2. DS4 maps every source message by exact fingerprint to a canonical branch entry ID.
3. Pi's serializer converts the newly discarded span to bounded conversation text; enabled privacy policy sanitizes conversation, custom instructions, and file paths for the active provider.
4. DS4 estimates the complete sanitized summary request against the calibrated active-model input budget. If the whole request does not fit, it partitions the source into ordered contiguous segments. Individual messages are indivisible, and every tool call remains in the same atomic group as all matching results; an exceptionally large turn may split only between such groups.
5. The active model generates and validates each immutable segment summary only against that segment's sanitized evidence, with cache retention disabled and a fresh routing session ID per call. Only failures categorized as `transport` are retried: at most two retries follow bounded 200 ms and 500 ms delays, each with another fresh routing session ID. The delay and the next call both honor Pi's abort signal; all other failure categories fall back immediately.
6. DS4 recursively aggregates ordered child summaries in bounded fan-in calls until one root remains. The ordered roots include the previous branch summary, when present, followed by every new segment. DS4-generated IDs, hashes, kinds, and graph levels remain outside model-visible evidence. A Pi-native predecessor is imported as an explicitly unverified branch node.
7. The highest input classification is wrapped around each generated node, then all nodes are persisted atomically as one `prepared` graph batch. Usage is summed across every segment and aggregate request; Pi receives only the final root text and still appends exactly one canonical `CompactionEntry` with `fromHook: true`.
8. `session_compact` commits all nodes and associates the active root with the Pi entry; failure marks the complete prepared batch `failed`.

Fan-out and fan-in are bounded to 32 segment requests, 64 aggregate requests, and 16 aggregate passes. Transport replay mirrors Pi's assistant retry policy: `compaction.transport.maxAttempts` (default 3) total attempts and `compaction.transport.baseDelayMs` (default 2000 ms, capped at 60 s) backoff, doubling per attempt, abort-aware. Replay never applies to input, usage, rate, authentication, validation, or output-limit failures. A base prompt, individual message, atomic tool exchange, pair of child summaries, or total operation that cannot fit within those limits fails closed. Any mapping, budget, model, output-limit, validation, abort, or storage error returns `undefined` from the hook, allowing Pi's default compaction to run.

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

Every section must occur once, in order, and contain content or `- None`. DS4 replaces each unique `Files Read` and `Files Modified` section with one exact path per bullet from Pi's sanitized file-operation inventory before validation; missing or duplicate sections still fail. Backticked exact values must occur in the serialized segment source, ordered child-summary content, or those known file-operation paths. A bounded unsupported exact-value bullet is removed as a whole and recorded as a validation warning; unsupported prose, more than eight affected bullets, or removal above 25% still fails closed to Pi. The prompt explicitly asks the model to omit a bullet whose complete backticked span cannot be copied verbatim. Every segment is validated independently against only its own sanitized source and deterministic file inventory. Every aggregate is validated independently against only the sanitized content of its ordered children and cumulative deterministic file inventory. Any unrepaired failure prevents the whole graph batch from being installed.

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

## Transport retry policy

Summary requests are replayed only for transport-classified failures (thrown transport errors or `stopReason: "error"` responses whose message matches network/timeout patterns). The replay policy defaults to Pi's assistant retry policy and can be tuned per deployment:

```json
{
  "compaction": {
    "transport": {
      "maxAttempts": 3,
      "baseDelayMs": 2000
    }
  }
}
```

- `compaction.transport.maxAttempts`: total attempts per segment or aggregate call, integer 1–10, default 3. With 1, no transport failure is retried.
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

The preview reports thresholds and eligibility; Pi remains authoritative for the exact cut point. Runtime diagnostics additionally report the calibrated input budget, estimated whole-source prompt size, generated segment count, aggregate-call count, and completed transport-retry count without source content. Each retry emits only stage, failed/next attempt, maximum attempts, and delay at `debug`. Routine `summary_graph_prepared` and `summary_graph_committed` lifecycle events are also emitted only at `debug`; fallback, failure, persistence, and reconciliation problems remain actionable warnings. Oversized-group and bounded-operation errors expose only numeric budgets/counts, never rejected source text. Provider failures are reduced to metadata-only categories such as `input-limit`, `usage-limit`, `rate-limit`, `authentication`, or `transport`; raw provider error details are not logged or shown. The proactive-threshold TUI notification remains a user-visible `info` notice because it explains why an automatic compaction started.
