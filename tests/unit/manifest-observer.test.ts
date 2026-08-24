import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { calculateContextBudget } from "../../src/core/budget-manager.ts";
import { createModelProfile } from "../../src/core/model-profile.ts";
import { buildObserverManifest } from "../../src/manifest/observer.ts";

function build(parameters: Record<string, unknown>) {
  const profile = createModelProfile({
    provider: "test",
    id: "model",
    contextWindow: 128_000,
    maxTokens: 16_384,
  });
  return buildObserverManifest({
    id: "manifest-1",
    sessionId: "session-1",
    branchLeafId: "leaf-1",
    profile,
    budget: calculateContextBudget(profile, DEFAULT_CONFIG.context),
    systemPrompt: "private system instructions",
    tools: [{ name: "read", description: "Read a file", parameters, source: "builtin" }],
    messages: [
      { role: "user", content: "old private request" },
      { role: "assistant", content: [{ type: "text", text: "private response" }] },
      { role: "user", content: "current private request" },
    ],
    messageSources: [
      { sourceId: "entry-1", role: "user", mappingReason: "exact" },
      { sourceId: "entry-2", role: "assistant", mappingReason: "exact" },
      { sourceId: "entry-3", role: "user", mappingReason: "exact" },
    ],
    excludedSources: [{
      sourceId: "entry-old",
      role: "user",
      tokens: 10,
      kind: "history",
      reason: "compacted",
    }],
    summaryIds: ["summary-1"],
    piReportedContextTokens: 500,
    policyVersion: "1",
    plannerVersion: "observer-v1",
    createdAt: 123,
  });
}

describe("observer Context Manifest", () => {
  it("accounts for system, tools, messages, provenance, and current request", () => {
    const manifest = build({ type: "object", properties: { path: { type: "string" } } });

    expect(manifest.included.filter((item) => item.kind === "system")).toHaveLength(1);
    expect(manifest.included.filter((item) => item.kind === "tool")).toHaveLength(1);
    expect(manifest.included.filter((item) => item.kind === "current")).toHaveLength(1);
    expect(manifest.included.find((item) => item.kind === "current")?.sourceId).toBe("entry-3");
    expect(manifest.excluded).toHaveLength(1);
    expect(manifest.summaryIds).toEqual(["summary-1"]);
    expect(manifest.estimatedInputTokens).toBe(
      manifest.composition.systemTokens + manifest.composition.toolTokens + manifest.composition.messageTokens,
    );
  });

  it("produces a stable hash without persisting prompt content", () => {
    const first = build({ b: 2, a: 1 });
    const second = build({ a: 1, b: 2 });

    expect(first.promptHash).toBe(second.promptHash);
    const persisted = JSON.stringify(first);
    expect(persisted).not.toContain("private system instructions");
    expect(persisted).not.toContain("current private request");
    expect(persisted).not.toContain("private response");
  });
});
