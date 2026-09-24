import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIZES,
  MAX_CALLS,
  MAX_CHARS,
  SYSTEM_PROMPT,
  compareEstimate,
  parseArgs,
  preflight,
  probe,
  summarize,
  syntheticUserPrompt,
} from "../../scripts/compare-provider-token-drift.mjs";

describe("bounded provider drift probe", () => {
  it("never starts a live run without an explicit flag and model", () => {
    expect(parseArgs(["--model", "openai-codex/gpt-5.4-mini"])).toMatchObject({ live: false, sizes: DEFAULT_SIZES });
    expect(() => parseArgs(["--live"])).toThrow();
    expect(() => parseArgs(["--model", "openrouter/one", "--model", "openrouter/one"])).toThrow();
    expect(() => parseArgs(["--model", "openrouter/one", "--sizes", "1,abc"])).toThrow();
  });

  it("counts all input characters and calls before transport", () => {
    const models = ["a/one", "b/two", "c/three"];
    const budget = preflight(models, DEFAULT_SIZES);
    expect(budget).toEqual({
      calls: 9,
      chars: 3 * (DEFAULT_SIZES.reduce((sum, n) => sum + n, 0) + SYSTEM_PROMPT.length * DEFAULT_SIZES.length),
    });
    expect(budget.calls).toBeLessThanOrEqual(MAX_CALLS);
    expect(budget.chars).toBeLessThanOrEqual(MAX_CHARS);
    expect(() => preflight([...models, "d/four", "e/five"], DEFAULT_SIZES)).toThrow();
    expect(() => preflight(models, [100, 4_000, 90_000])).toThrow();
    expect(syntheticUserPrompt(48_000)).toHaveLength(48_000);
  });

  it("calculates raw drift, required headroom and adjacent slopes, without mixing models", () => {
    expect(compareEstimate(125, 100)).toEqual({
      estimatedTokens: 100, actualToEstimate: 1.25, residualTokens: 25, underestimationPctOfActual: 20,
    });
    expect(compareEstimate(80, 100).underestimationPctOfActual).toBe(0);
    expect(() => compareEstimate(0, 100)).toThrow();
    const row = (name, size, actual, chars, bpe) => ({
      provider: "p", model: name, userChars: size, status: "ok", actualInputTokens: actual,
      estimators: { "chars-v1": compareEstimate(actual, chars), "o200k-base-v1": compareEstimate(actual, bpe) },
    });
    const report = summarize([row("m", 200, 125, 100, 110), row("m", 500, 230, 200, 210), row("other", 200, 80, 100, 90), { status: "request-failed" }]);
    expect(report["p/m"].estimators["chars-v1"]).toMatchObject({
      medianActualToEstimate: 1.2,
      worstUnderestimationTokens: 30,
      adjacentDeltaSlopes: [1.05],
    });
    expect(report["p/other"].sampleCount).toBe(1);
    expect(report["p/other"].estimators["chars-v1"].worstUnderestimationTokens).toBe(0);
  });

  it("accepts only valid positive provider usage and never logs prompt/error text", async () => {
    let requested;
    const fake = {
      getModel: () => ({ api: "openai-codex-responses" }),
      hasConfiguredAuth: () => true,
      completeSimple: async (_model, context, options) => {
        requested = { context, options };
        return {
          stopReason: "stop", responseModel: "alias", usage: {
            input: 410, cacheRead: 8, cacheWrite: 2, output: 1, cost: { total: 0.001 },
          },
        };
      },
    };
    const row = await probe(fake, "codex/m", 512);
    expect(row).toMatchObject({ status: "ok", actualInputTokens: 420, cacheReadTokens: 8, cacheWriteTokens: 2, responseModel: "alias" });
    expect(requested.context.messages[0].content).toHaveLength(512);
    expect(requested.options.maxRetries).toBe(0);
    expect(requested.options).not.toHaveProperty("maxTokens");
    expect(JSON.stringify(row)).not.toContain("Treat the following");
    fake.completeSimple = async () => { throw new Error("credential or prompt secret"); };
    expect(await probe(fake, "codex/m", 512)).toMatchObject({ status: "request-failed" });
    expect(JSON.stringify(await probe(fake, "codex/m", 512))).not.toContain("secret");
    fake.completeSimple = async () => ({ stopReason: "stop", usage: { input: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(await probe(fake, "codex/m", 512)).toMatchObject({ status: "missing-usage" });
    fake.completeSimple = async () => ({ stopReason: "stop", usage: { input: -1, cacheRead: 5, cacheWrite: 0 } });
    expect(await probe(fake, "codex/m", 512)).toMatchObject({ status: "missing-usage" });
    fake.completeSimple = async () => ({ stopReason: "stop" });
    expect(await probe(fake, "codex/m", 512)).toMatchObject({ status: "missing-usage" });
    fake.completeSimple = async () => ({ stopReason: "error", errorMessage: "You have hit your usage limit", usage: { input: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(await probe(fake, "codex/m", 512)).toMatchObject({ status: "request-failed", failureKind: "quota" });
    fake.completeSimple = async () => ({ stopReason: "pending", usage: { input: 100, cacheRead: 0, cacheWrite: 0 } });
    expect(await probe(fake, "codex/m", 512)).toMatchObject({ status: "request-failed" });
  });
});
