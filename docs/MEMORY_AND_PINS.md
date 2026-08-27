# Memory and Persistent Pins

DS4 separates durable, user-curated state from conversation history while keeping Pi JSONL canonical. Cross-session replay optionally reconstructs explicit project-scoped mutations from sibling Pi sessions for the same trusted canonical project.

## Authority and scope

Pins are explicit user-confirmed context with maximum planner priority:

- `session`: available throughout the current Pi session tree;
- `branch`: available only when its creation leaf is on the active branch;
- `project`: available to sessions using the same canonical project path, but only when Pi reports the project trusted.

Memory is quoted historical data rather than policy:

- `session`: available only in the source Pi session;
- `project`: shared across sessions for the same trusted canonical project path.

Pins remain subordinate to system/developer instructions. Memory tells the model to validate a claim against current evidence. Neither is created automatically in M9.

## Commands

```text
/context pins
/context pin [--scope session|branch|project] [--classification LEVEL] [--source ENTRY] [--file PATH] <content>
/context pin --scope session --supersedes PIN_ID [--classification LEVEL] <replacement>
/context unpin PIN_ID [reason]

/context memory
/context memory add [--scope session|project] [--classification LEVEL] [--key KEY] [--source ID,ID] <claim>
/context memory supersede MEMORY_ID [--classification LEVEL] [--source ID,ID] <new claim>
/context memory invalidate MEMORY_ID [reason]
/context memory expire MEMORY_ID [reason]
/context memory sources
/context memory exclude SESSION_ID [reason]
/context memory include SESSION_ID
```

Arguments support single/double quotes and backslash escaping. `--` ends option parsing. Source entry IDs must be on Pi's active branch. Project scope requires Pi project trust. Source exclusion affects only project-scoped contributions and persists until `include`; the active session cannot be newly excluded but can restore a prior exclusion.

Mutations are manual-first: persistence requires an explicit user request, and every LLM-tool write additionally requires local UI confirmation. DS4 never harvests ordinary conversation into Pins or Memory automatically. `/context` remains the direct local command surface; `context_persistence` is the bounded model-callable surface and requires a prior exact read plus revision for destructive operations. Repeating the same normalized pin/claim returns its existing ID without appending another entry.

## Canonical append-only mutations

Every accepted operation is appended through `pi.appendEntry()` as a Pi `CustomEntry`:

```text
ds4-context-pin-v1
ds4-context-memory-v1
```

Custom entries do not participate directly in Pi's LLM context. Their payload is an immutable versioned mutation:

```text
add
supersede previous ID with a new immutable record
status -> deleted / invalid / expired
```

No row is silently overwritten. SQLite mutation and materialized tables are disposable projections. On startup or `/context rebuild-index`, DS4:

1. indexes the custom entries with their canonical scoped entry keys;
2. replaces the current session's mutation projection;
3. replays all known mutations in timestamp + canonical entry order;
4. rebuilds memory, pin, source, lifecycle, and FTS rows transactionally.

Deleting `context.db` and reopening the canonical source session reconstructs its state. With `memory.crossSession: true`, DS4 discovers bounded sibling `.jsonl` files, accepts only headers whose `cwd` resolves to the exact trusted canonical project identity, incrementally indexes each source, and reconstructs project items without opening every session manually. No claim is extracted from ordinary conversation text. Source exclusions are deliberately derived local policy: deleting the database removes them, replay restores the source from unchanged canonical JSONL, and no source-policy operation rewrites a session file.

## Supersession and contradiction handling

A memory may have an explicit normalized key:

```text
/context memory add --key package-export-mode \
  "Package export mode defaults to PerEndpoint."
```

For claims shaped like `subject defaults to value`, `subject is value`, or `subject = value`, DS4 derives a conservative key automatically. An active item with the same scope/key and a different claim is a conflict. Opposite-polarity claims such as `Feature is enabled` and `Feature is disabled` are also detected when their normalized bases match.

