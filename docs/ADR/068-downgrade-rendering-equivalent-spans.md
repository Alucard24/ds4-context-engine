# 068 — Downgrade rendering-equivalent spans instead of spending the bullet budget

**Date:** 2026-09-27
**Status:** Accepted
**Related:** [065](065-exact-value-escaped-equivalence.md), [066](066-quoting-downgrade-and-span-adjacency.md), [067](067-core-version-guard.md)

## Context

Five coordinated releases reduced, but never removed, the recurrent
`compaction.custom_fallback` with `unsupported-exact-value;
repair=too-many-bullets`. The affected-bullet series from production was 30/20 →
23/19 → 19/15 → 17/11 → 16/12, and the class-only reports attributed the majority
of the rejected spans to rendering or composition, never to invention:
`escaped-form-present` 11 of 16 in the first interpretable run, then composition
9 of 14 with 2 one-character deviations, 2 absences and 1 over-length span in the
next.

Each patch removed one class — escaped equivalence in 0.4.4, prompt grading in
0.4.5 — while the bound stayed exhausted by the remaining ones. The repair was
treating a *re-rendered* value exactly like an *invented* one: it deleted whole
bullets, and beyond eight bullets it refused to repair at all and handed the
session to Pi. The information in those spans is present in the evidence; only
the verbatim surface form is not. Discarding a supported fact, or failing, is the
wrong response to a rendering difference.

## Decision

- Validation is unchanged. A backticked value is still accepted only when it
  occurs literally in the evidence or as its canonical JSON-escaped rendering.
  Nothing that was rejected before becomes an accepted exact value.
- The bounded repair splits the rejected spans into two groups.
  - **Rendering-equivalent** — `escaped-form-present`, `unescaped-form-present`,
    `whitespace-collapsed-present`, `typographic-variant-present`,
    `composed-adjacent-present`: DS4 removes only the two backticks. The text
    stays, the fact stays, the exact-value claim is retracted, and the result is
    re-validated. This applies deterministically the ladder the 0.4.5 prompt asks
    the model to follow, instead of depending on the model complying.
  - **Everything else** — `single-deletion-present`,
    `composed-two-present-parts`, `case-variant-present`, `no-near-miss` and
    every `not-classified-*`: the existing fail-closed treatment, whole-bullet
    removal within the eight-bullet and 25% bounds, otherwise fallback to Pi.
- The excluded relations are excluded because prose would hide a wrong claim
  rather than a re-rendered one: a case change can alter an identifier, a
  one-character deviation is indistinguishable from a wrong value, and
  `composed-two-present-parts` is precisely the association the evidence does not
  contain ([ADR 066](066-quoting-downgrade-and-span-adjacency.md)).
  `not-classified-*` means *not analysed*, which is not evidence of support, so
  those spans stay fail-closed as well.
- The eight-bullet and 25% bounds are not raised. They now count only the bullets
  that still need removal, because a downgraded span costs no bullet.
- Both effects are recorded as counters, never as span text:
  `unsupported-exact-bullets-pruned` for removed bullets and
  `unsupported-exact-spans-unquoted` for downgraded spans.

## Consequences

- The dominant production failure mode no longer consumes the bullet bound. In
  the core fixtures, twelve affected bullets now downgrade to plain text and
  validate, where the same input previously answered `too-many-bullets`; the
  integration fixture with eleven affected bullets completes with
  `validationStatus: "warning"` instead of Pi compacting the session.
- Fail-closed survives where it matters. An invented value keeps the
  bullet-removal path, and the same eleven-bullet fixture still answers
  `repair=too-many-bullets` when the evidence holds the two parts at unrelated
  positions rather than next to each other.
- The repair now consumes the class analysis, which is bounded and deterministic
  but budget-limited (default 24000 evidence-source scans). A span left
  unanalysed is never downgraded.
- A downgraded value is still *stated* as prose: DS4 stops asserting exactness it
  cannot verify, but it does not delete the fact. That is the deliberate trade —
  a fact with a possibly imperfect surface form beats losing the fact or losing
  the whole compaction — and it is visible in the recorded counters.
- The `UnsupportedSpanClassReport` documentation no longer claims the relations
  are observation-only: they now select the repair treatment. Validation still
  never consults them.
