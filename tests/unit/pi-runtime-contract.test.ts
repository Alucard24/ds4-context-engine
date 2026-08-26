import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { validateRuntimeHistorySnapshot } from "ds4-context-core/adapter/runtime-adapter";
import {
  negotiatePiRuntimeCapabilities,
  snapshotPiRuntimeHistory,
} from "../../src/pi-adapter/runtime-contract.ts";
import { describe, expect, it } from "vitest";

function context(trusted = true): Pick<ExtensionContext, "cwd" | "isProjectTrusted" | "sessionManager"> {
  const entries: SessionEntry[] = [
    {
      type: "message",
      id: "entry-user",
      parentId: null,
      timestamp: "2026-08-26T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "Read the file" }], timestamp: 1 },
    },
    {
      type: "message",
      id: "entry-call",
      parentId: "entry-user",
      timestamp: "2026-08-26T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }],
        api: "test",
        provider: "test",
        model: "test-model",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: 2,
      },
    },
    {
      type: "message",
      id: "entry-result",
      parentId: "entry-call",
      timestamp: "2026-08-26T00:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 3,
      },
    },
  ];
  return {
    cwd: process.cwd(),
    isProjectTrusted: () => trusted,
    sessionManager: {
      getSessionId: () => "pi-runtime-session",
      getLeafId: () => "entry-result",
      buildContextEntries: () => entries,
    } as ExtensionContext["sessionManager"],
  };
}

describe("Pi runtime adapter contract projection", () => {
  it("projects the trusted active branch with tool atomicity", () => {
    const snapshot = snapshotPiRuntimeHistory(context());

    expect(snapshot.runtimeId).toBe("pi");
    expect(snapshot.messages.map((message) => message.sourceEntryId)).toEqual([
      "entry-user",
      "entry-call",
      "entry-result",
    ]);
    expect(snapshot.toolAtomicGroups).toEqual([
      expect.objectContaining({ complete: true, toolCallIds: ["call-1"] }),
    ]);
    expect(validateRuntimeHistorySnapshot(snapshot)).toEqual([]);
  });

  it("rejects untrusted project roots", () => {
    expect(() => snapshotPiRuntimeHistory(context(false))).toThrow("not trusted");
  });

  it("negotiates unsupported local KV reuse without disabling other Pi features", () => {
    const negotiation = negotiatePiRuntimeCapabilities();

    expect(negotiation.enabled).toEqual([
      "compaction",
      "provider-continuation",
      "embeddings",
    ]);
    expect(negotiation.disabled).toEqual(["local-kv-reuse"]);
    expect(negotiation.diagnostics).toContainEqual(expect.objectContaining({
      capability: "local-kv-reuse",
      severity: "info",
    }));
  });
});
