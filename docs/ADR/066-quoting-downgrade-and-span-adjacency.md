# 066 — Grade the summarizer quoting fallback and separate adjacent from unrelated span composition

**Date:** 2026-09-27
**Status:** Accepted
**Related:** [061](061-compaction-latency.md), [065](065-exact-value-escaped-equivalence.md)

## Context

Compaction summary validation is fail-closed: a backticked exact value must occur
literally in the evidence, and a bounded repair removes at most eight whole
affected bullets. Production sessions kept failing closed with
`compaction.custom_fallback`, `unsupported-exact-value`, `repair=too-many-bullets`
and 30/20, 23/19, 19/15, 17/11, then 16/12 unsupported spans and affected
bullets.

The class-only report (§ 0.4.2–0.4.3) made the next observed run interpretable,
and ADR 065 removed 11 of its 16 spans as JSON-escape renderings. The production
report produced by 0.4.4 — 14 spans across 14 bullets, `spansClassifiedCheap: 0`,
`probesUsed: 11671` of 24000, `classificationComplete: true` — closed the
remaining attribution:

| Relation | Count |
| --- | --- |
| `composed-two-present-parts` | 9 |
| `no-near-miss` | 2 |
| `single-deletion-present` | 2 |
| `not-classified-length` | 1 |

No rendering class remained, so the escape path was exhausted; the dominant
residual cause is span composition, which is exactly what the 0.4.1 prompt rule
forbids. That rule is present in the prompt that produced the report and the
model still composes, which is why another repetition of the prohibition was not
the fix.

Composition mixes two situations that need opposite treatments. When the two
parts sit next to each other in one source, the span is a re-rendering of a
contiguous evidence region — the same shape of problem ADR 065 solved for
escapes. When the parts are found at unrelated positions, the span is an
association the evidence never contains, and accepting it would let a
plausible-looking but false pairing (`path: wrong-range`) through validation.

The prompt offered the model exactly one escape hatch from composing: omit the
whole bullet. Discarding a fact is expensive, so composing was the cheaper
choice. The instrumented evidence cannot by itself tell which composition kind
occurs, because the classifier only established that both parts are present
somewhere.

## Decision

1. The summarizer prompt keeps the prohibition but replaces the single drastic
   fallback with a graded ladder: backtick only the fragments that are themselves
   contiguous, with the joining text outside the backticks; if no fragment is
   contiguous on its own, write the value as ordinary text without backticks and
   keep the bullet; omit the bullet only when the fact itself has no support in
   the evidence.
2. Diagnostics split the composition class: `composed-adjacent-present` when one
   corpus source holds the two parts with nothing but joining punctuation and
   spaces between them (at most the span's own separator length plus two
   characters, and no letters, digits or line breaks), and
   `composed-two-present-parts` otherwise. Both are class-only, bounded, and
   observation-only.
3. The eight-bullet repair bound and the 25% removal bound are unchanged. A
   larger unsupported set still fails closed to Pi default compaction: pruning
   more of a summary than the operator accepts is not a fallback remedy.

## Consequences

- The ladder can reduce the number of backticked exact values in a summary. That
  is a change in what the model chooses to quote, not in what validation accepts:
  the contract, the repair bounds and the fail-closed decision are untouched.
- The effect on the observed fallback is not verified by this change. The next
  production report decides whether composition persists, and the new adjacency
  class says whether a rendering-normalization rule on the ADR 065 pattern is
  even possible: `composed-adjacent-present` is the only class for which it could
  be safe, while `composed-two-present-parts` must never be accepted.
- No configuration key, no SQLite migration, no schema change, and no
  provider-facing default change.
