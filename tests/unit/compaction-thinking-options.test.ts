import { describe, expect, it } from "vitest";
import { compactionThinkingOptions } from "../../src/pi-adapter/summary-generator.ts";

describe("compactionThinkingOptions", () => {
  it("returns an empty object for undefined or off", () => {
    expect(compactionThinkingOptions("anthropic-messages", undefined)).toEqual({});
    expect(compactionThinkingOptions("anthropic-messages", "off")).toEqual({});
    expect(compactionThinkingOptions("openai-responses", "off")).toEqual({});
    expect(compactionThinkingOptions("google-generative-ai", "medium")).toEqual({});
  });

  it("maps levels to anthropic thinking options", () => {
    expect(compactionThinkingOptions("anthropic-messages", "low")).toEqual({
      thinkingEnabled: true,
      effort: "low",
    });
    expect(compactionThinkingOptions("anthropic-messages", "minimal")).toEqual({
      thinkingEnabled: true,
      effort: "low",
    });
    expect(compactionThinkingOptions("anthropic-messages", "medium")).toEqual({
      thinkingEnabled: true,
      effort: "medium",
    });
    expect(compactionThinkingOptions("anthropic-messages", "xhigh")).toEqual({
      thinkingEnabled: true,
      effort: "xhigh",
    });
    expect(compactionThinkingOptions("anthropic-messages", "max")).toEqual({
      thinkingEnabled: true,
      effort: "max",
    });
  });

  it("maps levels to openai-compatible reasoning effort", () => {
    expect(compactionThinkingOptions("openai-responses", "low")).toEqual({
      samplingParams: { reasoning_effort: "low" },
    });
    expect(compactionThinkingOptions("openai-responses", "medium")).toEqual({
      samplingParams: { reasoning_effort: "medium" },
    });
    expect(compactionThinkingOptions("openai-completions", "high")).toEqual({
      samplingParams: { reasoning_effort: "high" },
    });
    expect(compactionThinkingOptions("openai-responses", "xhigh")).toEqual({
      samplingParams: { reasoning_effort: "high" },
    });
    expect(compactionThinkingOptions("openai-responses", "max")).toEqual({
      samplingParams: { reasoning_effort: "high" },
    });
  });

  it("ignores unsupported APIs", () => {
    expect(compactionThinkingOptions("google-generative-ai", "high")).toEqual({});
    expect(compactionThinkingOptions("bedrock-converse", "high")).toEqual({});
    expect(compactionThinkingOptions("pi-messages", "high")).toEqual({});
  });
});
