import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { planManagedContext } from "../../src/planner/context-planner.ts";

function buildContract() {
  const current = { role: "user", content: "Implement ExportMode without changing the invariant." };
  const plan = planManagedContext({
    messages: [current],
    fixedTokens: 100,
    budget: {
      contextWindow: 32_000,
      outputReserve: 4_096,
      safetyMargin: 1_024,
      modelInputHardLimit: 4_000,
      hardInputLimit: 4_000,
      softInputLimit: 4_000,
      preferredInputTarget: 3_000,
      activeInputBudget: 3_000,
    },
    config: { ...DEFAULT_CONFIG.context, mode: "managed", recentTailTokens: 0 },
    supplementalMessages: [
      {
        id: "pin:pin-1",
        message: { role: "user", content: "[pin] Never rewrite canonical JSONL." },
        kind: "pin",
        sourceIds: ["pin-1"],
        score: 950,
        reason: "Active user-confirmed session pin",
      },
      {
        id: "memory:memory-1",
        message: { role: "user", content: "[memory] ExportMode defaults to PerEndpoint." },
        kind: "memory",
        sourceIds: ["memory-1"],
        score: 90.125,
        reason: "Durable memory matched: ExportMode",
      },
    ],
  });
  return {
    mode: plan.mode,
    messages: plan.messages,
    selected: plan.selected,
    excluded: plan.excluded,
    planning: plan.planning,
  };
}

describe("memory context plan golden contract", () => {
  it("keeps pin authority, memory provenance, and ordering deterministic", () => {
    const expected = JSON.parse(
      readFileSync(join(import.meta.dirname, "memory-context-plan.json"), "utf8"),
    ) as unknown;
    expect(buildContract()).toEqual(expected);
  });
});
