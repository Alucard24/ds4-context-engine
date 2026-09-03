# Context Persistence Tool

`context_persistence` is DS4's bounded model-callable interface for inspecting and explicitly updating Persistent Pins, Durable Memory, and cross-session project-memory source policy. It is available in the Pi adapter only; the portable core and reference adapter do not expose this Pi-specific tool.

Contract identifiers:

```text
tool:   ds4-context-persistence-tool-v1
result: ds4-context-persistence-result-v1
```

The tool declares `executionMode: "sequential"`. This orders sibling calls from one model response; SQLite writes still use the shared coordinator and every targeted mutation still checks its revision.

## Pins and Memory

Pins are confirmed constraints or instructions that should remain prominent. They may use `session`, `branch`, or trusted `project` scope. Branch Pins can remain lifecycle-active while not applying to the active branch.

Memory is quoted durable factual, decision, or historical data. It supports `session` and trusted `project` scope, never `branch` scope. DS4 does not automatically extract either concept from ordinary conversation.

## Actions

| Action | Class | Parameters | Purpose |
| --- | --- | --- | --- |
| `pins_list` | read | optional `activeOnly`, `maxResults` | List visible Pins with metadata and revisions |
| `pins_find` | read | `query`; optional `activeOnly`, `maxResults` | Bounded Pin search with sanitized previews |
| `pin_add` | canonical write | `content`; optional `scope`, `classification` | Append a new Pin |
| `pin_supersede` | canonical write | `id`, `targetRevision`, `content`; optional `classification` | Replace one exact active Pin immutably |
| `pin_unpin` | canonical write | `id`, `targetRevision`; optional `reason` | Append a deleted lifecycle status |
| `memory_list` | read | optional `activeOnly`, `maxResults` | List visible Memory with metadata and revisions |
| `memory_find` | read | `query`; optional `activeOnly`, `maxResults` | Bounded Memory search with sanitized previews |
| `memory_add` | canonical write | `content`; optional `scope`, `key`, `classification` | Append session/project Memory |
| `memory_supersede` | canonical write | `id`, `targetRevision`, `content`; optional `classification` | Replace one exact active Memory item immutably |
| `memory_invalidate` | canonical write | `id`, `targetRevision`; optional `reason` | Append an invalid lifecycle status |
| `memory_expire` | canonical write | `id`, `targetRevision`; optional `reason` | Append an expired lifecycle status |
| `memory_sources` | read | optional `maxResults` | List cross-session sources through volatile references |
| `memory_source_exclude` | derived write | `id`, `targetRevision`; optional `reason` | Exclude one source in local SQLite policy |
| `memory_source_include` | derived write | `id`, `targetRevision` | Restore one source in local SQLite policy |

The transport schema stays flat for compatibility across supported providers, but DS4 applies the parameter matrix above before runtime access. A known action with an inapplicable field returns `unsupported-parameter`; a known action missing an action-required field returns `missing-required-parameter`. These diagnostics never identify or echo fields or values. Malformed transport input retains the generic `invalid-parameters` category. The output-only egress sentinel is checked before action-specific categorization so it remains `egress-placeholder` even when supplied in an inapplicable field.

Read results are keyset-bounded and metadata-only. List results never include Pin content, Memory claims, keys, paths, source session IDs, reasons, complete errors, or totals requiring an unbounded count. Find results may include a short provider-safe preview in text; `details.items` remains metadata-only.

## Read before a targeted write

Supersede, lifecycle, include, and exclude operations require:

```text
exact id or sourceRef
targetRevision from a prior read
```

A revision is a process-local HMAC token bound to the item fingerprint and active session/project/branch context. It expires and is invalid after restart. A changed target, switched context, expired token, unknown reference, or non-active target is rejected. The tool never converts a fuzzy query or a high-scoring match into a write target.

`memory_sources` returns `sourceRef`, not a session ID or file path. The mapping is process-local, TTL/cap-bounded, and never persisted. The opaque reference itself may remain in Pi's normal tool-result history so a subsequent exact call can use it.

## Confirmation and no-UI behavior

Every model-callable write requires a fresh local Pi UI decision:

```ts
await ctx.ui.confirm("DS4 Context Persistence", message)
```

