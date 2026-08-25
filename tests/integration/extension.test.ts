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

  registerTool(): void {}

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
  it("registers lifecycle hooks, manages context, and serves /context", async () => {
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
    expect(result).toEqual({ messages: sourceMessages });
    expect(sourceMessages).toEqual([{ role: "user", content: "hello", timestamp: 1 }]);
    expect(runtime.diagnostics(context).observation).toMatchObject({
      mode: "managed",
      messageCount: 1,
      originalMessageCount: 1,
      reportedTokens: 100,
    });
    expect(runtime.diagnostics(context).indexed).toMatchObject({ entries: 1 });
    expect(runtime.latestManifest()).toMatchObject({
      id: "manifest-test-1",
      sessionId: "session-test",
      provider: "test",
      model: "model-test",
      composition: { messageCount: 1, toolCount: 1 },
      planning: { mode: "managed", selectedGroupCount: 1, excludedGroupCount: 0 },
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
    await pi.commands.get("context")?.handler("explain", context as unknown as ExtensionCommandContext);
    expect(notifications.at(-1)).toContain("Selected groups:      1");
    await pi.commands.get("context")?.handler("included", context as unknown as ExtensionCommandContext);
    expect(notifications.at(-1)).toContain("Mandatory current request turn");
    await pi.commands.get("context")?.handler("excluded", context as unknown as ExtensionCommandContext);
    expect(notifications.at(-1)).toContain("none");

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
    expect(notifications.at(-1)).toContain("managed-privacy-v1 (managed)");

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

  it("fails open to Pi messages when mandatory current content exceeds the hard limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "ds4-extension-fallback-"));
    temporaryDirectories.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(cwd, { recursive: true });
    const hugeMessage = { role: "user", content: "x".repeat(120_000), timestamp: 1 };
    const entry = {
      type: "message",
      id: "entry-huge",
      parentId: null,
      timestamp: "2026-08-24T00:00:01.000Z",
      message: hugeMessage,
    };
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
        JSON.stringify(entry),
      ].join("\n") + "\n",
    );
    const context = createContext(cwd, []);
    (context as unknown as { model: Record<string, unknown> }).model = {
      ...context.model,
      id: "model-small",
      contextWindow: 32_000,
      maxTokens: 4_096,
    };
    const sessionManager = context.sessionManager as unknown as Record<string, unknown>;
    sessionManager.getEntries = () => [entry];
    sessionManager.getBranch = () => [entry];
    sessionManager.buildContextEntries = () => [entry];
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir,
      configDirName: ".pi",
      homeDir: root,
      logSink: () => {},
    });

    await pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, context);
    const messages = [hugeMessage];
    const result = await pi.handlers.get("context")?.[0]?.({ type: "context", messages }, context);

    expect(result).toBeUndefined();
    expect(messages).toEqual([hugeMessage]);
    expect(runtime.latestManifest()?.planning).toMatchObject({
      mode: "fallback",
      fallbackReason: expect.stringContaining("mandatory current"),
    });
    await pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, context);
  });

  it("never indexes or retrieves project files when Pi marks the project untrusted", async () => {
    const root = mkdtempSync(join(tmpdir(), "ds4-extension-untrusted-"));
    temporaryDirectories.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "PrivateSource.ts"), "export const PrivateSymbol = 'MUST_NOT_LEAK';\n");
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
          message: { role: "user", content: "Inspect `PrivateSymbol` in `PrivateSource.ts`.", timestamp: 1 },
        }),
      ].join("\n") + "\n",
    );
    const context = createContext(cwd, []);
    (context as unknown as { isProjectTrusted: () => boolean }).isProjectTrusted = () => false;
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir,
      configDirName: ".pi",
      homeDir: root,
      logSink: () => {},
    });

    await pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, context);
    const messages = [{ role: "user", content: "Inspect `PrivateSymbol` in `PrivateSource.ts`.", timestamp: 1 }];
    const result = await pi.handlers.get("context")?.[0]?.({ type: "context", messages }, context) as { messages: unknown[] };

    expect(result.messages).toEqual(messages);
    expect(JSON.stringify(result)).not.toContain("MUST_NOT_LEAK");
    expect(runtime.diagnostics(context).project).toMatchObject({ status: "untrusted", trusted: false });
    expect(runtime.latestManifest()?.projectSnippets).toEqual([]);
    await pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, context);
  });

  it("supports an explicit observer-mode rollback", async () => {
    const root = mkdtempSync(join(tmpdir(), "ds4-extension-observer-"));
    temporaryDirectories.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({ context: { mode: "observer" } }));
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
    const context = createContext(cwd, []);
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir,
      configDirName: ".pi",
      homeDir: root,
      logSink: () => {},
    });

    await pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, context);
    const messages = [{ role: "user", content: "hello", timestamp: 1 }];
    const result = await pi.handlers.get("context")?.[0]?.({ type: "context", messages }, context);

    expect(result).toBeUndefined();
    expect(runtime.diagnostics(context)).toMatchObject({
      phase: "observer",
      contextMode: "observer",
      artifacts: { enabled: false, offloadedCount: 0 },
    });
    expect(runtime.latestManifest()).toMatchObject({ plannerVersion: "observer-v1" });
    expect(runtime.latestManifest()?.planning).toBeUndefined();
    await pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, context);
  });
});
