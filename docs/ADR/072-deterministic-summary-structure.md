# 072 — DS4 owns the final compaction-summary structure

**Date:** 2026-10-01
**Status:** Accepted
**Related:** [069](069-retract-quoting-of-every-unsupported-exact-value.md), [070](070-compaction-provider-failure-metadata.md)
**Supersedes:** ADR 069's fallback policy for repairable structural errors.

## Context

A production aggregate failed with `missing-section, unsupported-exact-value`.
The exact-value repair ran only when every validation error was an unsupported
exact value, so a single omitted heading prevented that repair altogether.
Stronger prompting cannot guarantee a complete Markdown contract. Retrying a
model to fix formatting adds cost without making the result deterministic.

The user explicitly approved deterministic structural normalization on
2026-10-01. This is a deliberate change from ADR 069, not a relaxation of the
validator or an increase of repair limits.

## Decision

- DS4 constructs the twelve canonical level-2 sections, once each, in contract
  order, before validating every segment, aggregate, or update.
- Recognizable section headings are normalized and duplicate section bodies
  are concatenated in encounter order. Unknown headings and unsectioned text
  remain as non-authoritative notes in Current State; they are not discarded
  or promoted into decisions, constraints, or completion claims.
- The semantic body text is retained. Markdown heading syntax is demoted when
  necessary; it is not allowed to create an extra contract section. File
  inventories remain the existing exception: they are regenerated exclusively
  from sanitized known-file evidence, never from model-reported file lists.
- An omitted or empty semantic section receives an explicit reporting-omission
  marker, never `- None`. The marker does not establish absence of facts.
  Existing model-reported `- None` is retained as supplied.
- Repairs are visible as warning codes and numeric counts. Diagnostic messages
  do not contain generated headings, paths, spans, or response bodies.
- Exact-value quote retraction is independent of other validation errors. The
  repaired candidate is always re-validated. Every surviving backticked value
  must still be supported literally or by canonical JSON-escaped evidence.
- No provider repair requests are added. The prompt still requests the complete
  contract, but DS4, rather than probabilistic instruction following, owns the
  final envelope.
- Empty responses, tool calls, unsafe file evidence, incomplete transport,
  output limits, cancellation, operational budgets, and storage failures still
  fail closed to Pi. The validator and its error severities remain unchanged.

## Consequences and limitations

Repairable Markdown errors no longer require Pi fallback, including a format
error combined with unsupported exact values. This does not promise that every
compaction can succeed: external failures and bounded-operation failures remain.

Normalization preserves what the model reported; it cannot recover facts that
were never reported. Omission markers and warning codes make that limitation
explicit. Unrecognized section titles are kept as notes rather than guessed
into a semantic category. A valid, canonically structured summary needs no
structural warning. The summary contract version and default tokenizer,
auto-tuning, transport retry, and privacy policies are unchanged.

Tests must cover combined structural/exact-value failures, all request stages,
missing and empty sections, duplicate/order/heading errors, unsectioned content,
content preservation, canonical inventories, idempotence, unchanged rejection
of empty responses and unsafe evidence, and the aggregate coordinator path.
No live provider verification is implied by those local regression tests.
