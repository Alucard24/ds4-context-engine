# ADR-070 — Bounded incomplete-stream retry and safe compaction failure metadata

Status: accepted.

## Context

A reported 0.4.9 compaction spent 2.48 seconds preparing and 141.15 seconds generating segments, then fell back before aggregation with `category=provider-error`. That category did not distinguish an SDK/protocol failure from a provider response. The report alone does not identify its cause.

Pi's SDK raises `Stream ended without finish_reason` when a stream closes without its required terminator. DS4 previously classified that exact message as an unclassified provider error and did not apply its existing transport retry policy. Diagnostics also labelled planned segments as generated, and Pi's native fallback notification could replace the original proactive trigger with `manual`.

## Decision

- Classify that exact SDK message as `transport / stream-incomplete`, whether thrown or returned in an error response. Use the existing configurable attempt limit, backoff, fresh routing-session ID, cooperative cancellation, usage accounting and pre-dispatch operation-input budget. Change none of their defaults or limits.
- Introduce an adapter-local typed error whose public data contains only stage, allowlisted category/reason, attempts/max attempts and optional validated numeric HTTP status. Extract no bodies, headers, arbitrary provider codes or raw finish reasons into diagnostics, and attach no raw exception cause.
- Recognized HTTP client/server failures cannot become transport retries merely because the body contains transport words. HTTP 5xx, content filters, unknown finish reasons and unclassified failures have no blanket replay policy. Existing input, rate, usage, authentication, validation and output-limit fail-closed behavior remains.
- Keep `segmentCount` as the planned count for compatibility. Add `completedSegmentCount`, incremented only after successful segment generation through the validation pipeline. Display both accurately; neither means the graph was persisted.
- Preserve the original custom-attempt trigger and safe provider-failure metadata across Pi fallback, and reset counters/failure metadata for each new custom attempt.

## Consequences and validation scope

Retrying an interrupted stream can incur another billed request even if the earlier request produced partial output. The existing attempt and operation-input bounds still apply, and failure/cancellation still drains started workers before Pi fallback. No partial summary graph is installed.

Regression tests reproduce the prior missing-terminator failure before the fix. Synthetic tests cover both SDK failure shapes, bounded retries, cancellation during backoff, fresh routing sessions, usage accounting, operation-input exhaustion, non-retryable HTTP/finish-reason failures, metadata privacy, partial completed counts, counter reset, proactive trigger preservation and extension command output after native fallback.

These tests do not identify the reported host's provider error, establish real-provider speed or semantic quality, or satisfy the separate real-context BPE/auto-tuning objective. No live provider calls are authorized by this decision.
