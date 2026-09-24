import { describe, expect, it } from "vitest";
import { LIMITS, main, reserve } from "../../scripts/verify-model-aware-calibrated-session.mjs";

describe("bounded calibrated live-session probe", () => {
  it("is dry-run by default and rejects unknown arguments before provider setup", async () => {
    expect(await main([])).toMatchObject({ mode: "dry-run", limits: { calls: 16, perCall: 80_000, total: 600_000 } });
    await expect(main(["--unknown"])).rejects.toThrow("Only --live");
  });

  it("charges attempted requests before transport and fails at per-call, count and total limits", () => {
    const budget = { calls: 0, tokens: 0 };
    expect(() => reserve(budget, LIMITS.perCall + 1)).toThrow();
    expect(budget.calls).toBe(0);
    for (let i = 0; i < LIMITS.calls; i++) reserve(budget, 1);
    expect(() => reserve(budget, 1)).toThrow();
    expect(() => reserve({ calls: 1, tokens: LIMITS.total - 5 }, 6)).toThrow();
  });
});
