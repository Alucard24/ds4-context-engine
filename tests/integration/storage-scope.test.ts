import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function model() {
  return {
    id: "small-32k",
    name: "small-32k",
    api: "openai-responses" as const,
    provider: "local-faux",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 4_096,
  };
}

function workspace(root: string, name: string): {
  project: string;
  sessionId: string;
  sessionFile: string;
  context: ExtensionContext;
  entry: Record<string, unknown>;
} {
  const project = join(root, name);
  mkdirSync(project, { recursive: true });
  const sessionId = `session-${name}`;
  const sessionFile = join(project, "session.jsonl");
  const message = { role: "user" as const, content: `inspect ${name}`, timestamp: 1 };
  const entry = {
    type: "message",
    id: `entry-${name}`,
    parentId: null,
    timestamp: "2026-08-25T00:00:01.000Z",
    message,
  };
  writeFileSync(sessionFile, [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-08-25T00:00:00.000Z", cwd: project }),
    JSON.stringify(entry),
  ].join("\n") + "\n");
  const notifications: string[] = [];
  const context = {
    cwd: project,
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (text: string) => notifications.push(text),
      setStatus: () => {},
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
      getLeafId: () => `entry-${name}`,
      getEntries: () => [entry],
      getBranch: () => [entry],
      buildContextEntries: () => [entry],
    },
    model: model(),
    scopedModels: [],
    modelRegistry: {},
    isProjectTrusted: () => true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 100, contextWindow: 32_000, percent: 0.003 }),
    getSystemPrompt: () => "stable system",
    waitForIdle: async () => {},
  } as unknown as ExtensionContext;
  return { project, sessionId, sessionFile, context, entry };
}

function writeConfig(agentDir: string, config: Record<string, unknown>): void {
  writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
    retrieval: { exact: false, fts: false },
    project: { enabled: false },
    memory: { enabled: false },
    artifacts: { enabled: false },
    compaction: { enabled: false },
    ...config,
  }));
}

function counts(path: string): { manifests: number; calibration: number } {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      manifests: (database.prepare("SELECT count(*) AS value FROM context_manifests").get() as { value: number }).value,
      calibration: (database.prepare("SELECT count(*) AS value FROM token_calibration").get() as { value: number }).value,
    };
  } finally {
    database.close();
  }
}

