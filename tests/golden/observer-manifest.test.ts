import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { calculateContextBudget } from "../../src/core/budget-manager.ts";
import { createModelProfile } from "../../src/core/model-profile.ts";
import { buildObserverManifest } from "../../src/manifest/observer.ts";

describe("observer manifest golden contract", () => {
  it("remains deterministic", () => {
    const profile = createModelProfile({
      provider: "test",
      id: "model",
      contextWindow: 128_000,
      maxTokens: 16_384,
    });
    const actual = buildObserverManifest({
      id: "manifest-golden",
      sessionId: "session-golden",
      branchLeafId: "leaf-golden",
      profile,
      budget: calculateContextBudget(profile, DEFAULT_CONFIG.context),
      systemPrompt: "Stable system prompt",
      tools: [{
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        source: "builtin",
      }],
      messages: [
        { role: "user", content: "First request" },
        { role: "assistant", content: [{ type: "text", text: "Response" }] },
        { role: "user", content: "Current request" },
      ],
      messageSources: [
        { sourceId: "e1", role: "user", mappingReason: "exact" },
        { sourceId: "e2", role: "assistant", mappingReason: "exact" },
        { sourceId: "e3", role: "user", mappingReason: "exact" },
      ],
      excludedSources: [{
        sourceId: "old",
        role: "user",
        tokens: 5,
        kind: "history",
        reason: "compacted",
      }],
      summaryIds: [],
      piReportedContextTokens: 123,
      policyVersion: "1",
      plannerVersion: "observer-v1",
      createdAt: 456,
    });
    const expected = JSON.parse(
      readFileSync(join(import.meta.dirname, "observer-manifest.json"), "utf8"),
    ) as unknown;

    expect(actual).toEqual(expected);
  });
});
