import { describe, expect, it } from "vitest";
import { SessionManager, buildSessionContext } from "@earendil-works/pi-coding-agent";
import { O200K_ESTIMATOR } from "../../src/pi-adapter/bpe-token-estimator.ts";
import { buildHighInput, LIMITS, MIN_SELECTED_USER_TOKENS,
  seed, selectedCurrentUserTokens } from "../../scripts/verify-model-aware-triad.mjs";
import { PREVIOUS, PREVIOUS_LARGE, main } from "../../scripts/verify-model-aware-triad-followup.mjs";

describe("triad retrieval/tool follow-up preflight", () => {
  it("is dry-run by default, accounts for the prior round and disallows unknown args", async () => {
    expect(await main([])).toMatchObject({ mode: "dry-run", previous: PREVIOUS, maximumAdditionalCalls: 9 });
    expect(PREVIOUS.calls + 9).toBeLessThanOrEqual(LIMITS.calls);
    expect(PREVIOUS.input).toBe(1_433_445);
    expect(PREVIOUS.chars).toBe(3_679_430);
    expect(await main(["--plan-large"])).toMatchObject({ mode: "dry-run-large", previous: PREVIOUS_LARGE,
      maximumAdditionalCalls: 3 });
    expect(PREVIOUS_LARGE).toEqual({ calls: 39, input: 2_115_378, chars: 5_632_585 });
    expect(PREVIOUS_LARGE.calls + 3).toBe(LIMITS.calls);
    await expect(main(["--retry"])).rejects.toThrow("Only --live");
    await expect(main(["--live"])).rejects.toThrow("authorization exhausted");
    await expect(main(["--live-large-only"])).rejects.toThrow("authorization exhausted");
  });
  it("seeds a synthetic branch beyond the default 64k recent-tail ceiling", () => {
    const manager = SessionManager.inMemory();
    const model = { api: "openai-completions", provider: "openrouter", id: "openai/gpt-6-sol" };
    const ids = seed(manager, model, 70);
    const canonical = buildSessionContext(manager.getEntries(), manager.getLeafId()).messages;
    expect(canonical.length).toBeGreaterThan(140);
    expect(ids.decisionId).toBeTruthy();
    expect(ids.toolEntryId).toBeTruthy();
    expect(O200K_ESTIMATOR.estimateMessagesTokens(canonical)).toBeGreaterThan(64_000);
  });
  it("keeps a 470k-token selected current turn inside per-request preflight limits", () => {
    const manager = SessionManager.inMemory();
    const model = { api: "openai-completions", provider: "openrouter", id: "openai/gpt-6-sol" };
    seed(manager, model, 70);
    const block = Array.from({ length: 155 }, (_, i) => `record-700-${i.toString(36).padStart(3, "0")}-status-ok`).join(" ") + "\n";
    const prompt = buildHighInput(O200K_ESTIMATOR,
      "Synthetic native-window input measurement. Reply only OK.\n", block);
    const raw = [...buildSessionContext(manager.getEntries(), manager.getLeafId()).messages,
      { role: "user", content: prompt, timestamp: 0 }];
    expect(selectedCurrentUserTokens(raw, O200K_ESTIMATOR)).toBeGreaterThanOrEqual(MIN_SELECTED_USER_TOKENS);
    expect(O200K_ESTIMATOR.estimateMessagesTokens(raw) + 12_000).toBeLessThan(LIMITS.inputPerCall);
    expect(JSON.stringify(raw).length).toBeLessThan(LIMITS.charsPerCall);
  });
});
