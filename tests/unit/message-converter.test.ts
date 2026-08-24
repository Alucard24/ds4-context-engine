import { describe, expect, it } from "vitest";
import {
  canonicalMessageSearchText,
  toCanonicalMessage,
} from "../../src/pi-adapter/message-converter.ts";

describe("Pi CanonicalMessage adapter", () => {
  it("preserves provider blocks while excluding thinking and image payloads from search", () => {
    const canonical = toCanonicalMessage({
      sessionId: "session",
      entryId: "entry",
      entryTimestamp: "2026-08-24T10:00:00.000Z",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-test",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "toolCall", id: "call", name: "read", arguments: { path: "src/a.ts" } },
          { type: "image", mimeType: "image/png", data: "base64-secret" },
          { type: "future-provider-block", payload: "opaque-secret" },
        ],
      },
    });

    expect(canonical.id).toBe("session:entry");
    expect(canonical.role).toBe("assistant");
    expect(canonical.flags.atomic).toBe(true);
    expect(canonical.blocks.map((block) => block.type)).toEqual([
      "thinking",
      "toolCall",
      "image",
      "opaqueProvider",
    ]);

    const searchable = canonicalMessageSearchText(canonical);
    expect(searchable).toContain("read");
    expect(searchable).toContain("src/a.ts");
    expect(searchable).not.toContain("private reasoning");
    expect(searchable).not.toContain("base64-secret");
    expect(searchable).not.toContain("opaque-secret");
  });

  it("normalizes tool results into an atomic canonical block", () => {
    const canonical = toCanonicalMessage({
      sessionId: "session",
      entryId: "result",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: "tests passed" }],
        isError: false,
      },
    });

    expect(canonical.role).toBe("tool");
    expect(canonical.blocks[0]).toMatchObject({
      type: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: "tests passed",
    });
  });
});
