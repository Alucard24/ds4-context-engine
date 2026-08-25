import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { registerDs4ContextEngine } from "../../src/extension/index.ts";

interface ToolLike {
  name: string;
  description: string;
  parameters: unknown;
  sourceInfo?: { source: string };
  execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
}

class FakePi {
  readonly handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  readonly commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  readonly tools = new Map<string, ToolLike>();

  on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }): void {
    this.commands.set(name, command);
  }

  registerTool(tool: ToolLike): void {
    this.tools.set(tool.name, {
      ...tool,
      sourceInfo: { source: "extension" },
    });
  }

  getActiveTools(): string[] { return [...this.tools.keys()]; }
  getAllTools(): ToolLike[] { return [...this.tools.values()]; }
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("DS4 artifact extension integration", () => {
  it("condenses canonical large tool output, manifests it, and exposes bounded branch-safe search", async () => {
    const root = mkdtempSync(join(tmpdir(), "ds4-artifact-extension-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const agentDir = join(root, "agent");
    mkdirSync(project, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({ context: { recentTailTokens: 0 } }));
    const hugeOutput = [
      "command started",
      "x".repeat(80_000),
      "UNIQUE_FAILURE_NEEDLE at src/Build.ts:42",
      "y".repeat(80_000),
      "command finished",
    ].join("\n");
    const user = { role: "user" as const, content: "Run the build and fix its failure.", timestamp: 1 };
    const assistant = {
      role: "assistant" as const,
      content: [{ type: "toolCall", id: "call-build", name: "bash", arguments: { command: "build" } }],
      api: "openai-responses",
      provider: "test",
      model: "model-test",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse" as const,
      timestamp: 2,
    };
    const toolResult = {
      role: "toolResult" as const,
      toolCallId: "call-build",
      toolName: "bash",
      content: [{ type: "text", text: hugeOutput }],
      details: { exitCode: 1 },
      isError: true,
      timestamp: 3,
    };
    const entries: Array<{
      type: string;
      id: string;
      parentId: string | null;
      timestamp: string;
      message: unknown;
    }> = [
      { type: "message", id: "user-1", parentId: null, timestamp: "2026-08-24T00:00:01.000Z", message: user },
      { type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-08-24T00:00:02.000Z", message: assistant },
      { type: "message", id: "result-1", parentId: "assistant-1", timestamp: "2026-08-24T00:00:03.000Z", message: toolResult },
    ];
    const sessionFile = join(root, "session.jsonl");
    writeFileSync(sessionFile, [
      JSON.stringify({ type: "session", version: 3, id: "artifact-session", timestamp: "2026-08-24T00:00:00.000Z", cwd: project }),
      ...entries.map((entry) => JSON.stringify(entry)),
    ].join("\n") + "\n");

    const notifications: string[] = [];
    const context = {
      cwd: project,
      mode: "tui",
      hasUI: true,
      ui: { notify: (message: string) => notifications.push(message), setStatus: () => {} },
      sessionManager: {
        getSessionId: () => "artifact-session",
        getSessionFile: () => sessionFile,
        getLeafId: () => entries.at(-1)?.id ?? null,
        getEntries: () => entries,
        getBranch: () => entries,
        buildContextEntries: () => entries,
      },
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
      isProjectTrusted: () => true,
      getContextUsage: () => undefined,
      getSystemPrompt: () => "system",
      waitForIdle: async () => {},
    } as unknown as ExtensionContext;
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir,
      configDirName: ".pi",
      homeDir: root,
      logSink: () => {},
    });

    await pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, context);
    const nativeMessages = [user, assistant, toolResult];
    const transformed = await pi.handlers.get("context")?.[0]?.({
      type: "context",
      messages: nativeMessages,
    }, context) as { messages: typeof nativeMessages };

    expect(nativeMessages[2]?.content[0]).toMatchObject({ text: hugeOutput });
    expect(transformed.messages).toHaveLength(3);
    expect(transformed.messages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-build",
      toolName: "bash",
      isError: true,
      details: { exitCode: 1 },
    });
    expect(JSON.stringify(transformed.messages[2])).toContain("DS4 LARGE TOOL OUTPUT OFFLOADED");
    expect(JSON.stringify(transformed.messages[2]).length).toBeLessThan(12_000);
    expect(runtime.latestManifest()).toMatchObject({
      plannerVersion: "managed-memory-v1",
      policyVersion: "5",
      artifacts: [expect.objectContaining({ sourceEntryId: "result-1", toolCallId: "call-build" })],
    });
    expect(JSON.stringify(runtime.latestManifest())).not.toContain("UNIQUE_FAILURE_NEEDLE");
    expect(runtime.latestManifest()?.included).toContainEqual(expect.objectContaining({
      sourceId: "result-1",
      reason: expect.stringContaining("Exact canonical source recorded by DS4 artifact offload"),
    }));
    expect(runtime.diagnostics(context).artifacts.estimatedTokensSaved).toBeGreaterThan(30_000);

    const artifact = runtime.latestManifest()?.artifacts?.[0];
    if (!artifact) throw new Error("Expected artifact manifest reference");
    expect(existsSync(join(agentDir, "ds4-context", "artifacts", artifact.sha256.slice(0, 2), artifact.sha256))).toBe(true);
    const searchTool = pi.tools.get("context_artifact_search");
    if (!searchTool) throw new Error("Artifact search tool not registered");
    const search = await searchTool.execute(
      "search-1",
      { artifactId: artifact.artifactId, query: "UNIQUE_FAILURE_NEEDLE", maxMatches: 3 },
      new AbortController().signal,
      undefined,
      context,
    );
    expect(search.content[0]?.text).toContain("UNIQUE_FAILURE_NEEDLE");
    expect(search.content[0]?.text.length).toBeLessThan(5_000);

    const objectPath = join(agentDir, "ds4-context", "artifacts", artifact.sha256.slice(0, 2), artifact.sha256);
    rmSync(objectPath);
    await pi.commands.get("context")?.handler("rebuild-index", context);
    expect(existsSync(objectPath)).toBe(true);

    rmSync(objectPath);
    await pi.commands.get("context")?.handler("health", context);
    expect(notifications.at(-1)).toContain("Artifact missing/corrupt: 1 / 0");
    await pi.commands.get("context")?.handler("rebuild-index", context);
    expect(existsSync(objectPath)).toBe(true);

    await pi.commands.get("context")?.handler("artifacts", context);
    expect(notifications.at(-1)).toContain(artifact.artifactId);

    const nextUser = { role: "user" as const, content: "Now answer an unrelated greeting.", timestamp: 4 };
    const nextEntry = {
      type: "message",
      id: "user-2",
      parentId: "result-1",
      timestamp: "2026-08-24T00:00:04.000Z",
      message: nextUser,
    };
    entries.push(nextEntry);
    nativeMessages.push(nextUser);
    appendFileSync(sessionFile, `${JSON.stringify(nextEntry)}\n`);
    const nextContext = await pi.handlers.get("context")?.[0]?.({
      type: "context",
      messages: nativeMessages,
    }, context) as { messages: typeof nativeMessages };
    expect(nextContext.messages).toEqual([nextUser]);
    expect(runtime.latestManifest()?.artifacts).toEqual([]);
    expect(runtime.latestManifest()?.excluded).toContainEqual(expect.objectContaining({
      sourceId: "result-1",
      reason: expect.stringContaining("Exact canonical source recorded by DS4 artifact offload"),
    }));
    expect(runtime.diagnostics(context).artifacts.stats.references).toBe(1);

    await pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, context);
  });
});
