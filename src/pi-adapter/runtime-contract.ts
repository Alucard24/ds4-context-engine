import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  RUNTIME_CAPABILITY_IDS,
  RUNTIME_HISTORY_SCHEMA_VERSION,
  buildCanonicalToolAtomicGroups,
  negotiateRuntimeCapabilities,
  validateRuntimeHistorySnapshot,
  type RuntimeCapabilityDeclaration,
  type RuntimeCapabilityNegotiation,
  type RuntimeCapabilityRequest,
  type RuntimeHistorySnapshot,
} from "ds4-context-core/adapter/runtime-adapter";
import { sha256 } from "ds4-context-core/shared/hash";
import { stableStringify } from "ds4-context-core/shared/stable-json";
import {
  sessionEntryToContextMessages,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { toCanonicalMessage } from "./message-converter.ts";

export const PI_RUNTIME_ID = "pi";

export const PI_RUNTIME_CAPABILITIES: readonly RuntimeCapabilityDeclaration[] = [
  { id: "compaction", supported: true, version: "pi-session-compact-v1" },
  { id: "provider-continuation", supported: true, version: "pi-openai-responses-continuation-v1" },
  { id: "embeddings", supported: true, version: "embedding-port-v1" },
  {
    id: "local-kv-reuse",
    supported: false,
    reason: "Pi does not expose reusable local prefix or KV state",
  },
];

function canonicalProjectRoot(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export function negotiatePiRuntimeCapabilities(
  requested: readonly RuntimeCapabilityRequest[] = RUNTIME_CAPABILITY_IDS.map((id) => ({ id })),
): RuntimeCapabilityNegotiation {
  return negotiateRuntimeCapabilities(PI_RUNTIME_CAPABILITIES, requested);
}

/**
 * Projects Pi's active, compaction-aware branch without modifying canonical JSONL.
 * The snapshot is suitable for shared adapter-contract validation and diagnostics.
 */
export function snapshotPiRuntimeHistory(
  ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted" | "sessionManager">,
): RuntimeHistorySnapshot {
  if (!ctx.isProjectTrusted()) {
    throw new Error("Pi project root is not trusted");
  }
  const sessionId = ctx.sessionManager.getSessionId();
  const entries = ctx.sessionManager.buildContextEntries();
  const messages = entries.flatMap((entry) => sessionEntryToContextMessages(entry).map((message) =>
    toCanonicalMessage({
      sessionId,
      entryId: entry.id,
      entryTimestamp: entry.timestamp,
      message,
    })));
  const snapshot: RuntimeHistorySnapshot = {
    schemaVersion: RUNTIME_HISTORY_SCHEMA_VERSION,
    runtimeId: PI_RUNTIME_ID,
    sessionId,
    revision: sha256(stableStringify({
      leafId: ctx.sessionManager.getLeafId(),
      entries,
    })),
    projectRoot: canonicalProjectRoot(ctx.cwd),
    messages,
    toolAtomicGroups: buildCanonicalToolAtomicGroups(messages),
  };
  const issues = validateRuntimeHistorySnapshot(snapshot);
  if (issues.length > 0) {
    throw new Error(`Pi canonical history snapshot failed validation: ${issues.length} issue(s)`);
  }
  return snapshot;
}
