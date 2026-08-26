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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ds4-retrieval-extension-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const sessionFile = join(cwd, "session.jsonl");
  mkdirSync(cwd, { recursive: true });
  const old: SessionEntry = {
    type: "message",
    id: "old-decision",
    parentId: null,
    timestamp: "2026-08-24T00:00:01.000Z",
    message: {
      role: "user",
      content: "Decision: LastExportUtc remains nullable in src/DatabaseManager.cs.",
      timestamp: 1,
    },
  };
  const kept: SessionEntry = {
    type: "message",
    id: "kept-turn",
    parentId: "old-decision",
    timestamp: "2026-08-24T00:00:02.000Z",
    message: { role: "user", content: "Continue implementation.", timestamp: 2 },
  };
  const sibling: SessionEntry = {
    type: "message",
    id: "sibling-decision",
    parentId: "kept-turn",
    timestamp: "2026-08-24T00:00:03.000Z",
    message: { role: "user", content: "Alternative branch: remove LastExportUtc.", timestamp: 3 },
  };
  const compaction: SessionEntry = {
    type: "compaction",
    id: "compaction-1",
    parentId: "kept-turn",
    timestamp: "2026-08-24T00:00:04.000Z",
    summary: "Earlier work was compacted.",
    firstKeptEntryId: "kept-turn",
    tokensBefore: 20_000,
    fromHook: false,
  };
  const current: SessionEntry = {
    type: "message",
    id: "current-request",
    parentId: "compaction-1",
    timestamp: "2026-08-24T00:00:05.000Z",
    message: {
      role: "user",
      content: "How did we decide `LastExportUtc` in src/DatabaseManager.cs?",
      timestamp: 5,
    },
  };
  const allEntries = [old, kept, sibling, compaction, current];
  const branchEntries = [old, kept, compaction, current];
  const contextEntries = [compaction, kept, current];
  writeFileSync(sessionFile, [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "session-retrieval",
      timestamp: "2026-08-24T00:00:00.000Z",
      cwd,
    }),
    ...allEntries.map((entry) => JSON.stringify(entry)),
  ].join("\n") + "\n");
  const notifications: string[] = [];
  const context = {
    cwd,
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
    },
    sessionManager: {
      getSessionId: () => "session-retrieval",
      getSessionFile: () => sessionFile,
      getLeafId: () => "current-request",
      getEntries: () => allEntries,
      getBranch: () => branchEntries,
      buildContextEntries: () => contextEntries,
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
      contextWindow: 32_000,
      maxTokens: 4_096,
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
    messages: contextEntries.flatMap(sessionEntryToContextMessages),
  };
  return { root, agentDir, context, event, notifications };
}

describe("DS4 retrieval context integration", () => {
  it("injects branch-local historical evidence with manifest provenance", async () => {
    const data = fixture();
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      logSink: () => {},
    });
    await pi.handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "startup" },
      data.context,
    );

    const result = await pi.handlers.get("context")?.[0]?.(data.event, data.context) as
      | { messages?: ContextEvent["messages"] }
      | undefined;
    const evidence = result?.messages?.find((message) =>
      message.role === "user"
      && typeof message.content === "string"
      && message.content.includes("DS4 HISTORICAL EVIDENCE")
    );

    expect(evidence).toBeDefined();
    const evidenceContent = evidence && "content" in evidence && typeof evidence.content === "string"
      ? evidence.content
      : "";
    expect(evidenceContent).toContain("old-decision");
    expect(evidenceContent).not.toContain("sibling-decision");
    expect(result?.messages?.at(-1)).toEqual(data.event.messages.at(-1));
    expect(runtime.retrievalDiagnostics()).toMatchObject({
      status: "complete",
      alternateBranchCandidates: 1,
      plannerExcludedCount: 0,
    });
    expect(runtime.retrievalDiagnostics().selected.map((item) => item.entryId)).toEqual(["old-decision"]);
    expect(runtime.latestManifest()).toMatchObject({
      retrievedEventIds: ["old-decision"],
      plannerVersion: "managed-learned-ranking-v1",
    });
    expect(runtime.latestManifest()?.included.find((item) => item.kind === "retrieval")).toMatchObject({
      sourceId: "old-decision",
      role: "user",
    });
    expect(runtime.latestManifest()?.included.find((item) => item.kind === "current")?.sourceId)
      .toBe("current-request");

    await pi.commands.get("context")?.handler("retrieved", data.context as unknown as ExtensionCommandContext);
    expect(data.notifications.at(-1)).toContain("DS4 Retrieved Historical Evidence");
    expect(data.notifications.at(-1)).toContain("old-decision");
    await pi.handlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown", reason: "quit" },
      data.context,
    );
  });
});
