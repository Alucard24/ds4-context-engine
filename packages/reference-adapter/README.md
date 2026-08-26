# ds4-context-reference-adapter

Non-Pi reference implementation of the DS4 `runtime-adapter-v1` contract.

The package adapts an append-only JSONL conversation owned by a small callback-driven agent runtime. It is intentionally vendor-neutral: completion transport is injected by the host, while runtime SDK dependencies stay outside `ds4-context-core`.

## Guarantees

- JSONL is canonical; in-memory snapshots are disposable and rebuildable.
- Canonical messages retain stable provenance and complete tool call/result atomic groups.
- The trusted project root is canonicalized and must match the session header.
- Model limits use the portable DS4 model descriptor.
- Provider payloads pass privacy enforcement immediately before the injected transport.
- Privacy failures fail closed; transport failures return an explicit native-fallback result.
- Unsupported compaction, provider continuation, embeddings, and local KV reuse are negotiated independently with explicit diagnostics.
- Shutdown is idempotent and rejects further history access.

## Example

```ts
import {
  JsonlReferenceRuntimeAdapter,
  createReferenceHistory,
} from "ds4-context-reference-adapter";

createReferenceHistory({
  historyFile: ".agent/session.jsonl",
  runtimeId: "my-runtime",
  sessionId: "session-1",
  projectRoot: process.cwd(),
  messages: [],
});

const adapter = new JsonlReferenceRuntimeAdapter({
  historyFile: ".agent/session.jsonl",
  projectRoot: process.cwd(),
  runtimeId: "my-runtime",
  model: {
    provider: "my-provider",
    id: "my-model",
    contextWindow: 32_768,
    maxTokens: 4_096,
  },
  transport: async ({ payload }) => invokeMyRuntime(payload),
});

const snapshot = await adapter.snapshotHistory();
const negotiation = adapter.negotiateCapabilities([
  { id: "compaction" },
  { id: "embeddings" },
]);
```

`createReferenceHistory` refuses to overwrite an existing canonical session. `appendReferenceHistoryMessage` appends one provenance-checked message. Applications should serialize canonical writes according to their own runtime lifecycle.

## Conformance

Adapter authors can reuse the framework-neutral kit exported by core:

```ts
import {
  assertRuntimeAdapterConformance,
  runRuntimeAdapterConformance,
} from "ds4-context-core/adapter/conformance";

const report = await runRuntimeAdapterConformance(myAdapterFactory);
assertRuntimeAdapterConformance(report);
```

See the repository's `docs/RUNTIME_ADAPTER_KIT.md` for the complete contract, compatibility decision, packaging rules, and failure semantics.
