import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextDatabase } from "ds4-context-core/persistence/sqlite";
import { DEFAULT_CONFIG } from "ds4-context-core/config/config";
import type { RebaseResult } from "ds4-context-core/rebase/rebase-types";
import { PiSessionRebase, loadRebaseState } from "../../src/pi-adapter/session-rebase.ts";

// P0/B spike: real installed Pi, isolated synthetic state, no model requests.
const model: Model<"openai-completions"> = {
  id: "never-call", name: "Offline history fixture", provider: "history-fixture",
  api: "openai-completions", baseUrl: "http://127.0.0.1:1",
  reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 1_024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const assistant: AssistantMessage = {
  role: "assistant", content: [{ type: "text", text: "Synthetic persisted fixture only." }],
  api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 1,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("History/rebase P0 against installed Pi session runtime", () => {
  it("replaces command context, preserves the source, and reports lazy target persistence", async () => {
    const root = mkdtempSync(join(tmpdir(), "ds4-pi-rebase-spike-"));
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const sessionDir = join(root, "sessions");
    for (const path of [cwd, agentDir, sessionDir]) mkdirSync(path, { recursive: true });
    // A real isolated settings file also carries the global-only warming switch on newer hosts.
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false },
      enableInstallTelemetry: false, defaultProjectTrust: "always", defaultThinkingLevel: "off",
    }));
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const fetch = vi.fn(() => { throw new Error("Network forbidden in offline Pi fixture"); });
    vi.stubGlobal("fetch", fetch);
    const models = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"), modelsPath: null,
      modelsStorePath: join(agentDir, "model-store.json"),
      allowModelNetwork: false, refreshOnCreate: false,
    });
    vi.spyOn(models, "getAvailable").mockResolvedValue([]);
    const stream = vi.spyOn(models, "streamSimple").mockImplementation(() => {
      throw new Error("Provider calls forbidden in offline Pi fixture");
    });
    const source = SessionManager.create(cwd, sessionDir);
    source.appendMessage({ role: "user", content: "P0 source fixture", timestamp: 1 });
    source.appendMessage(assistant);
    const sourcePath = source.getSessionFile()!;
    const sourceBytes = readFileSync(sourcePath);
    const sourceId = source.getSessionId();
    let oldContext: ExtensionCommandContext | undefined;
    let targetId: string | undefined;
    let targetPath: string | undefined;
    let freshCallback = false;
    const rebaseDb = ContextDatabase.open(join(root, "rebase.db"));
    const rebaseConfig = structuredClone(DEFAULT_CONFIG);
    rebaseConfig.historyTools.enabled = true; rebaseConfig.sessionRebase.enabled = true;
    let rebaseResult: RebaseResult | undefined;
    const extension = (pi: ExtensionAPI): void => {
      pi.registerCommand("history-p0-rebase", { description: "Offline full rebase fixture",
        handler: async (_args, ctx) => {
          rebaseResult = await new PiSessionRebase().run(ctx, { config: rebaseConfig, database: rebaseDb,
            projectPath: cwd, compactionActive: () => false, snapshotMemory: () => ({ pins: [], memories: [] }) });
        } });
      pi.registerCommand("history-p0-recover", { description: "Offline idempotent recovery fixture",
        handler: async (_args, ctx) => {
          rebaseResult = await new PiSessionRebase().run(ctx, { config: rebaseConfig, database: rebaseDb,
            projectPath: cwd, compactionActive: () => false, snapshotMemory: () => ({ pins: [], memories: [] }) },
            { recover: rebaseResult!.operationId! });
        } });
      pi.registerCommand("history-p0-replace", {
        description: "Offline compatibility fixture",
        handler: async (_args, ctx) => {
          oldContext = ctx;
          await ctx.waitForIdle();
          const result = await ctx.newSession({
            parentSession: sourcePath,
            setup: async (manager) => {
              manager.appendCustomEntry("ds4-p0-operation", { operationId: "synthetic-op" });
              targetId = manager.getSessionId();
              targetPath = manager.getSessionFile();
            },
            withSession: async (fresh) => {
              freshCallback = true;
              expect(fresh.sessionManager.getSessionId()).toBe(targetId);
              expect(fresh.sessionManager.getSessionId()).not.toBe(sourceId);
              expect(() => ctx.sessionManager.getSessionId()).toThrow();
            },
          });
          expect(result.cancelled).toBe(false);
        },
      });
    };
    const create: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd, agentDir, modelRuntime: models,
        settingsManager: SettingsManager.create(cwd, agentDir),
        resourceLoaderOptions: {
          noExtensions: true, noSkills: true, noPromptTemplates: true,
          noThemes: true, noContextFiles: true, extensionFactories: [extension],
        },
      });
      return {
        ...await createAgentSessionFromServices({
          services, sessionManager, model, noTools: "all",
          ...(sessionStartEvent ? { sessionStartEvent } : {}),
        }),
        services, diagnostics: services.diagnostics,
      };
    };
    const runtime = await createAgentSessionRuntime(create, { cwd, agentDir, sessionManager: source });
    const bind = async (): Promise<void> => {
      await runtime.session.bindExtensions({
        commandContextActions: {
          waitForIdle: () => runtime.session.waitForIdle(),
          newSession: (options) => runtime.newSession(options),
          switchSession: (path, options) => runtime.switchSession(path, options),
          fork: async () => { throw new Error("Not used by P0 fixture"); },
          navigateTree: async () => { throw new Error("Not used by P0 fixture"); },
          reload: async () => { throw new Error("Not used by P0 fixture"); },
        },
        onError: (error) => { throw new Error(`Offline extension error: ${error.error}`); },
      });
    };
    runtime.setRebindSession(bind);
    try {
      await bind();
      const initializedSourceBytes = readFileSync(sourcePath);
      // Pi startup may append its own thinking/model metadata; it must retain the original prefix.
      expect(initializedSourceBytes.subarray(0, sourceBytes.length)).toEqual(sourceBytes);
      const startupEntries = initializedSourceBytes.subarray(sourceBytes.length).toString("utf8")
        .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string });
      expect(startupEntries.every((entry) => ["model_change", "thinking_level_change"].includes(entry.type))).toBe(true);
      await runtime.session.prompt("/history-p0-replace");
      expect(freshCallback).toBe(true);
      expect(oldContext).toBeDefined();
      expect(targetId).toBeDefined();
      expect(targetPath).toBeDefined();
      // Metadata alone is not flushed in this pinned Pi version. B needs canonical staging.
      expect(existsSync(targetPath!)).toBe(false);
      expect(runtime.session.sessionManager.getHeader()?.parentSession).toBe(sourcePath);
      expect(readFileSync(sourcePath)).toEqual(initializedSourceBytes);
      runtime.session.sessionManager.appendMessage(assistant);
      expect(existsSync(targetPath!)).toBe(true);
      expect(SessionManager.open(targetPath!).getEntries()).toContainEqual(expect.objectContaining({
        type: "custom", customType: "ds4-p0-operation", data: { operationId: "synthetic-op" },
      }));
      const result = await runtime.switchSession(sourcePath, {
        withSession: async (fresh) => { expect(fresh.sessionManager.getSessionId()).toBe(sourceId); },
      });
      expect(result.cancelled).toBe(false);
      expect(runtime.session.sessionId).toBe(sourceId);
      expect(readFileSync(sourcePath)).toEqual(initializedSourceBytes);
      await runtime.session.prompt("/history-p0-rebase");
      expect(rebaseResult?.status).toBe("verified");
      const activatedId = runtime.session.sessionId;
      await runtime.session.prompt("/history-p0-recover");
      expect(rebaseResult?.status).toBe("verified");
      expect(runtime.session.sessionId).toBe(activatedId);
      expect(runtime.session.sessionId).not.toBe(sourceId);
      const stagedTarget = runtime.session.sessionManager.getSessionFile()!;
      expect(existsSync(stagedTarget)).toBe(true);
      expect(loadRebaseState(stagedTarget, runtime.session.sessionManager.getBranch(), cwd).warnings).toEqual([]);
      expect(readFileSync(sourcePath)).toEqual(initializedSourceBytes);
      expect(stream).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
      rebaseDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
