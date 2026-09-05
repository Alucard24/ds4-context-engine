import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sessionEntryToContextMessages,
  type ContextEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
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
    return [];
  }

  getAllTools(): unknown[] {
    return [];
  }
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

interface FixtureOptions {
  userDecision: string;
  assistantBody: string;
  currentQuestion: string;
  window: number;
  maxTokens: number;
}

function fixture(options: FixtureOptions): {
  root: string;
  agentDir: string;
  context: ExtensionContext;
  event: ContextEvent;
  lines: string[];
} {
  const root = mkdtempSync(join(tmpdir(), "ds4-planned-context-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const sessionFile = join(cwd, "session.jsonl");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const decision: SessionEntry = {
    type: "message",
    id: "decision-turn",
    parentId: null,
    timestamp: "2026-08-24T00:00:01.000Z",
    message: { role: "user", content: options.userDecision, timestamp: 1 },
  };
  const reply: SessionEntry = {
    type: "message",
    id: "decision-reply",
    parentId: "decision-turn",
    timestamp: "2026-08-24T00:00:02.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: options.assistantBody }],
      api: "openai-responses",
      provider: "test",
      model: "model-test",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop" as const,
      timestamp: 2,
    },
  };
  const current: SessionEntry = {
    type: "message",
    id: "current-request",
    parentId: "decision-reply",
    timestamp: "2026-08-24T00:00:03.000Z",
    message: { role: "user", content: options.currentQuestion, timestamp: 3 },
  };
  const allEntries = [decision, reply, current];
  writeFileSync(sessionFile, [
    JSON.stringify({ type: "session", version: 3, id: "session-planned", timestamp: "2026-08-24T00:00:00.000Z", cwd }),
    ...allEntries.map((entry) => JSON.stringify(entry)),
  ].join("\n") + "\n");
  const lines: string[] = [];
  const context = {
    cwd,
    mode: "tui",
    hasUI: true,
    ui: { notify: () => {}, setStatus: () => {} },
    sessionManager: {
      getSessionId: () => "session-planned",
      getSessionFile: () => sessionFile,
      getLeafId: () => "current-request",
      getEntries: () => allEntries,
      getBranch: () => allEntries,
      buildContextEntries: () => allEntries,
    },
    model: {
      id: `model-${options.window}`,
      name: `Model ${options.window}`,
      api: "openai-responses",
      provider: "test",
      baseUrl: "http://localhost",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: options.window,
      maxTokens: options.maxTokens,
    },
    scopedModels: [],
    isProjectTrusted: () => true,
    isIdle: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "system",
    waitForIdle: async () => {},
  } as unknown as ExtensionContext;
  const event: ContextEvent = {
    type: "context",
    messages: allEntries.flatMap(sessionEntryToContextMessages),
  };
  return { root, agentDir, context, event, lines };
}

async function runContextHook(
  pi: FakePi,
  agentDir: string,
  root: string,
  data: { context: ExtensionContext; event: ContextEvent; lines: string[] },
): Promise<{
  result: { messages?: ContextEvent["messages"] } | undefined;
  runtime: ReturnType<typeof registerDs4ContextEngine>;
}> {
  const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
    agentDir,
    configDirName: ".pi",
    homeDir: root,
    logSink: (line: string) => data.lines.push(line),
  });
  await pi.handlers.get("session_start")?.[0]?.(
    { type: "session_start", reason: "startup" },
    data.context,
  );
  const result = await pi.handlers.get("context")?.[0]?.(data.event, data.context) as
    | { messages?: ContextEvent["messages"] }
    | undefined;
  return { result, runtime };
}

async function shutdown(pi: FakePi, context: ExtensionContext): Promise<void> {
  await pi.handlers.get("session_shutdown")?.[0]?.(
    { type: "session_shutdown", reason: "quit" },
    context,
  );
}

describe("planned-context retrieval integration", () => {
  it("retrieves a turn the manager excludes beyond the recent-tail cap (second chance)", async () => {
    const data = fixture({
      userDecision: "DECISION: alpha-673 stays nullable.",
      assistantBody: `execution log for alpha-673\n${"x".repeat(140_000)}`,
      currentQuestion: "How did we decide alpha-673?",
      window: 32_000,
      maxTokens: 4_096,
    });
    const pi = new FakePi();
    const { result, runtime } = await runContextHook(pi, data.agentDir, data.root, data);

    const evidence = result?.messages?.find((message) =>
      message.role === "user"
      && typeof message.content === "string"
      && message.content.includes("DS4 HISTORICAL EVIDENCE")
    );
    expect(evidence).toBeDefined();
    expect(runtime.retrievalDiagnostics().selected.map((item) => item.entryId)).toContain("decision-turn");
    expect(runtime.latestManifest()?.planning).toMatchObject({
      mode: "managed",
      oversizedTurnExclusions: 1,
    });
    expect(runtime.latestManifest()?.planning?.rescuedImmediatePredecessor).toBeUndefined();
    const warnLine = data.lines.find((line) => line.includes("context.excluded_oversized_turn"));
    expect(warnLine).toBeDefined();
    expect(warnLine).toContain("\"oversizedTurnCount\":1");
    expect(warnLine).toContain("\"rescuedImmediatePredecessor\":false");
    expect(result?.messages?.at(-1)).toEqual(data.event.messages.at(-1));
    await shutdown(pi, data.context);
  });

  it("rescues the immediate-predecessor turn verbatim when it only exceeds the recent-tail cap", async () => {
    const data = fixture({
      userDecision: "DECISION: beta-902 stays nullable.",
      assistantBody: `execution log for beta-902\n${"y".repeat(360_000)}`,
      currentQuestion: "How did we decide beta-902?",
      window: 400_000,
      maxTokens: 16_384,
    });
    const pi = new FakePi();
    const { result, runtime } = await runContextHook(pi, data.agentDir, data.root, data);

    const rescued = runtime.latestManifest()?.included.find((item) =>
      item.kind === "recent" && item.sourceId === "decision-turn"
    );
    expect(rescued).toBeDefined();
    expect(rescued?.reason).toContain("rescued beyond the recent-tail cap");
    expect(runtime.latestManifest()?.planning).toMatchObject({
      mode: "managed",
      rescuedImmediatePredecessor: true,
    });
    expect(runtime.latestManifest()?.planning?.oversizedTurnExclusions).toBeUndefined();
    expect(runtime.retrievalDiagnostics().selected.map((item) => item.entryId))
      .not.toContain("decision-turn");
    expect(result?.messages?.find((message) =>
      message.role === "user"
      && typeof message.content === "string"
      && message.content.includes("DS4 HISTORICAL EVIDENCE")
    )).toBeUndefined();
    expect(result?.messages?.at(-1)).toEqual(data.event.messages.at(-1));
    await shutdown(pi, data.context);
  });
});
