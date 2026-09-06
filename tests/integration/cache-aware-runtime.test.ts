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

const deepseekCost = { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0.22 };

interface FixtureOptions {
  window: number;
  maxTokens: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  extraTurns?: number;
  turnTokens?: number;
  cacheAwareMode?: "off" | "auto" | "absent";
}

function fixture(options: FixtureOptions): {
  root: string;
  agentDir: string;
  context: ExtensionContext;
  event: ContextEvent;
  lines: string[];
} {
  const root = mkdtempSync(join(tmpdir(), "ds4-cache-aware-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const sessionFile = join(cwd, "session.jsonl");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  const turnTokens = options.turnTokens ?? 20_000;
  const extraTurns = options.extraTurns ?? 5;
  const entries: SessionEntry[] = [];
  let parentId: string | null = null;
  for (let index = 0; index < extraTurns; index++) {
    const userEntry: SessionEntry = {
      type: "message",
      id: `turn-${index}-user`,
      parentId,
      timestamp: `2026-08-24T00:00:0${index + 1}.000Z`,
      message: { role: "user", content: `decision ${index} ${"x".repeat(turnTokens)}`, timestamp: index + 1 },
    };
    const assistantEntry: SessionEntry = {
      type: "message",
      id: `turn-${index}-assistant`,
      parentId: userEntry.id,
      timestamp: `2026-08-24T00:00:0${index + 1}.500Z`,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `reply ${index} ${"y".repeat(turnTokens)}` }],
        api: "openai-responses",
        provider: "test",
        model: "model-test",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop" as const,
        timestamp: index + 2,
      },
    };
    entries.push(userEntry, assistantEntry);
    parentId = assistantEntry.id;
  }
  const current: SessionEntry = {
    type: "message",
    id: "current-request",
    parentId,
    timestamp: "2026-08-24T00:01:00.000Z",
    message: { role: "user", content: "current question", timestamp: 100 },
  };
  entries.push(current);
  writeFileSync(sessionFile, [
    JSON.stringify({ type: "session", version: 3, id: "session-cache-aware", timestamp: "2026-08-24T00:00:00.000Z", cwd }),
    ...entries.map((entry) => JSON.stringify(entry)),
  ].join("\n") + "\n");

  if (options.cacheAwareMode !== "absent") {
    const configDir = join(cwd, ".pi");
    mkdirSync(configDir, { recursive: true });
    const cacheAware = options.cacheAwareMode === "off"
      ? { mode: "off" }
      : {
          mode: "auto",
          minimumCacheSampleCount: 1,
          minimumCacheReadShare: 0.3,
          minimumMissHitRatio: 10,
          minimumImprovementRatio: 0.05,
          maxTailBudgetShare: 0.5,
        };
    writeFileSync(join(configDir, "ds4-context.json"), JSON.stringify({
      context: { cacheAware },
    }));
  }

  const lines: string[] = [];
  const context = {
    cwd,
    mode: "tui",
    hasUI: true,
    ui: { notify: () => {}, setStatus: () => {} },
    sessionManager: {
      getSessionId: () => "session-cache-aware",
      getSessionFile: () => sessionFile,
      getLeafId: () => "current-request",
      getEntries: () => entries,
      getBranch: () => entries,
      buildContextEntries: () => entries,
    },
    model: {
      id: `model-${options.window}`,
      name: `Model ${options.window}`,
      api: "openai-responses",
      provider: "test",
      baseUrl: "http://localhost",
      reasoning: false,
      input: ["text"],
      cost: options.cost ?? deepseekCost,
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
    messages: entries.flatMap(sessionEntryToContextMessages),
  };
  return { root, agentDir, context, event, lines };
}

async function runContextHook(
  pi: FakePi,
  agentDir: string,
  root: string,
  data: { context: ExtensionContext; event: ContextEvent; lines: string[] },
): Promise<
  { result: { messages?: ContextEvent["messages"] } | undefined; runtime: ReturnType<typeof registerDs4ContextEngine> }
> {
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

/** Emulate a provider response: the runtime observes real cache usage. */
function emitUsage(pi: FakePi, cacheRead: number, input: number, output: number): void {
  // The runtime registers this as a two-argument handler; we only need the event.
  (pi.handlers.get("message_end")?.[0] as ((event: any) => void) | undefined)?.({
    message: {
      role: "assistant",
      stopReason: "stop",
      usage: { input, output, cacheRead, cacheWrite: 0, totalTokens: input + cacheRead + output },
    },
  });
}

/** Append one more full turn to the event; returns the new event. */
function growEvent(data: {
  event: ContextEvent;
  turnTokens: number;
  turnIndex: number;
}): ContextEvent {
  const userPart: SessionEntry = {
    type: "message",
    id: `grown-${data.turnIndex}-user`,
    parentId: null,
    timestamp: "2026-08-24T00:02:00.000Z",
    message: { role: "user", content: `grown request ${data.turnIndex} ${`g${"o".repeat(data.turnTokens)}`}`, timestamp: 200 },
  };
  const assistantPart: SessionEntry = {
    type: "message",
    id: `grown-${data.turnIndex}-assistant`,
    parentId: userPart.id,
    timestamp: "2026-08-24T00:02:01.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `grown reply ${data.turnIndex} ${`h${"i".repeat(data.turnTokens)}`}` }],
      api: "openai-responses",
      provider: "test",
      model: "model-test",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop" as const,
      timestamp: 201,
    },
  };
  const grownMessages = [
    ...data.event.messages,
    ...sessionEntryToContextMessages(userPart),
    ...sessionEntryToContextMessages(assistantPart),
  ];
  return { type: "context", messages: grownMessages };
}

