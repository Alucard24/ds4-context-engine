import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { registerDs4ContextEngine } from "../../src/extension/index.ts";

class FakePi {
  readonly handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  readonly commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();

  on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  registerCommand(
    name: string,
    command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
  ): void {
    this.commands.set(name, command);
  }

  registerTool(): void {}
  getActiveTools(): string[] { return []; }
  getAllTools(): unknown[] { return []; }
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function model(provider: string, id: string, contextWindow: number, maxTokens: number) {
  return {
    id,
    name: id,
    api: "openai-responses" as const,
    provider,
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

describe("DS4 advanced model awareness integration", () => {
  it("isolates calibration, adapts 32k/128k/200k budgets, and preserves privacy across provider switches", async () => {
    const root = mkdtempSync(join(tmpdir(), "ds4-model-awareness-"));
    temporaryDirectories.push(root);
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      retrieval: { exact: false, fts: false },
      project: { enabled: false },
      memory: { enabled: false },
      artifacts: { enabled: false },
      compaction: { enabled: false },
      privacy: { enabled: true, localProviders: ["local-faux"] },
      modelAwareness: {
        calibrationWindow: 8,
        minimumCalibrationSamples: 3,
        overrides: {
          "remote-faux/large-200k": {
            safetyMarginTokens: 5000,
            maxRetrievedHistoryTokens: 13000,
          },
        },
      },
    }));

    const canonicalContent = "[ds4:local-only]CANONICAL-MODEL-PRIVATE[/ds4:local-only] inspect ModelSymbol";
    const canonicalMessage = { role: "user" as const, content: canonicalContent, timestamp: 1 };
    const entry = {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-08-25T00:00:01.000Z",
      message: canonicalMessage,
    };
    const sessionFile = join(project, "session.jsonl");
    writeFileSync(sessionFile, [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "model-awareness-session",
        timestamp: "2026-08-25T00:00:00.000Z",
        cwd: project,
      }),
      JSON.stringify(entry),
    ].join("\n") + "\n");

    const notifications: string[] = [];
    const small = model("local-faux", "small-32k", 32_000, 4_096);
    const medium = model("remote-faux", "medium-128k", 128_000, 16_384);
    const large = model("remote-faux", "large-200k", 200_000, 32_768);
    const context = {
      cwd: project,
      mode: "tui",
      hasUI: true,
      ui: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => {},
      },
      sessionManager: {
        getSessionId: () => "model-awareness-session",
        getSessionFile: () => sessionFile,
        getLeafId: () => "entry-1",
        getEntries: () => [entry],
        getBranch: () => [entry],
        buildContextEntries: () => [entry],
      },
      model: small,
      scopedModels: [],
      modelRegistry: {},
      isProjectTrusted: () => true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      getContextUsage: () => ({ tokens: 100, contextWindow: 128_000, percent: 0.01 }),
      getSystemPrompt: () => "stable system",
      waitForIdle: async () => {},
    } as unknown as ExtensionContext & { model: typeof small };
    const pi = new FakePi();
    let sequence = 0;
    let clock = 1_000;
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir,
      configDirName: ".pi",
      homeDir: root,
      now: () => ++clock,
      idGenerator: () => `model-manifest-${++sequence}`,
      logSink: () => {},
    });

    await pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, context);
    const contextHandler = pi.handlers.get("context")?.[0];
    const usageHandler = pi.handlers.get("message_end")?.[0];
    const modelHandler = pi.handlers.get("model_select")?.[0];
    if (!contextHandler || !usageHandler || !modelHandler) throw new Error("Expected extension handlers");

    for (let index = 0; index < 3; index++) {
      const result = await contextHandler({ type: "context", messages: [canonicalMessage] }, context) as {
        messages?: unknown[];
      };
      expect(JSON.stringify(result.messages)).toContain("CANONICAL-MODEL-PRIVATE");
      expect(JSON.stringify(result.messages)).not.toContain("ds4:local-only");
      const estimated = runtime.latestManifest()?.estimatedInputTokens ?? 0;
      const actual = Math.max(1, Math.round(estimated * 1.2));
      const cacheRead = Math.floor(actual * 0.25);
      const cacheWrite = Math.floor(actual * 0.1);
      await usageHandler({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          usage: {
            input: actual - cacheRead - cacheWrite,
            output: 5,
            cacheRead,
            cacheWrite,
          },
        },
      }, context);
    }

    await contextHandler({ type: "context", messages: [canonicalMessage] }, context);
    const calibratedSmall = runtime.latestManifest()?.modelAwareness;
    expect(calibratedSmall?.calibration).toMatchObject({
      calibrated: true,
      acceptedSamples: 3,
      observedSamples: 3,
    });
    expect(calibratedSmall?.calibration.appliedRatio).toBeGreaterThan(1.15);
    expect(calibratedSmall?.calibration.appliedRatio).toBeLessThan(1.25);
    expect(calibratedSmall?.adaptive.nominalRecentTailTokens).toBe(12_000);
    expect(calibratedSmall?.adaptive.recentTailTokens).toBeLessThan(12_000);
    expect(calibratedSmall?.adaptive.nominalRetrievedHistoryTokens).toBe(4_000);
    expect(calibratedSmall?.calibration.cache.cacheReadTokens).toBeGreaterThan(0);

    const previousSmall = context.model;
    context.model = medium;
    await modelHandler({
      type: "model_select",
      model: medium,
      previousModel: previousSmall,
      source: "set",
    }, context);
    const remoteMedium = await contextHandler(
      { type: "context", messages: [canonicalMessage] },
      context,
    ) as { messages?: unknown[] };
    expect(JSON.stringify(remoteMedium.messages)).not.toContain("CANONICAL-MODEL-PRIVATE");
    expect(runtime.latestManifest()?.modelAwareness).toMatchObject({
      profileKey: "remote-faux/medium-128k",
      calibration: { calibrated: false, observedSamples: 0, appliedRatio: 1 },
      adaptive: {
        recentTailTokens: 24_000,
        maxRetrievedHistoryTokens: 8_000,
        maxProjectTokens: 12_000,
      },
      switch: {
        switched: true,
        profileReused: false,
        cacheDisposition: "cold-model-switch",
      },
    });

    const previousMedium = context.model;
    context.model = large;
    await modelHandler({
      type: "model_select",
      model: large,
      previousModel: previousMedium,
      source: "cycle",
    }, context);
    await contextHandler({ type: "context", messages: [canonicalMessage] }, context);
    expect(runtime.latestManifest()?.modelAwareness).toMatchObject({
      profileKey: "remote-faux/large-200k",
      overrideKeys: ["remote-faux/large-200k"],
      contextWindow: 200_000,
      safetyMarginTokens: 5_000,
      adaptive: {
        recentTailTokens: 32_000,
        maxRetrievedHistoryTokens: 13_000,
        maxProjectTokens: 20_000,
      },
    });

    const previousLarge = context.model;
    context.model = small;
    await modelHandler({
      type: "model_select",
      model: small,
      previousModel: previousLarge,
      source: "set",
    }, context);
    const localAgain = await contextHandler(
      { type: "context", messages: [canonicalMessage] },
      context,
    ) as { messages?: unknown[] };
    expect(JSON.stringify(localAgain.messages)).toContain("CANONICAL-MODEL-PRIVATE");
    expect(runtime.latestManifest()?.modelAwareness?.switch).toMatchObject({
      switched: true,
      profileReused: true,
      cacheDisposition: "cold-model-switch",
      previousProvider: "remote-faux",
      previousModel: "large-200k",
    });
    expect(runtime.latestManifest()?.modelAwareness?.calibration.calibrated).toBe(true);
    expect(JSON.stringify(runtime.latestManifest())).not.toContain("CANONICAL-MODEL-PRIVATE");

    await pi.commands.get("context")?.handler("model", context as unknown as ExtensionCommandContext);
    expect(notifications.at(-1)).toContain("DS4 Advanced Model Awareness");
    expect(notifications.at(-1)).toContain("Cache window read/write");

    expect(readFileSync(sessionFile, "utf8")).toContain(canonicalContent);
    await pi.handlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown", reason: "quit" },
      context,
    );

    const database = new DatabaseSync(join(agentDir, "ds4-context", "context.db"), { readOnly: true });
    const metrics = database.prepare(`
      SELECT count(*) AS samples, sum(cache_read_tokens) AS cache_read,
        sum(cache_write_tokens) AS cache_write
      FROM token_calibration
      WHERE provider = 'local-faux' AND model = 'small-32k'
    `).get() as unknown as { samples: number; cache_read: number; cache_write: number };
    expect(metrics.samples).toBe(3);
    expect(metrics.cache_read).toBeGreaterThan(0);
    expect(metrics.cache_write).toBeGreaterThan(0);
    database.close();
  });
});
