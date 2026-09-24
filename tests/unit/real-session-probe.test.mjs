import { describe, expect, it } from "vitest";
import {
  main, reserve, MAX_CALLS, MAX_ESTIMATED_INPUT_PER_CALL, MAX_ESTIMATED_INPUT_TOTAL,
} from "../../scripts/verify-model-aware-real-session.mjs";

describe("bounded real-session probe (no provider transport)", () => {
  it("requires --live explicitly and advertises the authorized limits", async () => {
    expect(await main([])).toMatchObject({
      mode: "dry-run",
      limits: { calls: 16, estimatedInputPerCall: 64_000, estimatedInputTotal: 250_000 },
    });
    await expect(main(["--comparison"])).rejects.toThrow("Only --live");
    await expect(main(["--live-long-only", "--previous-calls=9", "--previous-estimated=250000"]))
      .rejects.toThrow("Valid previous budget counters");
  });

  it("reserves each attempted call before dispatch and refuses all three budget overruns", () => {
    const budget = { calls: 0, estimatedInput: 0 };
    expect(() => reserve(budget, MAX_ESTIMATED_INPUT_PER_CALL + 1)).toThrow();
    expect(budget).toEqual({ calls: 0, estimatedInput: 0 });
    for (let index = 0; index < MAX_CALLS; index++) reserve(budget, 1_000);
    expect(() => reserve(budget, 1_000)).toThrow();
    const nearTotal = { calls: 1, estimatedInput: MAX_ESTIMATED_INPUT_TOTAL - 100 };
    expect(() => reserve(nearTotal, 101)).toThrow();
    expect(nearTotal.calls).toBe(1);
  });
});
