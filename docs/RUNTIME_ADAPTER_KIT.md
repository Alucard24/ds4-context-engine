# Runtime Adapter Kit

M19 defines `runtime-adapter-v1`, a runtime-neutral boundary between DS4 policy and an agent host. The kit lives in `ds4-context-core/adapter/*`; the non-Pi implementation is published separately as `ds4-context-reference-adapter`. Core imports no runtime SDK.

## Dependency and state boundary

```text
native agent runtime / provider SDK
                ↓
runtime adapter package
                ↓
ds4-context-core/adapter/runtime-adapter
```

An adapter owns native history conversion, trusted-root discovery, provider completion, final privacy enforcement, optional runtime capabilities, and shutdown. Core owns contract types, deterministic capability negotiation, canonical tool-group validation, and the framework-neutral conformance runner.

The runtime's native history remains canonical. A `RuntimeHistorySnapshot` is a read-only projection with:

- `runtimeId`, `sessionId`, schema version, and deterministic source revision;
- one exact trusted canonical project root;
- ordered `CanonicalMessage` values with stable source-entry provenance;
- complete tool call/result atomic groups derived from canonical blocks.

Applying a DS4 context plan must not write provider-facing synthetic messages back into canonical history. Rebuild deletes or discards only adapter/DS4 projections and reproduces the snapshot from the native source.

## Contract

`RuntimeAdapter` requires:

| Method | Responsibility | Failure rule |
|---|---|---|
| `snapshotHistory()` | Project the active canonical history and tool relations. | Reject an invalid, corrupt, identity-mismatched, or untrusted source. Never invent history. |
| `rebuildDerivedState()` | Discard adapter caches/projections and replay canonical state. | Preserve canonical files and the previous valid source. |
| `currentModel()` | Return provider/model limits through `ModelDescriptor`. | Return `undefined` when no model is selected. |
| `trustedProjectRoot()` | Return the runtime-approved canonical root. | Reject untrusted roots; do not broaden them. |
| `enforcePrivacy()` | Sanitize a provider payload immediately before transport. | Fail closed and do not invoke transport on error. |
| `complete()` | Invoke the runtime/provider boundary with the sanitized payload. | Return an explicit fallback result for invalid input, privacy failure, transport failure, or closed lifecycle. |
| `capabilityDeclarations()` / `negotiateCapabilities()` | Version and independently enable optional host features. | Missing or malformed declarations are unsupported, not fatal to other features. |
| `diagnostics()` | Return bounded metadata-only state. | Never include prompts, history, credentials, payloads, cache handles, or provider output. |
| `shutdown()` | Release adapter resources idempotently. | Further writes/completions fall back; history reads are rejected. |

Completion output remains runtime-owned and is not automatically canonical. An adapter must append a final runtime-native message through its ordinary canonical history API if the host chooses to persist it.

## Tool atomicity

`buildCanonicalToolAtomicGroups()` connects every canonical `toolCall` block to all matching `toolResult` blocks. Calls sharing one assistant message form one component, so parallel tool batches cannot be split. `validateRuntimeHistorySnapshot()` rejects missing, overlapping, unknown, or mismatched groups. An incomplete live call is represented by a group with `complete: false`; it cannot be treated as a complete selectable exchange.

## Capability negotiation

The v1 registry is fixed and additive contracts must use a later contract version:

- `compaction`;
- `provider-continuation`;
- `embeddings`;
- `local-kv-reuse`.

A supported capability requires a non-empty implementation version. Unsupported capabilities require a bounded reason. `negotiateRuntimeCapabilities()` evaluates each request independently:

- a supported requested capability is enabled;
- an unsupported optional capability is disabled with an informational diagnostic;
- an unsupported required capability is disabled with a warning;
- a duplicate, missing, or unversioned declaration is malformed and disabled;
- no failure in one capability disables canonical history, privacy, completion fallback, or another valid capability.

M19 only negotiates `local-kv-reuse`; M20 defines its eligibility and handle lifecycle. KV handles are never part of canonical history or these diagnostics.

