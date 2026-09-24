import { describe, expect, it } from "vitest";
import { LIMITS, PREVIOUS, main, reserve } from "../../scripts/verify-model-aware-live-tool.mjs";

describe("per-provider-request tool-cycle budget", () => {
  it("requires explicit --live and retains earlier attempted-call counters", async () => {
    expect(await main([])).toMatchObject({ mode: "dry-run", previous: { calls: 11, tokens: 292_818 } });
    await expect(main(["--other"])).rejects.toThrow("Only --live");
  });
  it("blocks additional tool-continuation transports when any limit is reached", () => {
    const budget = { ...PREVIOUS };
    reserve(budget, 13_000);
    expect(budget).toEqual({ calls: 12, tokens: 305_818 });
    expect(() => reserve(budget, LIMITS.perCall + 1)).toThrow();
    expect(() => reserve({ calls: budget.calls, tokens: LIMITS.total - 1 }, 2)).toThrow();
    expect(() => reserve({ calls: LIMITS.calls, tokens: budget.tokens }, 1)).toThrow();
  });
});
