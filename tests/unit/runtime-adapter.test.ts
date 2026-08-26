import {
  RUNTIME_HISTORY_SCHEMA_VERSION,
  buildCanonicalToolAtomicGroups,
  negotiateRuntimeCapabilities,
  validateRuntimeHistorySnapshot,
  type RuntimeHistorySnapshot,
} from "ds4-context-core/adapter/runtime-adapter";
import type { CanonicalMessage } from "ds4-context-core/core/canonical-message";
import { describe, expect, it } from "vitest";

function toolMessages(): CanonicalMessage[] {
  const sessionId = "runtime-session";
  const base = (entryId: string) => ({
    id: `${sessionId}:${entryId}`,
    sourceEntryId: entryId,
    provenance: {
      source: "runtime-session" as const,
      runtimeId: "test-runtime",
      sessionId,
      entryId,
    },
    flags: { atomic: true },
  });
  return [
    {
      ...base("call"),
      role: "assistant",
      blocks: [
        { type: "toolCall", id: "call-a", name: "read", arguments: {} },
        { type: "toolCall", id: "call-b", name: "bash", arguments: {} },
      ],
    },
    {
      ...base("result-a"),
      role: "tool",
      blocks: [{ type: "toolResult", toolCallId: "call-a", toolName: "read", content: "ok", isError: false }],
    },
    {
      ...base("result-b"),
      role: "tool",
      blocks: [{ type: "toolResult", toolCallId: "call-b", toolName: "bash", content: "ok", isError: false }],
    },
  ];
}

describe("runtime adapter contract", () => {
  it("negotiates capabilities independently with explicit unsupported diagnostics", () => {
    const negotiation = negotiateRuntimeCapabilities([
      { id: "compaction", supported: true, version: "compact-v1" },
      { id: "provider-continuation", supported: false, reason: "no continuation handle" },
      { id: "embeddings", supported: true, version: "embedding-v1" },
      { id: "local-kv-reuse", supported: false, reason: "no local KV API" },
    ], [
      { id: "compaction", required: true },
      { id: "provider-continuation" },
      { id: "embeddings" },
      { id: "local-kv-reuse" },
    ]);

    expect(negotiation.enabled).toEqual(["compaction", "embeddings"]);
    expect(negotiation.disabled).toEqual(["provider-continuation", "local-kv-reuse"]);
    expect(negotiation.diagnostics).toEqual([
      expect.objectContaining({ capability: "provider-continuation", severity: "info" }),
      expect.objectContaining({ capability: "local-kv-reuse", severity: "info" }),
    ]);
  });

  it("disables malformed declarations without affecting valid capabilities", () => {
    const negotiation = negotiateRuntimeCapabilities([
      { id: "compaction", supported: true, version: "compact-v1" },
      { id: "provider-continuation", supported: false },
      { id: "embeddings", supported: true },
      { id: "embeddings", supported: true, version: "embedding-v1" },
    ], [
      { id: "compaction" },
      { id: "provider-continuation" },
      { id: "embeddings", required: true },
      { id: "local-kv-reuse" },
    ]);

    expect(negotiation.enabled).toEqual(["compaction"]);
    expect(negotiation.statuses.find((status) => status.id === "embeddings")).toMatchObject({
      supported: false,
      enabled: false,
      reason: "runtime adapter declared this capability more than once",
    });
    expect(negotiation.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "capability-declaration-invalid",
        capability: "provider-continuation",
        severity: "info",
      }),
      expect.objectContaining({
        code: "capability-declaration-invalid",
        capability: "embeddings",
        severity: "warning",
      }),
    ]));
    expect(negotiation.statuses.find((status) => status.id === "local-kv-reuse")).toMatchObject({
      supported: false,
      enabled: false,
    });
  });

  it("derives and validates complete canonical tool atomic groups", () => {
    const messages = toolMessages();
    const groups = buildCanonicalToolAtomicGroups(messages);
    const snapshot: RuntimeHistorySnapshot = {
      schemaVersion: RUNTIME_HISTORY_SCHEMA_VERSION,
      runtimeId: "test-runtime",
      sessionId: "runtime-session",
      revision: "revision-1",
      projectRoot: "/workspace/project",
      messages,
      toolAtomicGroups: groups,
    };

    expect(groups).toEqual([
      expect.objectContaining({
        complete: true,
        messageIds: messages.map((message) => message.id),
        toolCallIds: ["call-a", "call-b"],
      }),
    ]);
    expect(validateRuntimeHistorySnapshot(snapshot)).toEqual([]);

    snapshot.toolAtomicGroups = [{ ...groups[0]!, messageIds: [messages[0]!.id] }];
    expect(validateRuntimeHistorySnapshot(snapshot)).toContainEqual(expect.objectContaining({
      code: "tool-atomic-group-mismatch",
    }));
  });
});