The dialog identifies the action and persistence class. Canonical add/supersede dialogs show bounded full content and effective classification; lifecycle dialogs show a bounded local target preview and optional reason. Source-policy dialogs show only the volatile reference and safe status/counters. Confirmation text is never copied into the tool result or logs.

A model cannot provide `confirmed=true`; it is not in the schema. If `ctx.hasUI` is false, all writes return:

```text
outcome=unavailable
errorCode=confirmation-required
```

Reads remain available. Refusal, dialog closure, or abort before dispatch causes no write. Pi `0.84.3` RPC can advertise UI capability even when no client is currently answering UI requests. In that case the confirmation request remains pending in Pi's RPC transport; DS4 does not infer consent or refusal, and no append occurs before a positive response. RPC clients that expose UI capability must answer the request explicitly. If the active Pi session has no persistent JSONL destination (for example `--no-session`), reads and writes both fail closed with `runtime-unavailable`; no confirmation is shown and no canonical commit is claimed.

## Canonical and derived persistence

Pin and Memory mutations call `Ds4ContextRuntime`, append the existing versioned custom entry through `pi.appendEntry()`, and reconcile SQLite:

```text
ds4-context-pin-v1
ds4-context-memory-v1
```

The tool never inserts canonical Pin or Memory state directly into SQLite and never rewrites Pi JSONL. Provenance is derived from the latest preceding user message on the active branch, not from model-supplied source IDs, and is revalidated after confirmation.

Project-memory source exclusion is intentionally different. It updates `project_memory_source_exclusions` through the coordinated runtime repository and reports `persistenceClass=derived-local-policy`. It does not append a fake Pi entry. Deleting `context.db` resets this policy; replay restores source contributions from unchanged sibling JSONL.

## Privacy and provider policy

The tool enforces its own egress policy even when general privacy is disabled:

- current and historical content, query, key, reason, preview, path, source identity, and raw errors are removed unless explicitly allowed;
- the fixed historical omission sentinel is output-only; any incoming string argument containing it is rejected as `egress-placeholder` before runtime access, confirmation, or persistence, so retries must use fresh user-provided text;
- results use deterministic metadata-only templates;
- marker/credential detection may raise a mutation classification;
- an explicit supersede classification cannot lower the target's effective protection;
- remote-disallowed or `local-only` writes are rejected before append;
- provider/trust/provenance/target state is checked again after confirmation.

Selecting `local-only` does not prove that a remote model never saw the original message or tool arguments. Use the direct `/context` command surface or a verified local provider when data must never be disclosed remotely.

## Outcomes and recovery

| Outcome | Meaning |
| --- | --- |
| `ok` | Read succeeded, add was duplicate, or source policy already matched |
| `committed` | Canonical append/materialization or derived policy update succeeded |
| `rejected` | Validation, policy, trust, provenance, conflict, target, or revision check failed |
| `cancelled` | User refusal/dialog closure or abort before dispatch |
| `unavailable` | Runtime/capability/UI unavailable; no commit is claimed |
| `committed_projection_pending` | Canonical append succeeded but projection/result materialization did not complete safely |
| `indeterminate` | The append call did not return, so completion cannot be established |

Never automatically retry `committed_projection_pending` or `indeterminate`. Inspect with a read, `/context health`, or `/context rebuild-index` first. SQLite is disposable; canonical Pin/Memory state reappears after replay. Source exclusions intentionally do not.

## `/context` relationship

`/context` remains the direct local administrative and inspection surface. It can show local detail that must not enter a provider-visible tool result. `context_persistence` calls the same runtime mutation primitives but has a narrower schema, automatic branch provenance, exact-revision requirements, confirmation on every write, and a dedicated historical egress guard.

Useful diagnostics:

```text
/context pins
/context memory
/context memory sources
/context privacy
/context health
/context rebuild-index
```

## Beta dogfooding

Use the published package with synthetic data and exercise TUI, RPC, print, and JSON behavior through the dedicated [`0.3 beta dogfooding runbook`](DOGFOODING_0.3.0_BETA.md). The runbook distinguishes RPC's UI request/response bridge from genuinely no-UI print/JSON modes and includes a metadata-only canonical append audit. The earlier [`0.3 alpha runbook`](DOGFOODING_0.3.0_ALPHA.md) remains available as historical release evidence.
