import { describe, expect, it } from "vitest";
import { adaptiveArtifactConfig } from "ds4-context-core/artifacts/adaptive-budget";
import { createDefaultConfig } from "ds4-context-core/config/config";

const config = { ...createDefaultConfig().artifacts, adaptiveBudget: true };
const output = { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "x".repeat(20_000) }] };

describe("adaptive artifact budget", () => {
  it("preserves defaults for disabled, missing and invalid budget inputs", () => {
    const disabled = { ...config, adaptiveBudget: false };
    expect(adaptiveArtifactConfig(disabled, [output], { inputTokens: 0, fixedTokens: 0 })).toBe(disabled);
    for (const budget of [undefined, { inputTokens: NaN, fixedTokens: 0 }, { inputTokens: 3, fixedTokens: -1 }]) {
      expect(adaptiveArtifactConfig(config, [output], budget)).toBe(config);
    }
  });

  it("shares available capacity across candidate results and subtracts fixed/history/image costs", () => {
    const one = adaptiveArtifactConfig(config, [output], { inputTokens: 6000, fixedTokens: 2000 });
    const two = adaptiveArtifactConfig(config, [output, output], { inputTokens: 6000, fixedTokens: 2000 });
    const crowded = adaptiveArtifactConfig(config, [
      { role: "user", content: "u".repeat(8000) }, output,
      { ...output, content: [...output.content, { type: "image", data: "image" }] },
    ], { inputTokens: 6000, fixedTokens: 2000 });
    expect(two.maxInlineToolResultChars).toBeLessThan(one.maxInlineToolResultChars);
    expect(crowded.maxInlineToolResultChars).toBeLessThan(two.maxInlineToolResultChars);
    expect(config.maxInlineToolResultChars).toBe(12000);
  });

  it("never enlarges configured caps, even below the metadata floor", () => {
    for (const cap of [0, 800, 1600, 12000]) {
      const custom = { ...config, maxInlineToolResultChars: cap, excerptChars: 12 };
      for (const inputTokens of [0, 1000, 1_000_000]) {
        const actual = adaptiveArtifactConfig(custom, [output], { inputTokens, fixedTokens: 0 });
        expect(actual.maxInlineToolResultChars).toBeLessThanOrEqual(cap);
        expect(actual.excerptChars).toBeLessThanOrEqual(12);
        expect(actual.maxArtifactBytes).toBe(custom.maxArtifactBytes);
        expect(actual.maxSearchBytes).toBe(custom.maxSearchBytes);
      }
    }
    expect(adaptiveArtifactConfig(config, [output], { inputTokens: 0, fixedTokens: 0 }).maxInlineToolResultChars).toBe(1600);
  });
});
