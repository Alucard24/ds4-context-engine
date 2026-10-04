import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "ds4-context-core/config/config";
import type { ContextManifest } from "ds4-context-core/manifest/context-manifest";
import { buildPersistedManifestProjection } from "ds4-context-core/manifest/context-manifest-storage";
import { planManagedContext } from "ds4-context-core/planner/context-planner";
import { registerContextCommand } from "../../src/extension/commands.ts";
import type { Ds4ContextRuntime, RuntimeDiagnostics } from "../../src/extension/runtime.ts";

function fixture(historyItems = 0): ContextManifest {
  const messages = [
    { role: "assistant", content: "PRIVATE_NATIVE_BODY background" },
    { role: "user", content: `PRIVATE_NATIVE_BODY old turn ${"x".repeat(240_000)}` },
    { role: "assistant", content: "PRIVATE_NATIVE_BODY old reply" },
    { role: "user", content: "recent request" },
    { role: "assistant", content: "recent reply" },
    { role: "user", content: "current request" },
  ];
  const plan = planManagedContext({
    messages, fixedTokens: 13_461,
    budget: {
      contextWindow: 1_050_000, outputReserve: 4_096, safetyMargin: 1_024,
      modelInputHardLimit: 182_266, hardInputLimit: 182_266, softInputLimit: 182_266,
      preferredInputTarget: 148_437, activeInputBudget: 148_437,
    },
    config: { ...DEFAULT_CONFIG.context, mode: "managed", recentTailTokens: 49_895 },
  });
  return {
    schemaVersion: 1, id: "synthetic-manifest", sessionId: "synthetic-session", provider: "test", model: "test",
    contextWindow: 1_050_000, outputReserve: 4_096, hardInputLimit: 182_266,
    targetInputTokens: 148_437, estimatedInputTokens: 13_500,
    included: [], excluded: [
      ...Array.from({ length: historyItems }, (_, index) => ({
        kind: "history" as const, sourceId: `historical-${index}`, tokens: 10,
        reason: "Excluded by Pi branch/compaction context reconstruction",
      })),
      ...plan.excluded,
    ],
    summaryIds: [], retrievedEventIds: [], projectSnippets: [],
    composition: { systemTokens: 13_461, toolTokens: 0, messageTokens: 39, messageCount: 3, toolCount: 0 },
    planning: plan.planning, policyVersion: "test", plannerVersion: "test", promptHash: "test", createdAt: 1,
  };
}

function command(manifest: ContextManifest) {
  const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
  const notifications: string[] = [];
  const pi = { registerCommand: (name: string, registered: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) => commands.set(name, registered) };
  const runtime = { diagnostics: () => ({ lastManifest: manifest } as RuntimeDiagnostics) };
  const context = { hasUI: true, ui: { notify: (message: string) => notifications.push(message) } };
  registerContextCommand(pi as unknown as ExtensionAPI, runtime as unknown as Ds4ContextRuntime);
  return async (args: string) => {
    await commands.get("context")!.handler(args, context as unknown as ExtensionCommandContext);
    return notifications.at(-1)!;
  };
}

describe("compact native-group command diagnostics", () => {
  it("renders two native exclusions, not 68,000 historical item rows", async () => {
    const output = await command(fixture(68_000))("excluded");
    expect(output).toContain("Native planner exclusions: 2 groups / 3 messages");
    expect(output).toContain("group:1-2 turn");
    expect(output).toContain("oversized=yes predecessor=no");
    expect(output).toContain("reason=recent-tail-limit; rescue=not-immediate-predecessor");
    expect(output).toContain("group:0-0 prefix");
    expect(output).toContain("Other exclusion items: 68,000");
    expect(output).toContain("/context excluded all");
    expect(output).not.toContain("historical-");
    expect(output).not.toContain("PRIVATE_NATIVE_BODY");
    expect(output.length).toBeLessThan(2_000);
  });

  it("makes the oversized group and rescue reason available directly in explain", async () => {
    const output = await command(fixture(68_000))("explain");
    expect(output).toContain("Original messages:    6");
    expect(output).toContain("Message target:       134,976");
    expect(output).toContain("group:1-2 turn");
    expect(output).toContain("rescue=not-immediate-predecessor");
    expect(output).not.toContain("historical-");
    expect(output).not.toContain("PRIVATE_NATIVE_BODY");
    expect(output.length).toBeLessThan(2_000);
  });

  it("preserves group summaries and complete counts through a persisted excluded rollup", async () => {
    const manifest = fixture(68_000);
    const projection = buildPersistedManifestProjection(manifest);
    expect(projection.status).toBe("stored");
    if (projection.status !== "stored") throw new Error("synthetic projection was not stored");
    expect(projection.inventory.completeness).toBe("excluded-rollup");
    expect(projection.manifest.planning?.excludedNativeGroups).toEqual(manifest.planning?.excludedNativeGroups);
    const output = await command(projection.manifest)("excluded");
    expect(output).toContain("256 / 68,003 excluded details retained");
    expect(output).toContain("Native planner exclusions: 2 groups / 3 messages");
    expect(output).toContain("Other exclusion items: 68,000");
    expect(output.length).toBeLessThan(2_000);
  });

  it("retains explicit item-level provenance and bounds legacy default output", async () => {
    const manifest = fixture(70);
    const { excludedNativeGroups: _details, ...legacy } = manifest.planning!;
    manifest.planning = legacy;
    const run = command(manifest);
    const compact = await run("excluded");
    expect(compact).toContain("Native group diagnostics unavailable");
    expect(compact).toContain("Item details: 40 / 73 shown");
    expect(compact).not.toContain("source=historical-69");
    const full = await run("excluded all");
    expect(full).toContain("source=historical-69");
    expect(full).toContain("group=group:1-2");
    expect(full).not.toContain("Item details:");
    expect(full).not.toContain("PRIVATE_NATIVE_BODY");
  });

  it("rejects misspelled detail modes instead of silently dumping all items", async () => {
    const output = await command(fixture(68_000))("excluded everything");
    expect(output).toContain("Usage: /context included | /context excluded [all]");
    expect(output).not.toContain("historical-");
  });
});
