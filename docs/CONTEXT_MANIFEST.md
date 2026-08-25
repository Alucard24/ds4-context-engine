# Context Manifest

A Context Manifest explains the context visible at DS4's Pi `context` hook without persisting the prompt itself.

## Captured per model call

- session and active leaf IDs;
- provider, model, context window, output reserve, hard limit, and target;
- estimated system-prompt, active-tool-schema, and message tokens;
- included item kind, source entry ID, atomic group ID, classification, score, token cost, and reason;
- current-branch entries omitted by Pi compaction or metadata rules;
- active compaction/branch-summary source IDs;
- selected historical entry IDs and `retrieval` items with score, token cost, match reason, and synthetic-boundary provenance;
- selected `project` snippet IDs, relative paths, SHA-256 hashes, line ranges, scores, modified flags, and indexed Git commits;
- project root/repository revision metadata: branch, HEAD, dirty state, bounded changed paths, and index time;
- selected pin IDs/scopes/branch leaf/source entry/file plus token cost and reason;
- selected memory IDs/scopes/normalized keys/origin session/source entries plus score, token cost, and reason;
- artifact IDs, SHA-256, bytes, MIME, classification, exact source entry/tool IDs, error state, and before/after token estimates;
- provider destination and allow-set names, selected classification counts, blocked/excluded/redacted counts, final provider-check count, and enforcement stage;
- planner mode/version, original and selected counts, group counts, internal budgets, duration, and fallback reason;
- planner and policy versions;
- deterministic SHA-256 over system prompt, active tools, and messages;
- Pi's reported context usage when available.

The manifest does **not** contain system instructions, message text, classified spans, pin content, memory claims, project snippets, artifact content/excerpts, tool arguments/results, image data, provider payloads, API keys, or headers.

## Provenance mapping

DS4 projects Pi's `buildContextEntries()` through Pi's own `sessionEntryToContextMessages()` and fingerprints the resulting messages. Exact fingerprints map directly to source entry IDs. If an earlier extension transformed a message, DS4 may fall back to role/order mapping and records that weaker reason explicitly. Extension-injected transient messages remain source-less. DS4 pin, memory, historical, and project messages are exceptions: the planner supplies explicit canonical record/entry/snippet source IDs, and source mapping skips role/order fallback for those indices so they cannot steal provenance from the current user message.

The manifest initially reflects the selected privacy-sanitized context at DS4's position in Pi's ordered extension chain. `before_provider_request` updates privacy counters after provider-specific rendering without storing the payload. Extensions loaded after DS4 may still transform messages or payloads; load DS4 last for strict final enforcement. Planner/privacy-excluded messages retain source ID, classification, and reason in `excluded`.

## Actual usage calibration

The `message_end` event for the corresponding assistant response supplies provider usage. DS4 records:

```text
actualInputTokens = input + cacheRead + cacheWrite
```

Error, aborted, missing, or zero-usage responses do not create calibration samples. Every manifest is correlated with at most one assistant response.

## Reproducibility

Object keys are normalized before hashing, so equivalent tool schemas with different key insertion order produce the same prompt hash. The estimator version is represented by the planner version. Golden tests protect manifest shape, token accounting, and hash stability.

Use:

```text
/context manifest
/context explain
/context included
/context excluded
/context tokens
/context retrieved
/context project
/context pins
/context memory
/context privacy
/context artifacts
```
