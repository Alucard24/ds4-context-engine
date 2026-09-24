import { describe, expect, it } from "vitest";
import { LIMITS, main, readyForHigh, reserve } from "../../scripts/verify-model-aware-safety-session.mjs";

describe("bounded provider-usage withdrawal probe", () => {
  it("does not contact a provider without --live", async () => {
    expect(await main([])).toMatchObject({ mode: "dry-run",
      occupancyThreshold: 53_760, limits: { calls: 15, perCall: 80_000, total: 350_000 } });
    await expect(main(["--other"])).rejects.toThrow("Only --live");
  });
  it("gates high-occupancy transport on eight accepted samples, not eight observed turns", () => {
    expect(readyForHigh(Array.from({ length: 8 }, (_, index) => ({
      status: "ok", autoTune: "insufficient-samples", accepted: Math.min(index, 6),
    })))).toBe(false);
    expect(readyForHigh([{ status: "ok", autoTune: "expanded", accepted: 8 }])).toBe(true);
    expect(readyForHigh([{ status: "scenario-failed", autoTune: "expanded", accepted: 8 }])).toBe(false);
  });
  it("rejects attempted requests over the per-call, aggregate or count caps", () => {
    const budget = { calls: 0, tokens: 0 };
    expect(() => reserve(budget, LIMITS.perCall + 1)).toThrow();
    expect(budget.calls).toBe(0);
    for (let index = 0; index < LIMITS.calls; index++) reserve(budget, 1);
    expect(() => reserve(budget, 1)).toThrow();
    expect(() => reserve({ calls: 1, tokens: LIMITS.total - 1 }, 2)).toThrow();
  });
});