A conflicting `add` is rejected with the IDs involved. The user must issue explicit supersession:

```text
/context memory supersede MEMORY_ID \
  "Package export mode defaults to SingleFile."
```

The old item remains stored as `superseded` and points to the new active item. During replay, records are ordered by timestamp, source session ID, source entry order, mutation ID and mutation entry key. Concurrent active records with the same key are both preserved; the deterministic later record is marked `invalid` with a conflict reason rather than replacing the earlier one. Selected items retain source-session file/ID, mutation entry, creation branch leaf, evidence entries, classification, supersession and contradiction IDs.

Pins use the same immutable replacement pattern through `--supersedes`. `/context unpin` records a soft `deleted` lifecycle mutation.

## Context selection

The managed planner inserts selected synthetic messages immediately before the current request in this order:

```text
persistent pins      priority 950, mandatory within maxPinnedTokens
memory               priority 90, maxMemoryTokens
historical retrieval priority 85
project snippets     priority 80
current request      mandatory
```

All applicable pins are considered in deterministic creation order. Branch pins are hard-filtered against `SessionManager.getBranch()`.

Memory ranking uses current request identifiers, file/symbol/keyword terms, optional keys, scope authority, and recency. If any memories match, unrelated memory is excluded. When nothing matches, at most three recent active items provide conservative continuity. `memory.maxResults` and `context.maxMemoryTokens` bound the final set.

A pin budget overflow causes planner fallback rather than silently splitting mandatory context. Commands cap individual pin/claim characters, while final system/tools/messages validation still enforces the active model hard limit.

## Prompt-injection boundary

Pins are rendered as user-confirmed content:

```text
[DS4 PINNED CONTEXT — USER-CONFIRMED]
...
Pinned content JSON: "..."
[END DS4 PINNED CONTEXT]
```

Memory is rendered as quoted data:

```text
[DS4 DURABLE MEMORY — QUOTED DATA]
...
Claim JSON: "..."
[END DS4 DURABLE MEMORY]
```

User text is JSON-quoted. Context Manifests contain IDs, scope, classification, key, source session/entry IDs, score, token estimate, and selection reason—but never pin content or memory claim text.

M10 stores an optional classification in the canonical mutation. Before a remote call, a prohibited pin/memory is omitted as a whole and recorded only by ID/classification/reason. Explicit classification cannot be downgraded by markers inside its content. See [`PRIVACY.md`](PRIVACY.md).

## SQLite schema v9 and v15

Schema v9 extends materialized `memory_items` and `pins` with:

- normalized key, origin session, branch leaf;
- update/status reason, optional classification in `metadata_json`, and immutable supersession links;
- indexes for scope/lifecycle/branch selection.

`memory_mutations` and `pin_mutations` reference canonical indexed Pi custom entries. `memory_sources` retains exact scoped entry provenance. `memory_fts` is rebuilt transactionally.

Schema v15 adds source-branch provenance, per-session project-memory checkpoints, source status and explicit source exclusions. These rows are derived and disposable. Missing, truncated, moved, identity-mismatched or corrupt sibling files are marked unavailable and their unverifiable project-scoped mutations stop contributing; session-scoped state remains isolated and the active session keeps its last transactional projection on refresh failure. Restoration or database deletion causes deterministic replay from JSONL.

Migration preserves legacy materialized rows for inspection. Because they have no canonical mutation entry, a later full replay may discard them; new operations are always event-sourced.

## Diagnostics

```text
/context status
/context tokens
/context manifest
/context included
/context excluded
/context pins
/context memory
/context memory sources
/context health
/context rebuild-index
```

Structured logs contain mutation/item IDs, scopes, counts, lifecycle, and warning counts—not pin or claim text.

## Performance

`tests/benchmarks/memory-selection.bench.ts` ranks 1,000 active session/project memories. On the development host:

```text
mean 5.85 ms, p99 7.22 ms, max 8.49 ms
```

This is below the initial 50 ms typical context-planning target; it is not a portable guarantee.
