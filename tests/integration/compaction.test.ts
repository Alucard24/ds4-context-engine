import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { Ds4CompactionDetails } from "../../src/compaction/compaction-record.ts";
import { registerDs4ContextEngine } from "../../src/extension/index.ts";
import { ContextDatabase } from "../../src/persistence/sqlite.ts";

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

function validSummary(): string {
  return [
    "## Objective\n- Preserve the discarded conversation state.",
    "## User Constraints\n- None",
    "## Durable Decisions\n- None",
    "## Completed Work\n- None",
    "## Current State\n- Conversation can continue from the retained turn.",
    "## Files Read\n- None",
    "## Files Modified\n- None",
    "## Commands / Tests\n- None",
    "## Errors / Risks\n- None",
    "## Open Questions\n- None",
    "## Next Actions\n- Continue with the retained request.",
    "## Critical Exact Values\n- None",
  ].join("\n\n");
}

function fixture(summary = validSummary(), usageTokens = 1_000, stopReason = "stop") {
  const root = mkdtempSync(join(tmpdir(), "ds4-compaction-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const sessionFile = join(cwd, "session.jsonl");
  mkdirSync(cwd, { recursive: true });
  const entries: SessionEntry[] = [
    {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-08-24T00:00:01.000Z",
      message: { role: "user", content: "discarded source", timestamp: 1 },
    },
    {
      type: "message",
      id: "entry-2",
      parentId: "entry-1",
      timestamp: "2026-08-24T00:00:02.000Z",
      message: { role: "user", content: "retained source", timestamp: 2 },
    },
  ];
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "session-test",
        timestamp: "2026-08-24T00:00:00.000Z",
        cwd,
      }),
      ...entries.map((entry) => JSON.stringify(entry)),
    ].join("\n") + "\n",
  );
  const notifications: string[] = [];
  let compactCalls = 0;
  const context = {
    cwd,
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
    },
    sessionManager: {
      getSessionId: () => "session-test",
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
      contextWindow: 32_000,
      maxTokens: 4_096,
    },
    modelRegistry: {
      complete: async () => ({
        role: "assistant",
        content: [{ type: "text", text: summary }],
        stopReason,
        usage: {
          input: 100,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 200,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }),
    },
    scopedModels: [],
    isProjectTrusted: () => true,
    isIdle: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => ({ tokens: usageTokens, contextWindow: 32_000, percent: usageTokens / 320 }),
    compact: () => { compactCalls++; },
    getSystemPrompt: () => "system",
    waitForIdle: async () => {},
  } as unknown as ExtensionContext;
  return {
    root,
    agentDir,
    cwd,
    sessionFile,
    entries,
    context,
    notifications,
    compactCalls: () => compactCalls,
  };
}

function beforeEvent(entries: SessionEntry[]) {
  const sourceMessage = entries[0]?.type === "message" ? entries[0].message : undefined;
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "entry-2",
      messagesToSummarize: sourceMessage ? [sourceMessage] : [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 20_000,
      fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    },
    branchEntries: entries,
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
  };
}

