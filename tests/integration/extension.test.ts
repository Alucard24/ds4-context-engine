import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { registerDs4ContextEngine } from "../../src/extension/index.ts";

interface RegisteredCommandLike {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

class FakePi {
  readonly handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  readonly commands = new Map<string, RegisteredCommandLike>();

  on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  registerCommand(name: string, command: RegisteredCommandLike): void {
    this.commands.set(name, command);
  }

  getActiveTools(): string[] {
    return ["read"];
  }

  getAllTools(): unknown[] {
    return [{
      name: "read",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      sourceInfo: { path: "<builtin:read>", source: "builtin", scope: "temporary", origin: "top-level" },
    }];
  }
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function createContext(cwd: string, notifications: string[]): ExtensionContext {
  const messages = [{
    type: "message",
    id: "entry-1",
    parentId: null,
    timestamp: "2026-08-24T00:00:01.000Z",
    message: { role: "user", content: "hello", timestamp: 1 },
  }];
  const sessionManager = {
    getSessionId: () => "session-test",
    getSessionFile: () => join(cwd, "session.jsonl"),
    getLeafId: () => "leaf-1",
    getEntries: () => messages,
    getBranch: () => messages,
    buildContextEntries: () => messages,
  };

  return {
    cwd,
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
    },
    sessionManager,
    model: {
      id: "model-test",
      name: "Model Test",
      api: "openai-responses",
      provider: "test",
      baseUrl: "http://localhost",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    },
    scopedModels: [],
    modelRegistry: {},
    isProjectTrusted: () => true,
    isIdle: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => ({ tokens: 100, contextWindow: 128_000, percent: 0.078125 }),
    compact: () => {},
    getSystemPrompt: () => "system instructions",
    waitForIdle: async () => {},
  } as unknown as ExtensionContext;
}

describe("DS4 Pi extension contract", () => {
  it("registers lifecycle hooks, stays pass-through, and serves /context", async () => {
    const root = mkdtempSync(join(tmpdir(), "ds4-extension-"));
    temporaryDirectories.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const notifications: string[] = [];
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(cwd, "session.jsonl"),
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-test",
          timestamp: "2026-08-24T00:00:00.000Z",
          cwd,
        }),
        JSON.stringify({
          type: "message",
          id: "entry-1",
          parentId: null,
          timestamp: "2026-08-24T00:00:01.000Z",
          message: { role: "user", content: "hello", timestamp: 1 },
        }),
      ].join("\n") + "\n",
    );
    const context = createContext(cwd, notifications);
    const pi = new FakePi();
    let manifestSequence = 0;

    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir,
      configDirName: ".pi",
      homeDir: root,
      now: () => 123,
      idGenerator: () => `manifest-test-${++manifestSequence}`,
      logSink: () => {},
    });

    expect(pi.commands.has("context")).toBe(true);
    expect(pi.handlers.has("session_start")).toBe(true);
    expect(pi.handlers.has("context")).toBe(true);
    expect(pi.handlers.has("session_shutdown")).toBe(true);

    await pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, context);
    expect(existsSync(join(agentDir, "ds4-context", "context.db"))).toBe(true);

    const sourceMessages = [{ role: "user", content: "hello", timestamp: 1 }];
    const result = await pi.handlers.get("context")?.[0]?.({ type: "context", messages: sourceMessages }, context);
    expect(result).toBeUndefined();
    expect(sourceMessages).toEqual([{ role: "user", content: "hello", timestamp: 1 }]);
    expect(runtime.diagnostics(context).observation).toMatchObject({ messageCount: 1, reportedTokens: 100 });
    expect(runtime.diagnostics(context).indexed).toMatchObject({ entries: 1 });
    expect(runtime.latestManifest()).toMatchObject({
      id: "manifest-test-1",
      sessionId: "session-test",
      provider: "test",
      model: "model-test",
      composition: { messageCount: 1, toolCount: 1 },
    });
    expect(runtime.latestManifest()?.included.find((item) => item.kind === "current")?.sourceId).toBe("entry-1");

    await pi.handlers.get("message_end")?.[0]?.({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        usage: { input: 70, output: 5, cacheRead: 20, cacheWrite: 10 },
      },
    }, context);
    expect(runtime.latestManifest()?.actualInputTokens).toBe(100);

    await pi.commands.get("context")?.handler("manifest", context as unknown as ExtensionCommandContext);
    expect(notifications.at(-1)).toContain("manifest-test-1");

    const previousModel = context.model;
    (context as unknown as { model: unknown }).model = {
      ...previousModel,
      provider: "other",
      id: "model-small",
      contextWindow: 32_000,
      maxTokens: 4_096,
    };
    await pi.handlers.get("model_select")?.[0]?.({
      type: "model_select",
      model: context.model,
      previousModel,
      source: "set",
    }, context);
    await pi.handlers.get("context")?.[0]?.({ type: "context", messages: sourceMessages }, context);
    expect(runtime.latestManifest()).toMatchObject({
      id: "manifest-test-2",
      provider: "other",
      model: "model-small",
      contextWindow: 32_000,
    });
    await pi.handlers.get("message_end")?.[0]?.({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        usage: { input: 180, output: 5, cacheRead: 20, cacheWrite: 0 },
      },
    }, context);

    await pi.commands.get("context")?.handler("rebuild-index", context as unknown as ExtensionCommandContext);
    expect(notifications.at(-1)).toContain("DS4 Context Index Rebuilt");

    await pi.commands.get("context")?.handler("status", context as unknown as ExtensionCommandContext);
    expect(notifications.at(-1)).toContain("observer-v1 (pass-through)");

    await pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, context);
    expect(runtime.diagnostics(context).phase).toBe("closed");

    const resumedPi = new FakePi();
    const resumed = registerDs4ContextEngine(resumedPi as unknown as ExtensionAPI, {
      agentDir,
      configDirName: ".pi",
      homeDir: root,
      logSink: () => {},
    });
    await resumedPi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "resume" }, context);
    expect(resumed.latestManifest()).toMatchObject({
      id: "manifest-test-2",
      provider: "other",
      actualInputTokens: 200,
    });
    await resumedPi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, context);
  });
});
