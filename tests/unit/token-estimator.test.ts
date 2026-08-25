import { describe, expect, it } from "vitest";
import { estimateMessagesTokens, estimateTextTokens } from "ds4-context-core/core/token-estimator";

describe("token estimator", () => {
  it("uses the documented four characters per token baseline", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("1234")).toBe(1);
    expect(estimateTextTokens("12345")).toBe(2);
  });

  it("accounts for text, thinking, tool calls, results, and images", () => {
    const textOnly = estimateMessagesTokens([{ role: "user", content: "hello" }]);
    const toolHeavy = estimateMessagesTokens([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "check the file" },
          { type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        content: [
          { type: "text", text: "file contents" },
          { type: "image", data: "ignored", mimeType: "image/png" },
        ],
      },
    ]);

    expect(toolHeavy).toBeGreaterThan(textOnly + 1_000);
  });
});
