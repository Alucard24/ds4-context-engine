import { describe, expect, it } from "vitest";
import {
  MAX_CALLS, MAX_CHARS, MAX_COMPARISON_CALLS, MAX_COMPARISON_CHARS,
  MODEL_ID, COMPARISON_MODELS, SIZES, REPEATS, SYSTEM_PROMPT, main, plan, comparisonPlan,
} from "../../scripts/compare-ds4-manifest-usage.mjs";

describe("isolated DS4 manifest usage pilot", () => {
  it("requires explicit --live and preflights the exact authorized model and bounds without transport", async () => {
    const dry = await main([]);
    expect(dry).toMatchObject({ mode: "dry-run", model: `openrouter/${MODEL_ID}` });
    expect(dry.budget.calls).toBe(SIZES.length * REPEATS);
    expect(dry.budget.calls).toBeLessThanOrEqual(MAX_CALLS);
    expect(dry.budget.chars).toBe(SIZES.reduce((total, size) =>
      total + REPEATS * (size + SYSTEM_PROMPT.length), 0));
    expect(dry.budget.chars).toBeLessThanOrEqual(MAX_CHARS);
    await expect(main(["--model", "openrouter/openai/gpt-6-luna"])).rejects.toThrow();
    await expect(main(["--comparison", "--comparison"])).rejects.toThrow();
  });

  it("caps the separately approved Luna/Terra run across both models before transport", async () => {
    const dry = await main(["--comparison"]);
    expect(dry.mode).toBe("dry-run");
    expect(dry.budget).toEqual(comparisonPlan());
    expect(dry.budget.models).toEqual(COMPARISON_MODELS.map((id) => `openrouter/${id}`));
    expect(dry.budget.calls).toBe(24);
    expect(dry.budget.chars).toBe(221_136);
    expect(dry.budget.calls).toBeLessThanOrEqual(MAX_COMPARISON_CALLS);
    expect(dry.budget.chars).toBeLessThanOrEqual(MAX_COMPARISON_CHARS);
  });

  it("refuses invalid, oversized, or excess sample plans before any provider request", () => {
    expect(() => plan([0])).toThrow();
    expect(() => plan(Array(13).fill(512))).toThrow();
    expect(() => plan([120_000])).toThrow();
    expect(plan([512, 4096])).toMatchObject({ calls: 2, chars: 4608 + SYSTEM_PROMPT.length * 2 });
  });
});
