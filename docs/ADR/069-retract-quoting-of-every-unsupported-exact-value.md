# 069 — Retract the quoting of every unsupported exact value instead of failing the compaction

**Date:** 2026-09-28
**Status:** Accepted; structural-fallback policy superseded by [ADR 072](072-deterministic-summary-structure.md).
**Related:** [065](065-exact-value-escaped-equivalence.md), [066](066-quoting-downgrade-and-span-adjacency.md), [068](068-downgrade-rendering-equivalent-spans.md)

## Context

Six coordinated releases (0.4.1–0.4.7) reduced, but never removed, the recurrent
`compaction.custom_fallback` with `unsupported-exact-value;
repair=too-many-bullets`. The affected-bullet series from production was 30/20 →
23/19 → 19/15 → 17/11 → 16/12, and the report that closed the case carried 25
spans across 15 bullets.

That report shows why the class-by-class repair cannot converge:

| Relation | Count |
| --- | --- |
| `composed-two-present-parts` | 11 |
| `not-classified-partial` | 5 |
| `not-classified-length` | 4 |
| `composed-adjacent-present` | 3 |
| `no-near-miss` | 2 |

`spansClassifiedCheap` was 0: not one span was a rendering variant of contiguous
evidence, so the escape path was exhausted. The 0.4.7 repair could retract the
quoting of at most the three adjacent spans; the remaining 22 spans kept the
bullet-removal path, and 15 − 3 = 12 bullets still exceeded the eight-bullet
bound. On that input 0.4.7 would have fallen back by construction.

The classes are not a finite list of odd renderings to eliminate one release at a
time. They are one behaviour: the summarizer composes and paraphrases spans. The
validator cannot accept `composed-two-present-parts` — that association is
precisely what the evidence does not contain — and no rendering normalization
turns a composed span into a contiguous excerpt.

## Decision

- Validation is unchanged. A backticked value that the evidence does not hold
  literally, or as its canonical JSON-escaped rendering, is still invalid.
- The repair retracts the two backticks of **every** unsupported span in place,
  keeps the text, and the repaired summary is re-validated. No bullet is deleted
  for an exact-value failure, so the eight-bullet and 25% removal bounds no
  longer apply to this path.
- The repair no longer consults the span classification. The class-only report
  stays as diagnostics and is still attached to the fallback warning, which now
  fires only for structural, transport or budget failures.
- Fallback remains for missing, duplicate or empty sections, unsupported file
  paths, unknown sections or headings, malformed content, transport and budget
  failures, and any summary that is still invalid after the retraction
  (`post-downgrade-invalid`).
- Outcomes are counters, never span text: `unsupported-exact-spans-unquoted`
  records the retracted spans, and `unsupported-exact-bullets-pruned` no longer
  exists.

## Consequences

- The dominant production failure mode cannot fail the compaction any more. The
  fact stays as prose, the exactness claim goes, and every value that remains
  backticked is still verified literally or as its canonical JSON-escaped
  rendering. This supersedes the exclusion list of
  [ADR 068](068-downgrade-rendering-equivalent-spans.md).
- The trade is explicit: a value the evidence does not carry — including an
  invented one — is no longer deleted, and the eight-bullet and 25% bounds no
  longer protect it. Losing a fact, or losing the whole DS4 compaction to Pi's
  default, was judged worse; the fallback this replaces does not check exact
  values at all.
- An unsupported value remains visible in the summary as prose and in the
  recorded counter, so the operator can review it instead of relying on the
  bullet removal.
- The public core repair API changes: `analyzeUnsupportedExactValueDowngrade`
  and `downgradeUnsupportedExactValues` replace
  `analyzeUnsupportedExactValueBullets` and `pruneUnsupportedExactValueBullets`,
  and `ExactValueDowngradeResult`/`ExactValueDowngradeAttempt` replace the
  `ExactValuePrune*` types. The engine/core compatibility guard turns a mixed
  artifact pair into one actionable line instead of a missing function.
- No configuration key, no SQLite migration, no schema change, and no
  provider-facing default change.
