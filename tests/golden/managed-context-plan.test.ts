import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "ds4-context-core/config/config";
import { planManagedContext } from "ds4-context-core/planner/context-planner";

describe("managed context plan golden contract", () => {
  it("keeps ranking, atomicity, and fitting deterministic", () => {
    const messages = [
      { role: "user", content: `old ${"x".repeat(400)}` },
      { role: "assistant", content: [{ type: "text", text: "old response" }] },
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } }],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "result ".repeat(20) }],
        isError: false,
      },
      { role: "user", content: "current request" },
    ];
    const plan = planManagedContext({
      messages,
      fixedTokens: 50,
      budget: {
        contextWindow: 32_000,
        outputReserve: 4_096,
        safetyMargin: 1_024,
        modelInputHardLimit: 1_000,
        hardInputLimit: 1_000,
        softInputLimit: 1_000,
        preferredInputTarget: 220,
        activeInputBudget: 220,
      },
      config: { ...DEFAULT_CONFIG.context, mode: "managed", recentTailTokens: 500 },
    });
    const actual = {
      mode: plan.mode,
      selected: plan.selected,
      excluded: plan.excluded,
      planning: plan.planning,
      selectedRoles: plan.messages.map((message) => message.role),
    };
    const expected = JSON.parse(
      readFileSync(join(import.meta.dirname, "managed-context-plan.json"), "utf8"),
    ) as unknown;

    expect(actual).toEqual(expected);
  });
});