describe("storage.scope runtime wiring", () => {
  it("keeps project data in per-project databases and calibration in the agent database", async () => {
    const root = mkdtempSync(join(tmpdir(), "ds4-storage-scope-runtime-"));
    temporaryDirectories.push(root);
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeConfig(agentDir, {
      modelAwareness: { calibrationWindow: 4, minimumCalibrationSamples: 1 },
      artifacts: { enabled: true, storeLargeOutputs: true },
    });

    const alpha = workspace(root, "alpha");
    const beta = workspace(root, "beta");
    const pi = new FakePi();
    let sequence = 0;
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir,
      configDirName: ".pi",
      homeDir: root,
      idGenerator: () => `scope-manifest-${++sequence}`,
      logSink: () => {},
    });
    const sessionStart = pi.handlers.get("session_start")?.[0];
    const contextHandler = pi.handlers.get("context")?.[0];
    const usageHandler = pi.handlers.get("message_end")?.[0];
    if (!sessionStart || !contextHandler || !usageHandler) throw new Error("Expected extension handlers");

    try {
      await sessionStart({ type: "session_start", reason: "startup" }, alpha.context);
      const alphaDiagnostics = runtime.diagnostics(alpha.context);
      expect(alphaDiagnostics.databasePath).toContain(join("ds4-context", "projects"));
      expect(alphaDiagnostics.agentDatabasePath).toBe(join(agentDir, "ds4-context", "context.db"));
      expect(alphaDiagnostics.databasePath).not.toBe(alphaDiagnostics.agentDatabasePath);
      // Artifact bytes must be scoped like their metadata, otherwise one
      // project's garbage collector could delete another project's objects.
      expect(alphaDiagnostics.artifacts.storePath).toContain(join("projects", "artifacts"));

      await contextHandler({ type: "context", messages: [alpha.entry.message] }, alpha.context);
      const estimated = runtime.latestManifest()?.estimatedInputTokens ?? 0;
      expect(estimated).toBeGreaterThan(0);
      await usageHandler({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          usage: { input: Math.max(1, Math.round(estimated * 1.2)), output: 5, cacheRead: 0, cacheWrite: 0 },
        },
      }, alpha.context);
      // The next plan reads the sample the previous turn wrote to the agent DB.
      await contextHandler({ type: "context", messages: [alpha.entry.message] }, alpha.context);
      expect(runtime.latestManifest()?.modelAwareness?.calibration.observedSamples).toBeGreaterThanOrEqual(1);

      await pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, alpha.context);

      await sessionStart({ type: "session_start", reason: "startup" }, beta.context);
      const betaDiagnostics = runtime.diagnostics(beta.context);
      expect(betaDiagnostics.databasePath).toContain(join("ds4-context", "projects"));
      expect(betaDiagnostics.agentDatabasePath).toBe(alphaDiagnostics.agentDatabasePath);
      expect(betaDiagnostics.databasePath).not.toBe(alphaDiagnostics.databasePath);
      expect(betaDiagnostics.artifacts.storePath).toBeDefined();
      expect(betaDiagnostics.artifacts.storePath).not.toBe(alphaDiagnostics.artifacts.storePath);

      // Beta reads alpha's calibration sample from the shared agent database.
      await contextHandler({ type: "context", messages: [beta.entry.message] }, beta.context);
      expect(runtime.latestManifest()?.modelAwareness?.calibration.observedSamples).toBeGreaterThanOrEqual(1);

      const alphaPath = alphaDiagnostics.databasePath!;
      const betaPath = betaDiagnostics.databasePath!;
      const agentPath = alphaDiagnostics.agentDatabasePath!;
      await pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, beta.context);

      expect(counts(alphaPath)).toEqual({ manifests: 2, calibration: 0 });
      expect(counts(betaPath)).toEqual({ manifests: 1, calibration: 0 });
      expect(counts(agentPath).calibration).toBeGreaterThanOrEqual(1);
    } finally {
      runtime.shutdown();
    }
  });

  it("falls back to the agent database when the scope is agent or the project is untrusted", async () => {
    const root = mkdtempSync(join(tmpdir(), "ds4-storage-scope-fallback-"));
    temporaryDirectories.push(root);
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeConfig(agentDir, { storage: { scope: "agent" } });
    const workspaceRoot = workspace(root, "project");
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir,
      configDirName: ".pi",
      homeDir: root,
      logSink: () => {},
    });
    const sessionStart = pi.handlers.get("session_start")?.[0];
    if (!sessionStart) throw new Error("Expected session_start handler");
    try {
      await sessionStart({ type: "session_start", reason: "startup" }, workspaceRoot.context);
      const scoped = runtime.diagnostics(workspaceRoot.context);
      expect(scoped.databasePath).toBe(join(agentDir, "ds4-context", "context.db"));
      expect(scoped.agentDatabasePath).toBeUndefined();
      await pi.handlers.get("session_shutdown")?.[0]?.(
        { type: "session_shutdown", reason: "quit" },
        workspaceRoot.context,
      );

      const untrusted = workspace(root, "untrusted");
      untrusted.context.isProjectTrusted = () => false;
      writeConfig(agentDir, {});
      await sessionStart({ type: "session_start", reason: "startup" }, untrusted.context);
      const fallback = runtime.diagnostics(untrusted.context);
      expect(fallback.databasePath).toBe(join(agentDir, "ds4-context", "context.db"));
      expect(fallback.agentDatabasePath).toBeUndefined();
    } finally {
      runtime.shutdown();
    }
  });
});