describe("DS4 custom compaction", () => {
  it("generates, validates, persists, commits, and restores a summary", async () => {
    const data = fixture();
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      idGenerator: () => "summary-test",
      logSink: () => {},
    });
    await pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, data.context);

    const result = await pi.handlers.get("session_before_compact")?.[0]?.(
      beforeEvent(data.entries),
      data.context,
    ) as {
      compaction?: {
        summary: string;
        firstKeptEntryId: string;
        tokensBefore: number;
        usage?: unknown;
        details?: Ds4CompactionDetails;
      };
    } | undefined;
    expect(result?.compaction?.summary).toBe(validSummary());
    expect(result?.compaction?.details?.ds4ContextEngine).toMatchObject({
      summaryId: "summary-test",
      validationStatus: "valid",
      sourceEntryIds: ["entry-1"],
      firstKeptEntryId: "entry-2",
    });
    expect(runtime.diagnostics(data.context).compaction.phase).toBe("prepared");
    const compaction = result?.compaction;
    if (!compaction) throw new Error("Expected custom compaction result");

    const compactionEntry: SessionEntry = {
      type: "compaction",
      id: "compaction-1",
      parentId: "entry-2",
      timestamp: "2026-08-24T00:00:03.000Z",
      summary: compaction.summary,
      firstKeptEntryId: compaction.firstKeptEntryId,
      tokensBefore: compaction.tokensBefore,
      details: compaction.details,
      fromHook: true,
    };
    data.entries.push(compactionEntry);
    appendFileSync(data.sessionFile, `${JSON.stringify(compactionEntry)}\n`);
    await pi.handlers.get("session_compact")?.[0]?.({
      type: "session_compact",
      compactionEntry,
      fromExtension: true,
      reason: "manual",
      willRetry: false,
    }, data.context);
    expect(runtime.diagnostics(data.context).compaction).toMatchObject({
      phase: "committed",
      summaryId: "summary-test",
      validationStatus: "valid",
    });
    await pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, data.context);

    const database = ContextDatabase.open(join(data.agentDir, "ds4-context", "context.db"));
    expect(database.summaries.getLatest("session-test")).toMatchObject({
      id: "summary-test",
      lifecycleStatus: "committed",
      piCompactionEntryId: "compaction-1",
      sourceEntryIds: ["entry-1"],
    });
    database.close();

    const resumedPi = new FakePi();
    const resumed = registerDs4ContextEngine(resumedPi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      logSink: () => {},
    });
    await resumedPi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "resume" }, data.context);
    expect(resumed.diagnostics(data.context).compaction).toMatchObject({
      phase: "committed",
      summaryId: "summary-test",
    });
    await resumedPi.commands.get("context")?.handler("compaction", data.context as unknown as ExtensionCommandContext);
    expect(data.notifications.at(-1)).toContain("Summary ID:              summary-test");
    await resumedPi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, data.context);
  });

  it("falls back to Pi default when deterministic validation fails", async () => {
    const data = fixture("not a structured summary");
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      logSink: () => {},
    });
    await pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, data.context);

    const result = await pi.handlers.get("session_before_compact")?.[0]?.(beforeEvent(data.entries), data.context);
    expect(result).toBeUndefined();
    expect(runtime.diagnostics(data.context).compaction).toMatchObject({
      phase: "failed",
      lastError: expect.stringContaining("validation failed"),
    });
    await pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, data.context);
  });

  it("falls back when summary generation reaches the output cap", async () => {
    const data = fixture(validSummary(), 1_000, "length");
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      logSink: () => {},
    });
    await pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, data.context);

    const result = await pi.handlers.get("session_before_compact")?.[0]?.(beforeEvent(data.entries), data.context);
    expect(result).toBeUndefined();
    expect(runtime.diagnostics(data.context).compaction.lastError).toContain("output limit");
    await pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, data.context);
  });

  it("marks a prepared summary failed when Pi cannot append compaction", async () => {
    const data = fixture();
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      idGenerator: () => "summary-failed",
      logSink: () => {},
    });
    await pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, data.context);
    await pi.handlers.get("session_before_compact")?.[0]?.(beforeEvent(data.entries), data.context);
    await pi.handlers.get("session_compact_failed")?.[0]?.({
      type: "session_compact_failed",
      reason: "manual",
      errorMessage: "disk failure",
      aborted: false,
      willRetry: false,
      fromExtension: true,
    }, data.context);

    expect(runtime.diagnostics(data.context).compaction).toMatchObject({
      phase: "failed",
      summaryId: "summary-failed",
      lastError: "disk failure",
    });
    await pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, data.context);
    const database = ContextDatabase.open(join(data.agentDir, "ds4-context", "context.db"));
    expect(database.summaries.getById("summary-failed")?.lifecycleStatus).toBe("failed");
    database.close();
  });

  it("requests proactive compaction once per settled leaf above the soft limit", async () => {
    const data = fixture(validSummary(), 30_000);
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      logSink: () => {},
    });
    await pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, data.context);

    await pi.handlers.get("agent_settled")?.[0]?.({ type: "agent_settled" }, data.context);
    await pi.handlers.get("agent_settled")?.[0]?.({ type: "agent_settled" }, data.context);

    expect(data.compactCalls()).toBe(1);
    expect(runtime.diagnostics(data.context).compaction).toMatchObject({
      phase: "requested",
      trigger: "proactive",
      proactiveEligible: false,
    });
    await pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, data.context);
  });
});
