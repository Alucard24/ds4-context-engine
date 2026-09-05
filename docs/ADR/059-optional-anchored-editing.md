# ADR 059 — Optional execution-time anchored editing

Status: Accepted

## Context

DS4's standalone agent supports `head[upto]tail` replacement and an optional
inference-time marker forcer. The former is portable tool semantics; the latter
requires backend control over generation state. Pi already provides batch edits,
mutation serialization, normalization, cancellation and diff feedback.

## Decision

- Add the default-off `editing.anchored` configuration key, gated by the DS4 master
  switch and loaded through existing trusted configuration handling.
- Register a same-name `edit` override only when enabled and native edit is not
  already replaced. Do not introduce an additional tool or force tool activation.
- Support one marker between nonempty, non-whitespace exact anchors, inclusive
  replacement and suffix-only tail uniqueness. Add per-edit `literal: true` to
  escape real marker text. Preserve native edit behavior without marker syntax.
- Expand anchors using private copies inside native `EditOperations.readFile`,
  under Pi's own mutation queue, then delegate batch validation and writing to
  `createEditToolDefinition`. Do not copy Pi's editing implementation or expand in
  an unqueued `tool_call` hook.
- Require exact matching for all edits in a batch containing anchors: native
  fuzzy fallback changes the whole batch's coordinate space and can relocate an
  exact anchored span. Marker-free calls retain native fuzzy behavior.
- Keep native normalized ambiguity checks, even when stricter than exact anchor
  validation. Invalid anchored edits fail closed, without a fallback to a broader
  match. ADR 008's context-planning fallback is not permission to guess file edits.
- Preserve native diff results and append compact original-line range metadata.
  Skip marker-unaware native previews until the actual result diff is available.
- Restore the native definition if the same extension instance later loads
  disabled configuration; a fresh disabled load registers no editing override.

## Consequences

No provider change, Pi fork or dependency upgrade is required for execution-time
anchors. Only the configuration shape enters the portable core; filesystem/tool
integration stays in the Pi extension. Existing configuration defaults otherwise
remain unchanged, and the additive compatibility golden is updated.

The adapter relies on native edit reading through the supplied operations before
matching the provided edit array, while holding its shared queue. Tests against
Pi 0.84.3 pin that ordering and cancellation behavior. Dependency upgrades must
re-run these contracts. Other edit overrides, external editors/processes, atomic
writes and backend generation-state control remain outside the guarantee.

See [usage and limitations](../ANCHORED_EDITING.md). No automatic marker forcer,
constrained grammar, live configuration activation or measured provider savings
are part of this decision.
