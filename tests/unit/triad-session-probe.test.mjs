import { describe, expect, it } from "vitest";
import { buildHighInput, LIMITS, MIN_SELECTED_USER_TOKENS, MODELS,
  OCCUPANCY_THRESHOLD, RECORDED_CONSUMPTION, main, reserve,
  selectedCurrentUserTokens } from "../../scripts/verify-model-aware-triad.mjs";

describe("native-window triad probe preflight", () => {
  it("requires explicit --live and plans only the three named OpenRouter models", async () => {
    const plan = await main([]);
    expect(plan.mode).toBe("dry-run");
    expect(plan.models).toEqual(["openai/gpt-6-sol", "openai/gpt-6-luna", "openai/gpt-5.6-terra"]);
    expect(MODELS).toEqual(plan.models);
    expect(OCCUPANCY_THRESHOLD).toBe(441_000);
    expect(MIN_SELECTED_USER_TOKENS).toBeGreaterThan(OCCUPANCY_THRESHOLD);
    await expect(main(["--model", "another-model"])).rejects.toThrow("Only --live");
    expect(RECORDED_CONSUMPTION).toEqual({ calls: 42, input: 3_296_138, chars: 9_357_266 });
    await expect(main(["--live"])).rejects.toThrow("authorization exhausted");
  });
  it("sizes selected current input, not raw history which DS4 can discard", () => {
    const estimator = { estimateTextTokens: (text) => text.length };
    const historyTokens = 80;
    const minimum = 470;
    const oldRawSizing = "x".repeat(minimum - historyTokens);
    expect(selectedCurrentUserTokens([{ role: "user", content: oldRawSizing }], estimator)).toBeLessThan(minimum);
    const sized = buildHighInput(estimator, "probe:", "abc", minimum);
    expect(selectedCurrentUserTokens([{ role: "assistant", content: "history" },
      { role: "user", content: sized }], estimator)).toBeGreaterThanOrEqual(minimum);
    expect(selectedCurrentUserTokens([{ role: "user", content: [{ type: "text", text: sized }] }], estimator))
      .toBeGreaterThanOrEqual(minimum);
    expect(selectedCurrentUserTokens([{ role: "assistant", content: sized }], estimator)).toBe(0);
    expect(() => buildHighInput(estimator, "", "", minimum)).toThrow("Invalid synthetic high-input sizing");
  });
  it("counts attempted calls and rejects per-request and global input and character overruns", () => {
    const budget = { calls: 0, input: 0, chars: 0 };
    reserve(budget, 1, 1);
    expect(budget).toEqual({ calls: 1, input: 1, chars: 1 });
    for (const [input, chars] of [[0, 1], [LIMITS.inputPerCall + 1, 1], [1, LIMITS.charsPerCall + 1]]) {
      expect(() => reserve(budget, input, chars)).toThrow("BEFORE transport");
    }
    expect(budget).toEqual({ calls: 1, input: 1, chars: 1 });
    expect(() => reserve({ calls: LIMITS.calls, input: 0, chars: 0 }, 1, 1)).toThrow("BEFORE transport");
    expect(() => reserve({ calls: 1, input: LIMITS.inputTotal, chars: 0 }, 1, 1)).toThrow("BEFORE transport");
    expect(() => reserve({ calls: 1, input: 0, chars: LIMITS.charsTotal }, 1, 1)).toThrow("BEFORE transport");
  });
});