async function shutdown(pi: FakePi, context: ExtensionContext): Promise<void> {
  await pi.handlers.get("session_shutdown")?.[0]?.(
    { type: "session_shutdown", reason: "quit" },
    context,
  );
}

describe("cache-aware runtime integration", () => {
  it("stays nominal with cache-aware mode off (default behavior unchanged)", async () => {
    const data = fixture({ window: 1_000_000, maxTokens: 32_768, cacheAwareMode: "off" });
    const pi = new FakePi();
    const { runtime } = await runContextHook(pi, data.agentDir, data.root, data);
    const manifest = runtime.latestManifest();
    expect(manifest?.planning?.cacheAware).toBeUndefined();
    expect(manifest?.planning?.recentTailTokenLimit).toBe(64_000);
    await shutdown(pi, data.context);
  });

  it("switches to cache-aware after observing real cache usage", async () => {
    const data = fixture({ window: 1_000_000, maxTokens: 32_768, turnTokens: 40_000, cacheAwareMode: "auto" });
    const pi = new FakePi();
    const { runtime, result } = await runContextHook(pi, data.agentDir, data.root, data);

    // First pass: no observation yet, so the decision is not eligible and the
    // manifest records the attempt (cacheAware block present, eligible false).
    const first = runtime.latestManifest();
    expect(first?.planning?.cacheAware).toBeDefined();
    expect(first?.planning?.cacheAware?.eligible).toBe(false);

    // Provider response with heavy cache read: the runtime learns the share.
    emitUsage(pi, 90_000, 4_000, 800);

    // New user turn appended: the nominal 64k tail now slides and loses its
    // prefix, while the extended cache-aware tail keeps it reusable.
    const grown = growEvent({ event: data.event, turnTokens: 40_000, turnIndex: 1 });
    const secondResult = await pi.handlers.get("context")?.[0]?.(grown, data.context) as
      | { messages?: ContextEvent["messages"] }
      | undefined;
    const second = runtime.latestManifest();
    expect(second?.planning?.cacheAware?.eligible).toBe(true);
    expect(second?.planning?.cacheAware?.tailExtended).toBe(true);
    expect(second?.planning?.cacheAware?.recentTailTokens).toBeGreaterThan(64_000);
    expect(second?.planning?.recentTailTokenLimit).toBe(second?.planning?.cacheAware?.recentTailTokens);
    expect(second?.planning?.cacheAware?.candidate).toBe("cache-aware");
    expect(second?.planning?.cacheAware?.missHitRatio).toBeCloseTo(0.22 / 0.007, 2);
    // Existing guarantees remain: current request kept, mode managed.
    expect(second?.planning?.mode).toBe("managed");
    expect(secondResult?.messages?.at(-1)).toEqual(grown.messages.at(-1));
    expect(result?.messages?.at(-1)).toEqual(data.event.messages.at(-1));
    await shutdown(pi, data.context);
  });

  it("stays nominal when pricing has no cache discount", async () => {
    const data = fixture({
      window: 1_000_000,
      maxTokens: 32_768,
      cacheAwareMode: "auto",
      cost: { input: 5, output: 15, cacheRead: 5, cacheWrite: 5 },
    });
    const pi = new FakePi();
    const { runtime } = await runContextHook(pi, data.agentDir, data.root, data);
    emitUsage(pi, 90_000, 4_000, 800);
    await pi.handlers.get("context")?.[0]?.(data.event, data.context);
    const manifest = runtime.latestManifest();
    const cacheAware = manifest?.planning?.cacheAware;
    expect(cacheAware).toBeDefined();
    expect(cacheAware?.eligible).toBe(false);
    expect(cacheAware?.tailExtended).toBe(false);
    expect(manifest?.planning?.recentTailTokenLimit).toBe(64_000);
    await shutdown(pi, data.context);
  });

  it("remains within the hard input budget when the tail is extended", async () => {
    const data = fixture({ window: 1_000_000, maxTokens: 32_768, turnTokens: 40_000, cacheAwareMode: "auto" });
    const pi = new FakePi();
    const { runtime } = await runContextHook(pi, data.agentDir, data.root, data);
    emitUsage(pi, 90_000, 4_000, 800);
    await pi.handlers.get("context")?.[0]?.(data.event, data.context);
    const manifest = runtime.latestManifest();
    expect(manifest?.planning?.mode).toBe("managed");
    expect(manifest?.estimatedInputTokens).toBeLessThanOrEqual(manifest?.hardInputLimit ?? Infinity);
    await shutdown(pi, data.context);
  });
});
