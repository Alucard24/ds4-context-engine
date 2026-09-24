import { describe, expect, it } from "vitest";
import { SessionManager, buildSessionContext } from "@earendil-works/pi-coding-agent";
import { O200K_ESTIMATOR } from "../../src/pi-adapter/bpe-token-estimator.ts";
import { buildHighInput, MIN_SELECTED_USER_TOKENS, seed,
  selectedCurrentUserTokens } from "../../scripts/verify-model-aware-triad.mjs";
import { CAPS, LIMITS, LIVE_AUTHORIZED, main, reserve,
  untunedTail } from "../../scripts/verify-model-aware-triad-withdrawal.mjs";
import { LIMITS as TERRA_LIMITS, main as terraMain } from "../../scripts/verify-model-aware-terra-withdrawal.mjs";

describe("native-model withdrawal probe preflight (no provider calls)", () => {
  it("plans all three models with the authorized bounded limits, without transport in dry run", async () => {
    expect(await main([])).toMatchObject({ mode: "dry-run", limits: LIMITS, caps: CAPS });
    expect(LIMITS).toEqual({ calls: 39, inputPerCall: 600_000, inputTotal: 3_800_000,
      charsPerCall: 2_500_000, charsTotal: 11_000_000 });
    expect(LIVE_AUTHORIZED).toBe(false);
    await expect(main(["--live"])).rejects.toThrow("New explicit numeric provider budget required");
    await expect(main(["--unknown"])).rejects.toThrow("Only --live");
  });

  it("requires real category expansion, not merely an expanded status", () => {
    expect(untunedTail({ nominalRecentTailTokens: 64_000 }, 1)).toBe(64_000);
    expect(untunedTail({ nominalRecentTailTokens: 64_000 }, 0.99)).toBe(64_646);
    expect(untunedTail({ nominalRecentTailTokens: 64_000 }, 0)).toBeUndefined();
    expect(CAPS.recentTailTokens).toBeGreaterThan(64_000);
  });

  it("sizes a selected 470k-token turn within the native per-call/character caps", () => {
    const manager = SessionManager.inMemory();
    const model = { api: "openai-completions", provider: "openrouter", id: "openai/gpt-6-sol" };
    seed(manager, model);
    const canonical = buildSessionContext(manager.getEntries(), manager.getLeafId()).messages;
    expect(canonical.length).toBeGreaterThanOrEqual(60);
    const block = Array.from({ length: 155 }, (_, i) =>
      `record-700-${i.toString(36).padStart(3, "0")}-status-ok`).join(" ") + "\n";
    const prompt = buildHighInput(O200K_ESTIMATOR, "Synthetic high occupancy. Reply only OK.\n", block);
    const raw = [...canonical, { role: "user", content: prompt, timestamp: 0 }];
    expect(selectedCurrentUserTokens(raw, O200K_ESTIMATOR)).toBeGreaterThanOrEqual(MIN_SELECTED_USER_TOKENS);
    const highEstimate = O200K_ESTIMATOR.estimateMessagesTokens(raw) + 12_000;
    const shortEstimate = O200K_ESTIMATOR.estimateMessagesTokens([...canonical,
      { role: "user", content: "Why does cobalt-713 expire in 42 days? Reply only OK.", timestamp: 0 }]) + 12_000;
    expect(highEstimate).toBeLessThan(LIMITS.inputPerCall);
    expect(JSON.stringify(raw).length).toBeLessThan(LIMITS.charsPerCall);
    // The *withdrawal* request resends the high input in Pi/DS4 context.
    // It is NOT a short call even though its new user turn is short.
    const followup = [...raw,
      { role: "assistant", content: [{ type: "text", text: "OK" }], timestamp: 0 },
      { role: "user", content: "After the high-usage call, reply only OK.", timestamp: 0 }];
    expect(O200K_ESTIMATOR.estimateMessagesTokens(followup) + 12_000).toBeGreaterThan(450_000);
    expect(JSON.stringify(followup).length).toBeGreaterThan(1_000_000);
    const shortChars = JSON.stringify([...canonical,
      { role: "user", content: "Why does cobalt-713 expire in 42 days? Reply only OK.", timestamp: 0 }]).length;
    // Historical caps are intentionally NOT asserted sufficient for all three:
    // the live round demonstrated that the cumulative budget was too small.
    expect(3 * (11 * (shortEstimate + 5_000) + highEstimate * 2)).toBeGreaterThan(LIMITS.inputTotal);
    expect(3 * (11 * (shortChars + 10_000) + JSON.stringify(raw).length
      + JSON.stringify(followup).length)).toBeGreaterThan(LIMITS.charsTotal);
    const followupEstimate = O200K_ESTIMATOR.estimateMessagesTokens(followup) + 12_000;
    expect(11 * (shortEstimate + 8_000) + highEstimate + followupEstimate)
      .toBeLessThan(TERRA_LIMITS.inputTotal);
    expect(11 * (shortChars + 30_000) + JSON.stringify(raw).length
      + JSON.stringify(followup).length).toBeLessThan(TERRA_LIMITS.charsTotal);
  }, 15_000);

  it("locks the used Terra-only authorization while retaining the reproducible dry run", async () => {
    expect(await terraMain([])).toMatchObject({ mode: "dry-run", model: "openrouter/openai/gpt-5.6-terra" });
    expect(TERRA_LIMITS).toEqual({ calls: 13, inputPerCall: 600_000, inputTotal: 1_900_000,
      charsPerCall: 2_500_000, charsTotal: 6_000_000 });
    await expect(terraMain(["--live"])).rejects.toThrow("New explicit numeric Terra-only provider budget required");
    await expect(terraMain(["--unknown"])).rejects.toThrow("Only --live");
  });

  it("counts all attempted provider requests and stops before exceeding any cap", () => {
    const budget = { calls: 0, input: 0, chars: 0 };
    reserve(budget, 1, 1);
    expect(budget).toEqual({ calls: 1, input: 1, chars: 1 });
    for (const [input, chars] of [[0, 1], [LIMITS.inputPerCall + 1, 1], [1, LIMITS.charsPerCall + 1]]) {
      expect(() => reserve(budget, input, chars)).toThrow("BEFORE provider transport");
    }
    expect(() => reserve({ calls: LIMITS.calls, input: 0, chars: 0 }, 1, 1)).toThrow();
    expect(() => reserve({ calls: 0, input: LIMITS.inputTotal, chars: 0 }, 1, 1)).toThrow();
    expect(() => reserve({ calls: 0, input: 0, chars: LIMITS.charsTotal }, 1, 1)).toThrow();
    expect(budget).toEqual({ calls: 1, input: 1, chars: 1 });
  });
});