Pi advertises versioned compaction, OpenAI Responses continuation, and embedding-port support. It explicitly reports local KV reuse as unavailable. `/context adapter` shows the complete negotiation; `/context status` shows aggregate enabled/disabled counts.

## Reusable conformance kit

The conformance runner has no Vitest/Jest dependency. Adapter packages provide a factory that maps a versioned fixture and injected completion transport into their native runtime:

```ts
import {
  assertRuntimeAdapterConformance,
  runRuntimeAdapterConformance,
} from "ds4-context-core/adapter/conformance";

const report = await runRuntimeAdapterConformance({
  name: "my-runtime",
  async create(fixture, transport) {
    // Create native canonical history from fixture.messages.
    // Inject transport at the final provider boundary.
    return { adapter, expectedProjectRoot, cleanup };
  },
});
assertRuntimeAdapterConformance(report);
```

The seven checks cover:

1. adapter/contract identity, model limits, and trusted root;
2. complete capability declarations and isolated unsupported diagnostics;
3. ordered canonical history and tool atomicity;
4. deterministic rebuild from canonical state;
5. remote privacy filtering plus synthetic sanitizer failure before observed transport;
6. safe transport failure with native fallback still available;
7. idempotent shutdown and closed-state behavior.

Reports contain case IDs, booleans, and fixed failure codes only. The private marker and credential probes never appear in a report. Package smoke tests install core, Pi, and reference tarballs in a clean consumer and rerun reference conformance from compiled exports.

## Reference-adapter compatibility spike

M19 compared three reference targets:

| Candidate | Strength | M19 risk |
|---|---|---|
| another full agent SDK | realistic lifecycle | adds fast-moving SDK/version coupling and obscures which behavior belongs to DS4 versus the SDK |
| provider-client-only adapter | realistic completion | has no canonical branch, tool-group, or lifecycle contract to validate |
| callback runtime with append-only JSONL | exercises every adapter responsibility with no vendor SDK | intentionally minimal; not a production orchestration framework |

The callback JSONL target was selected because it covers the full contract while keeping the example inspectable and dependency-neutral. `ds4-context-reference-adapter` is therefore a non-Pi executable boundary example, not a claim of production support for a specific third-party agent framework.

Its `ds4-runtime-session-v1` file is canonical and append-only. The header binds runtime ID, session ID, and canonical project root. Message records contain DS4 canonical messages. `createReferenceHistory()` refuses overwrite, `appendReferenceHistoryMessage()` checks provenance before append, and `rebuildDerivedState()` discards only the in-memory snapshot. File size and message count are bounded. Files are mode `0600` where supported.

The reference adapter provides a callback completion transport, enabled fail-closed privacy by default, optional `EmbeddingPort`, and explicit unsupported declarations for native compaction, provider continuation, and local KV state.

## Packaging rules

All release packages use the same version.

- `ds4-context-core` has no runtime SDK dependency.
- `ds4-context-engine` contains the Pi SDK boundary and depends exactly on matching core.
- `ds4-context-reference-adapter` contains no Pi SDK and depends exactly on matching core.
- Adapter source is not bundled into the core tarball; core source is not bundled into adapter tarballs.
- Core and reference TypeScript compile to ESM JavaScript and declarations before packing.
- Publish core first, then reference, then Pi.

Use:

```bash
npm run check
npm run pack:check
npm pack --dry-run --workspace ds4-context-core
npm pack --dry-run --workspace ds4-context-reference-adapter
npm pack --dry-run
```

## Limitations and rollback

The reference adapter is intentionally synchronous-history/callback-completion infrastructure: it does not implement streaming, native compaction, branch editing, provider continuation, or KV reuse. Unsupported features remain disabled and visible rather than emulated.

Removing the reference package does not affect Pi or core. A runtime can roll back its adapter by stopping it and returning to native history/context behavior; no canonical migration or SQLite downgrade is required. Deleting adapter caches is safe. Never delete the runtime-owned JSONL file as part of DS4 rollback.
