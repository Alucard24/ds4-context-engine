# 065 — Accept canonical JSON-escaped exact values in compaction summary validation

**Date:** 2026-09-27
**Status:** Accepted
**Related:** [061](061-compaction-latency.md)

## Context

Every compaction summary is validated against the segment evidence: a backticked
exact value is accepted only when it occurs literally in the sanitized segment
source, in the ordered child-summary content, or in Pi's file-operation
inventory. Production sessions on separate hosts failed closed with
`compaction.custom_fallback`, `unsupported-exact-value`,
`repair=too-many-bullets` and observed counts of 30/20, 23/19, 19/15 and 17/11
unsupported spans and affected bullets, so each run fell back to Pi default
compaction unmodified.

The class-only report added in 0.4.2, made interpretable in 0.4.3, attributed
the next observed run (16 spans across 12 bullets): `escaped-form-present` 11,
`not-classified-partial` 4, `not-classified-length` 1, and no `no-near-miss`
entry. Shapes (`quote` 11, `colon` 11, `json-punctuation` 9, no `backslash`) and
the absence of escapes inside the rejected spans show decoded values, not
identifiers: the summarizer quoted the readable value while the evidence holds
its JSON-encoded rendering. The prompt rule added in 0.4.1 could not address
that, and it should not have to: decoding JSON escapes while quoting a value is
a reasonable rendering choice, not a fabrication.

## Decision

`unsupportedExactMatches` accepts a backticked value when it occurs literally in
the evidence, either as written or in its canonical JSON-escaped rendering
(`jsonEscaped`, the same transform the diagnostics classifier uses for
`escaped-form-present`). The rule is unconditional and adds no configuration
key. The reverse direction is deliberately not accepted: an escaped span whose
raw form is present stays unsupported and is still reported as
`unescaped-form-present`.

Canonical JSON escaping is injective and reversible, so a decoded value can only
pass when its encoded text is literally present in the evidence. The decision
widens the accepted rendering, never the evidence: invented values, spans
assembled from separately present parts, single-character variants, the
eight-bullet and 25% repair bounds and the fail-closed fallback are unchanged.

## Consequences

- A span whose evidence is stored JSON-encoded now validates, and its bullet
  survives instead of being pruned or forcing the bounded repair.
- `escaped-form-present` becomes unreachable in practice: validation and the
  classifier share the predicate, so such spans no longer reach the classifier.
  The class stays in the taxonomy for compatibility, and new reports are not
  expected to contain it.
- The classifier's shared probe budget rises from 4000 to 24000 evidence-source
  scans, so a report after this change can finish the near-miss analysis for the
  spans that remain unsupported.
- No SQLite migration, schema change, canonical JSONL change, privacy consent
  change, provider-facing default change or new configuration key.
