import { describe, expect, it } from "vitest";
import { LIMITS, PREVIOUS, main, reserve } from "../../scripts/verify-model-aware-compaction-session.mjs";

describe("bounded Pi compaction-boundary probe", () => {
  it("requires --live and carries the previous authorized usage", async () => {
    expect(await main([])).toMatchObject({ mode: "dry-run", previous: { calls: 9, tokens: 169_006 } });
    await expect(main(["--unexpected"])).rejects.toThrow("Only --live");
  });
  it("reserves at most one additional request under the same aggregate limit", () => {
    const budget = { ...PREVIOUS };
    reserve(budget, 13_000);
    expect(budget).toEqual({ calls: 10, tokens: 182_006 });
    expect(() => reserve(budget, LIMITS.perCall + 1)).toThrow();
    expect(() => reserve({ calls: LIMITS.calls, tokens: budget.tokens }, 1)).toThrow();
    expect(() => reserve({ calls: budget.calls, tokens: LIMITS.total - 1 }, 2)).toThrow();
  });
});
