import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { Ds4CompactionDetails } from "ds4-context-core/compaction/compaction-record";
import { registerDs4ContextEngine } from "../../src/extension/index.ts";
import { ContextDatabase } from "ds4-context-core/persistence/sqlite";

interface RegisteredCommandLike {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

interface CompactionHookResult {
  compaction?: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    usage?: { input: number; output: number; totalTokens: number };
    details?: Ds4CompactionDetails;
  };
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
  it("preserves privacy classification across local compaction and a remote provider switch", async () => {
    const data = fixture();
    mkdirSync(join(data.cwd, ".pi"), { recursive: true });
    writeFileSync(join(data.cwd, ".pi", "ds4-context.json"), JSON.stringify({
      privacy: { enabled: true, localProviders: ["test"] },
      project: { enabled: false },
      artifacts: { enabled: false },
    }));
    const source = data.entries[0];
    if (!source || source.type !== "message") throw new Error("Expected source message");
    source.message = {
      role: "user",
      content: "[ds4:local-only]COMPACTION-LOCAL-SECRET[/ds4:local-only]",
      timestamp: 1,
    };
    const prompts: string[] = [];
    (data.context.modelRegistry as any).complete = async (_model: unknown, request: any) => {
      prompts.push(JSON.stringify(request));
      return {
        role: "assistant",
        content: [{ type: "text", text: validSummary() }],
        stopReason: "stop",
        usage: {
          input: 100,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 200,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
    };
    const pi = new FakePi();
    registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      idGenerator: () => "privacy-summary",
      logSink: () => {},
    });
    await pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, data.context);
    const result = await pi.handlers.get("session_before_compact")?.[0]?.(
      beforeEvent(data.entries),
      data.context,
    ) as CompactionHookResult;

    expect(prompts.join("\n")).toContain("COMPACTION-LOCAL-SECRET");
    expect(result.compaction?.summary).toContain("[ds4:local-only]");
    (data.context.model as { provider: string }).provider = "remote-test";
    const remote = await pi.handlers.get("context")?.[0]?.({
      type: "context",
      messages: [{
        role: "compactionSummary",
        content: result.compaction?.summary ?? "",
        timestamp: 3,
      }],
    }, data.context) as { messages?: unknown[] };
    expect(JSON.stringify(remote.messages)).not.toContain("COMPACTION-LOCAL-SECRET");
  });

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

  it("emits routine compaction lifecycle logs only at debug level", async () => {
    for (const logLevel of ["info", "debug"] as const) {
      const data = fixture();
      if (logLevel === "debug") {
        mkdirSync(join(data.cwd, ".pi"), { recursive: true });
        writeFileSync(join(data.cwd, ".pi", "ds4-context.json"), JSON.stringify({
          diagnostics: { logLevel },
          project: { enabled: false },
          artifacts: { enabled: false },
        }));
      }
      const logs: string[] = [];
      const pi = new FakePi();
      registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
        agentDir: data.agentDir,
        configDirName: ".pi",
        homeDir: data.root,
        idGenerator: () => `summary-${logLevel}`,
        logSink: (line) => logs.push(line),
      });
      await pi.handlers.get("session_start")?.[0]?.(
        { type: "session_start", reason: "startup" },
        data.context,
      );
      const result = await pi.handlers.get("session_before_compact")?.[0]?.(
        beforeEvent(data.entries),
        data.context,
      ) as CompactionHookResult | undefined;
      const compaction = result?.compaction;
      if (!compaction) throw new Error("Expected custom compaction result");
      const compactionEntry: SessionEntry = {
        type: "compaction",
        id: `compaction-${logLevel}`,
        parentId: "entry-2",
        timestamp: "2026-08-24T00:00:03.000Z",
        summary: compaction.summary,
        firstKeptEntryId: compaction.firstKeptEntryId,
        tokensBefore: compaction.tokensBefore,
        details: compaction.details,
        fromHook: true,
      };
      await pi.handlers.get("session_compact")?.[0]?.({
        type: "session_compact",
        compactionEntry,
        fromExtension: true,
        reason: "manual",
        willRetry: false,
      }, data.context);

      const lifecycleLogs = logs
        .map((line) => JSON.parse(line) as { level?: string; event?: string })
        .filter((entry) => entry.event === "compaction.summary_graph_prepared"
          || entry.event === "compaction.summary_graph_committed")
        .map((entry) => ({ level: entry.level, event: entry.event }));
      expect(lifecycleLogs).toEqual(logLevel === "debug"
        ? [
            { level: "debug", event: "compaction.summary_graph_prepared" },
            { level: "debug", event: "compaction.summary_graph_committed" },
          ]
        : []);
      await pi.handlers.get("session_shutdown")?.[0]?.(
        { type: "session_shutdown", reason: "quit" },
        data.context,
      );
    }
  });

  it.each([false, true])("handles a Pi-native predecessor without synthetic prompt evidence (directUpdate=%s)", async (directUpdate) => {
    const data = fixture();
    mkdirSync(join(data.cwd, ".pi"), { recursive: true });
    writeFileSync(join(data.cwd, ".pi", "ds4-context.json"), JSON.stringify({ compaction: { directUpdate } }));
    const nativeSummary = validSummary().replace(
      "Preserve the discarded conversation state.",
      "Preserve the Pi-native predecessor marker.",
    );
    const nativeEntry: SessionEntry = {
      type: "compaction",
      id: "pi-native-compaction",
      parentId: "entry-2",
      timestamp: "2026-08-24T00:00:03.000Z",
      summary: nativeSummary,
      firstKeptEntryId: "entry-2",
      tokensBefore: 10_000,
      fromHook: false,
    };
    data.entries.push(nativeEntry);
    appendFileSync(data.sessionFile, `${JSON.stringify(nativeEntry)}\n`);
    const prompts: string[] = [];
    (data.context.modelRegistry as any).complete = async (_model: unknown, request: any) => {
      prompts.push(request.messages[0].content[0].text);
      return {
        role: "assistant",
        content: [{ type: "text", text: validSummary() }],
        stopReason: "stop",
        usage: {
          input: 100,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 200,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
    };
    const generatedIds = ["new-segment", "imported-native", "aggregate-transition"];
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      idGenerator: () => generatedIds.shift() ?? "unexpected-id",
      logSink: () => {},
    });
    await pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, data.context);

    const event = beforeEvent(data.entries) as ReturnType<typeof beforeEvent> & {
      preparation: ReturnType<typeof beforeEvent>["preparation"] & { previousSummary?: string };
    };
    event.preparation.previousSummary = nativeSummary;
    const result = await pi.handlers.get("session_before_compact")?.[0]?.(
      event,
      data.context,
    ) as CompactionHookResult | undefined;

    expect(result?.compaction?.details?.ds4ContextEngine).toMatchObject({
      summaryId: directUpdate ? "new-segment" : "aggregate-transition",
      summaryKind: directUpdate ? "task-state" : "aggregate",
      childSummaryIds: directUpdate ? ["imported-native"] : ["imported-native", "new-segment"],
    });
    expect(result?.compaction?.details?.ds4ContextEngine.embeddedNodes[0]).toMatchObject({
      kind: "branch", validationStatus: "warning", validationIssueCodes: ["imported-pi-summary-unverified"],
    });
    expect(prompts).toHaveLength(directUpdate ? 1 : 2);
    expect(prompts.at(-1)).toContain("Pi-native predecessor marker");
    expect(prompts.at(-1)).not.toContain("new-segment");
    expect(prompts.at(-1)).not.toContain("imported-native");
    expect(prompts.at(-1)).not.toContain("sourceHash");
    expect(prompts.at(-1)).not.toContain("graphLevel");
    expect(runtime.diagnostics(data.context).compaction.phase).toBe("prepared");
    await pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, data.context);
  });

  it.each([false, true])("builds and rebuilds immutable graphs across repeated compactions (directUpdate=%s)", async (directUpdate) => {
    const data = fixture();
    mkdirSync(join(data.cwd, ".pi"), { recursive: true });
    writeFileSync(join(data.cwd, ".pi", "ds4-context.json"), JSON.stringify({ compaction: { directUpdate } }));
    const pi = new FakePi();
    const generatedIds = directUpdate ? ["segment-1", "aggregate-1", "aggregate-2"] : ["segment-1", "segment-2", "aggregate-1", "segment-3", "aggregate-2"];
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      idGenerator: () => generatedIds.shift() ?? "unexpected-id",
      logSink: () => {},
    });
    await pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, data.context);

    const commitCompaction = async (
      id: string,
      sourceEntry: Extract<SessionEntry, { type: "message" }>,
      retainedEntry: Extract<SessionEntry, { type: "message" }>,
      previousSummary?: string,
    ): Promise<CompactionHookResult["compaction"]> => {
      const result = await pi.handlers.get("session_before_compact")?.[0]?.({
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: retainedEntry.id,
          messagesToSummarize: [sourceEntry.message],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 20_000,
          ...(previousSummary ? { previousSummary } : {}),
          fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
          settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
        },
        branchEntries: data.entries,
        reason: "manual",
        willRetry: false,
        signal: new AbortController().signal,
      }, data.context) as CompactionHookResult | undefined;
      const compaction = result?.compaction;
      if (!compaction) throw new Error("Expected hierarchical compaction result");
      const entry: SessionEntry = {
        type: "compaction",
        id,
        parentId: retainedEntry.id,
        timestamp: `2026-08-24T00:00:${String(data.entries.length + 1).padStart(2, "0")}.000Z`,
        summary: compaction.summary,
        firstKeptEntryId: compaction.firstKeptEntryId,
        tokensBefore: compaction.tokensBefore,
        details: compaction.details,
        fromHook: true,
      };
      data.entries.push(entry);
      appendFileSync(data.sessionFile, `${JSON.stringify(entry)}\n`);
      const staleDuplicateSummaryEntry = data.entries.find(
        (candidate): candidate is Extract<SessionEntry, { type: "compaction" }> => candidate.type === "compaction",
      ) ?? entry;
      await pi.handlers.get("session_compact")?.[0]?.({
        type: "session_compact",
        // Pi 0.84.3 locates the saved entry by summary text; identical summaries can surface the first entry.
        compactionEntry: staleDuplicateSummaryEntry,
        fromExtension: true,
        reason: "manual",
        willRetry: false,
      }, data.context);
      return compaction;
    };

    const firstSource = data.entries[0];
    const firstRetained = data.entries[1];
    if (firstSource?.type !== "message" || firstRetained?.type !== "message") throw new Error("Invalid fixture");
    const first = await commitCompaction("compaction-1", firstSource, firstRetained);
    expect(first?.details?.ds4ContextEngine).toMatchObject({
      summaryId: "segment-1",
      summaryKind: "segment",
      graphLevel: 0,
      childSummaryIds: [],
    });

    const secondSource: Extract<SessionEntry, { type: "message" }> = {
      type: "message",
      id: "entry-3",
      parentId: "compaction-1",
      timestamp: "2026-08-24T00:00:04.000Z",
      message: { role: "user", content: "second discarded source", timestamp: 4 },
    };
    const secondRetained: Extract<SessionEntry, { type: "message" }> = {
      type: "message",
      id: "entry-4",
      parentId: "entry-3",
      timestamp: "2026-08-24T00:00:05.000Z",
      message: { role: "user", content: "second retained source", timestamp: 5 },
    };
    data.entries.push(secondSource, secondRetained);
    appendFileSync(data.sessionFile, `${JSON.stringify(secondSource)}\n${JSON.stringify(secondRetained)}\n`);
    const second = await commitCompaction("compaction-2", secondSource, secondRetained, first?.summary);
    expect(second?.details?.ds4ContextEngine).toMatchObject({
      summaryId: "aggregate-1",
      segmentSummaryId: directUpdate ? "aggregate-1" : "segment-2",
      summaryKind: directUpdate ? "task-state" : "aggregate",
      graphLevel: 1,
      childSummaryIds: directUpdate ? ["segment-1"] : ["segment-1", "segment-2"],
      sourceEntryIds: ["entry-1", "entry-3"],
    });
    expect(second?.details?.ds4ContextEngine.embeddedNodes.map((node) => node.id)).toEqual(directUpdate ? [] : ["segment-2"]);
    expect(second?.usage).toMatchObject(directUpdate ? { input: 100, output: 100, totalTokens: 200 } : { input: 200, output: 200, totalTokens: 400 });
    expect(runtime.diagnostics(data.context).compaction).toMatchObject({
      path: directUpdate ? "direct-update" : "hierarchical",
      provider: "test", model: "model-test", summaryCalls: directUpdate ? 1 : 2,
      segmentCount: directUpdate ? 0 : 1, aggregateCalls: directUpdate ? 0 : 1,
      timings: { totalMs: expect.any(Number), generationMs: expect.any(Number) },
    });

    const thirdSource: Extract<SessionEntry, { type: "message" }> = {
      type: "message",
      id: "entry-5",
      parentId: "compaction-2",
      timestamp: "2026-08-24T00:00:07.000Z",
      message: { role: "user", content: "third discarded source", timestamp: 7 },
    };
    const thirdRetained: Extract<SessionEntry, { type: "message" }> = {
      type: "message",
      id: "entry-6",
      parentId: "entry-5",
      timestamp: "2026-08-24T00:00:08.000Z",
      message: { role: "user", content: "third retained source", timestamp: 8 },
    };
    data.entries.push(thirdSource, thirdRetained);
    appendFileSync(data.sessionFile, `${JSON.stringify(thirdSource)}\n${JSON.stringify(thirdRetained)}\n`);
    const third = await commitCompaction("compaction-3", thirdSource, thirdRetained, second?.summary);
    expect(third?.details?.ds4ContextEngine).toMatchObject({
      summaryId: "aggregate-2",
      segmentSummaryId: directUpdate ? "aggregate-2" : "segment-3",
      summaryKind: directUpdate ? "task-state" : "aggregate",
      graphLevel: 2,
      childSummaryIds: directUpdate ? ["aggregate-1"] : ["aggregate-1", "segment-3"],
      sourceEntryIds: ["entry-1", "entry-3", "entry-5"],
    });

    const graph = runtime.summaryGraph(data.context);
    expect(graph).toMatchObject({
      totalNodes: directUpdate ? 3 : 5,
      committedNodes: directUpdate ? 3 : 5,
      segmentNodes: directUpdate ? 1 : 3,
      aggregateNodes: directUpdate ? 0 : 2,
      taskStateNodes: directUpdate ? 2 : 0,
      maxGraphLevel: 2,
      activeSummaryId: "aggregate-2",
    });
    expect(new Set(graph.activePathIds)).toEqual(new Set([
      "segment-1",
      ...(!directUpdate ? ["segment-2", "segment-3"] : []),
      "aggregate-1",
      "aggregate-2",
    ]));
    await pi.commands.get("context")?.handler("summaries", data.context as unknown as ExtensionCommandContext);
    expect(data.notifications.at(-1)).toContain("DS4 Hierarchical Summary Graph");
    expect(data.notifications.at(-1)).toContain("aggregate-2");

    await pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, data.context);
    const database = ContextDatabase.open(join(data.agentDir, "ds4-context", "context.db"));
    const records = database.summaries.listBySession("session-test");
    expect(records).toHaveLength(directUpdate ? 3 : 5);
    expect(records.find((record) => record.id === "segment-1")?.content).toBe(validSummary());
    expect(records.find((record) => record.id === "aggregate-2")).toMatchObject({
      childSummaryIds: directUpdate ? ["aggregate-1"] : ["aggregate-1", "segment-3"],
      graphLevel: 2,
      lifecycleStatus: "committed",
      piCompactionEntryId: "compaction-3",
    });
    database.close();

    const databasePath = join(data.agentDir, "ds4-context", "context.db");
    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
    const rebuiltPi = new FakePi();
    const rebuilt = registerDs4ContextEngine(rebuiltPi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      logSink: () => {},
    });
    await rebuiltPi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "resume" }, data.context);
    expect(rebuilt.summaryGraph(data.context)).toMatchObject({
      totalNodes: directUpdate ? 3 : 5,
      committedNodes: directUpdate ? 3 : 5,
      taskStateNodes: directUpdate ? 2 : 0,
      activeSummaryId: "aggregate-2",
      maxGraphLevel: 2,
    });
    await rebuiltPi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, data.context);
  });

  it("fans an oversized source out into bounded segments and one aggregate compaction result", async () => {
    const data = fixture();
    Object.assign(data.context.model as object, {
      contextWindow: 8_000,
      maxTokens: 1_024,
    });
    const sourceEntries: SessionEntry[] = ["one", "two", "three"].map((label, index) => ({
      type: "message",
      id: `source-${index + 1}`,
      parentId: index === 0 ? null : `source-${index}`,
      timestamp: `2026-08-24T00:00:0${index + 1}.000Z`,
      message: {
        role: "user",
        content: `segment-${label} ${label.slice(0, 1).repeat(14_000)}`,
        timestamp: index + 1,
      },
    }));
    const retained: SessionEntry = {
      type: "message",
      id: "retained",
      parentId: "source-3",
      timestamp: "2026-08-24T00:00:04.000Z",
      message: { role: "user", content: "retained source", timestamp: 4 },
    };
    data.entries.splice(0, data.entries.length, ...sourceEntries, retained);
    writeFileSync(
      data.sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-test",
          timestamp: "2026-08-24T00:00:00.000Z",
          cwd: data.cwd,
        }),
        ...data.entries.map((entry) => JSON.stringify(entry)),
      ].join("\n") + "\n",
    );
    const prompts: string[] = [];
    (data.context.modelRegistry as any).complete = async (_model: unknown, request: any) => {
      prompts.push(request.messages[0].content[0].text);
      return {
        role: "assistant",
        content: [{ type: "text", text: validSummary() }],
        stopReason: "stop",
        usage: {
          input: 100,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 200,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
    };
    const generatedIds = ["segment-1", "segment-2", "segment-3", "aggregate-1"];
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      idGenerator: () => generatedIds.shift() ?? "unexpected-id",
      logSink: () => {},
    });
    await pi.handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "startup" },
      data.context,
    );

    const result = await pi.handlers.get("session_before_compact")?.[0]?.({
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "retained",
        messagesToSummarize: sourceEntries.flatMap((entry) => entry.type === "message" ? [entry.message] : []),
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 20_000,
        fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
        settings: { enabled: true, reserveTokens: 1_024, keepRecentTokens: 1_000 },
      },
      branchEntries: data.entries,
      reason: "overflow",
      willRetry: true,
      signal: new AbortController().signal,
    }, data.context) as CompactionHookResult | undefined;

    expect(prompts).toHaveLength(4);
    expect(result?.compaction?.usage).toMatchObject({ input: 400, output: 400, totalTokens: 800 });
    expect(result?.compaction?.details?.ds4ContextEngine).toMatchObject({
      summaryId: "aggregate-1",
      summaryKind: "aggregate",
      childSummaryIds: ["segment-1", "segment-2", "segment-3"],
      sourceEntryIds: ["source-1", "source-2", "source-3"],
    });
    expect(result?.compaction?.details?.ds4ContextEngine.embeddedNodes.map((node) => node.id)).toEqual([
      "segment-1",
      "segment-2",
      "segment-3",
    ]);
    expect(runtime.diagnostics(data.context).compaction).toMatchObject({
      phase: "prepared",
      segmentCount: 3,
      aggregateCalls: 1,
    });
    expect(runtime.diagnostics(data.context).compaction.sourcePromptTokens)
      .toBeGreaterThan(runtime.diagnostics(data.context).compaction.inputBudgetTokens ?? 0);
    await pi.handlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown", reason: "quit" },
      data.context,
    );
  });

  it("recursively aggregates segment summaries when one fan-in request would exceed budget", async () => {
    const generatedSummary = validSummary().replace(
      "Preserve the discarded conversation state.",
      "A".repeat(1_800),
    );
    const data = fixture(generatedSummary);
    Object.assign(data.context.model as object, {
      contextWindow: 4_000,
      maxTokens: 512,
    });
    const sourceEntries: SessionEntry[] = Array.from({ length: 6 }, (_, index) => ({
      type: "message",
      id: `recursive-source-${index + 1}`,
      parentId: index === 0 ? null : `recursive-source-${index}`,
      timestamp: `2026-08-24T00:00:${String(index + 1).padStart(2, "0")}.000Z`,
      message: {
        role: "user",
        content: `recursive-${index + 1} ${String(index).repeat(4_500)}`,
        timestamp: index + 1,
      },
    }));
    const retained: SessionEntry = {
      type: "message",
      id: "recursive-retained",
      parentId: "recursive-source-6",
      timestamp: "2026-08-24T00:00:07.000Z",
      message: { role: "user", content: "retained source", timestamp: 7 },
    };
    data.entries.splice(0, data.entries.length, ...sourceEntries, retained);
    writeFileSync(
      data.sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-test",
          timestamp: "2026-08-24T00:00:00.000Z",
          cwd: data.cwd,
        }),
        ...data.entries.map((entry) => JSON.stringify(entry)),
      ].join("\n") + "\n",
    );
    let calls = 0;
    (data.context.modelRegistry as any).complete = async () => {
      calls++;
      return {
        role: "assistant",
        content: [{ type: "text", text: generatedSummary }],
        stopReason: "stop",
        usage: {
          input: 100,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 200,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
    };
    const generatedIds = [
      "recursive-segment-1",
      "recursive-segment-2",
      "recursive-segment-3",
      "recursive-segment-4",
      "recursive-segment-5",
      "recursive-segment-6",
      "recursive-aggregate-1",
      "recursive-aggregate-2",
      "recursive-root",
    ];
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      idGenerator: () => generatedIds.shift() ?? "unexpected-id",
      logSink: () => {},
    });
    await pi.handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "startup" },
      data.context,
    );

    const result = await pi.handlers.get("session_before_compact")?.[0]?.({
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "recursive-retained",
        messagesToSummarize: sourceEntries.flatMap((entry) => entry.type === "message" ? [entry.message] : []),
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 30_000,
        fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
        settings: { enabled: true, reserveTokens: 512, keepRecentTokens: 500 },
      },
      branchEntries: data.entries,
      reason: "overflow",
      willRetry: true,
      signal: new AbortController().signal,
    }, data.context) as CompactionHookResult | undefined;

    expect(calls).toBe(9);
    expect(runtime.diagnostics(data.context).compaction).toMatchObject({
      phase: "prepared",
      segmentCount: 6,
      aggregateCalls: 3,
    });
    expect(result?.compaction?.details?.ds4ContextEngine).toMatchObject({
      summaryId: "recursive-root",
      summaryKind: "aggregate",
      graphLevel: 2,
      childSummaryIds: ["recursive-aggregate-1", "recursive-aggregate-2"],
    });
    expect(result?.compaction?.details?.ds4ContextEngine.embeddedNodes).toHaveLength(8);
    await pi.handlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown", reason: "quit" },
      data.context,
    );
  });

  it("fails closed before model invocation when one message is above the segment budget", async () => {
    const data = fixture();
    Object.assign(data.context.model as object, {
      contextWindow: 8_000,
      maxTokens: 1_024,
    });
    const source = data.entries[0];
    if (!source || source.type !== "message") throw new Error("Expected source message");
    source.message = {
      role: "user",
      content: `oversized-private-source ${"x".repeat(30_000)}`,
      timestamp: 1,
    };
    let calls = 0;
    (data.context.modelRegistry as any).complete = async () => {
      calls++;
      throw new Error("must not be called");
    };
    const logs: string[] = [];
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      logSink: (line) => logs.push(line),
    });
    await pi.handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "startup" },
      data.context,
    );

    const result = await pi.handlers.get("session_before_compact")?.[0]?.(
      beforeEvent(data.entries),
      data.context,
    );

    expect(result).toBeUndefined();
    expect(calls).toBe(0);
    expect(runtime.diagnostics(data.context).compaction.lastError).toContain("indivisible atomic group");
    expect(logs.join("\n")).not.toContain("oversized-private-source");
    await pi.handlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown", reason: "quit" },
      data.context,
    );
  });

  it("prunes a bounded unsupported exact-value bullet and preserves strict validation", async () => {
    const generated = validSummary().replace(
      "## Objective\n- Preserve the discarded conversation state.",
      "## Objective\n- Preserve the discarded conversation state.\n- Record `invented-exact-value`.",
    );
    const data = fixture(generated);
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      idGenerator: () => "summary-pruned",
      logSink: () => {},
    });
    await pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, data.context);

    const result = await pi.handlers.get("session_before_compact")?.[0]?.(
      beforeEvent(data.entries),
      data.context,
    ) as CompactionHookResult | undefined;

    expect(result?.compaction?.summary).not.toContain("invented-exact-value");
    expect(result?.compaction?.details?.ds4ContextEngine).toMatchObject({
      validationStatus: "warning",
      validationIssueCodes: ["unsupported-exact-bullets-pruned"],
    });
    expect(runtime.diagnostics(data.context).compaction).toMatchObject({
      phase: "prepared",
      validationStatus: "warning",
    });
    await pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, data.context);
  });

  it("reports privacy-safe exact-value repair diagnostics before falling back", async () => {
    const generated = validSummary().replace(
      "## Objective\n- Preserve the discarded conversation state.",
      "## Objective\nUnsupported `invented-exact-value`.",
    );
    const data = fixture(generated);
    const logs: string[] = [];
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      logSink: (line) => logs.push(line),
    });
    await pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, data.context);

    const result = await pi.handlers.get("session_before_compact")?.[0]?.(beforeEvent(data.entries), data.context);

    expect(result).toBeUndefined();
    expect(runtime.diagnostics(data.context).compaction).toMatchObject({
      phase: "failed",
      lastError: expect.stringContaining(
        "repair=unsupported-location; unsupportedSpans=1; affectedBullets=0",
      ),
    });
    expect(logs.join("\n")).not.toContain("invented-exact-value");
    expect(logs.map((line) => JSON.parse(line)).find(
      (entry) => entry.event === "compaction.custom_fallback",
    )).toMatchObject({
      level: "warn",
      event: "compaction.custom_fallback",
    });
    expect(data.notifications.join("\n")).not.toContain("invented-exact-value");
    await pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, data.context);
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

  it("retries a transient transport response and sums usage without exposing provider details", async () => {
    const data = fixture();
    mkdirSync(join(data.cwd, ".pi"), { recursive: true });
    writeFileSync(join(data.cwd, ".pi", "ds4-context.json"), JSON.stringify({
      diagnostics: { logLevel: "debug" },
      compaction: { transport: { baseDelayMs: 1 } },
    }));
    const successfulComplete = data.context.modelRegistry.complete.bind(data.context.modelRegistry);
    let calls = 0;
    (data.context.modelRegistry as any).complete = async (...args: unknown[]) => {
      calls++;
      if (calls === 1) {
        return {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "socket reset PRIVATE-TRANSPORT-DETAIL",
          usage: {
            input: 3,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
      }
      return successfulComplete(...args as Parameters<typeof successfulComplete>);
    };
    const logs: string[] = [];
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      logSink: (line) => logs.push(line),
    });
    await pi.handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "startup" },
      data.context,
    );

    const result = await pi.handlers.get("session_before_compact")?.[0]?.(
      beforeEvent(data.entries),
      data.context,
    ) as CompactionHookResult | undefined;

    expect(calls).toBe(2);
    expect(result?.compaction?.usage).toMatchObject({ input: 103, totalTokens: 203 });
    expect(runtime.diagnostics(data.context).compaction).toMatchObject({
      phase: "prepared",
      transportRetries: 1,
    });
    expect(logs.map((line) => JSON.parse(line)).find(
      (entry) => entry.event === "compaction.transport_retry",
    )).toMatchObject({
      level: "debug",
      metadata: {
        stage: "segment",
        failedAttempt: 1,
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 1,
      },
    });
    expect(logs.join("\n")).not.toContain("PRIVATE-TRANSPORT-DETAIL");
    await pi.handlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown", reason: "quit" },
      data.context,
    );
  });

  it("retries a thrown transport failure with a fresh routing session and then succeeds", async () => {
    const data = fixture();
    mkdirSync(join(data.cwd, ".pi"), { recursive: true });
    writeFileSync(join(data.cwd, ".pi", "ds4-context.json"), JSON.stringify({
      compaction: { transport: { baseDelayMs: 1 } },
    }));
    const successfulComplete = data.context.modelRegistry.complete.bind(data.context.modelRegistry);
    const routingSessionIds: string[] = [];
    let calls = 0;
    (data.context.modelRegistry as any).complete = async (...args: unknown[]) => {
      calls++;
      const options = args[2] as { sessionId?: string } | undefined;
      if (options?.sessionId) routingSessionIds.push(options.sessionId);
      if (calls === 1) throw new Error("ECONNABORTED PRIVATE-THROWN-TRANSPORT-DETAIL");
      return successfulComplete(...args as Parameters<typeof successfulComplete>);
    };
    const logs: string[] = [];
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      logSink: (line) => logs.push(line),
    });
    await pi.handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "startup" },
      data.context,
    );

    const result = await pi.handlers.get("session_before_compact")?.[0]?.(
      beforeEvent(data.entries),
      data.context,
    ) as CompactionHookResult | undefined;

    expect(calls).toBe(2);
    expect(new Set(routingSessionIds).size).toBe(2);
    expect(result?.compaction?.usage).toMatchObject({ input: 100, totalTokens: 200 });
    expect(runtime.diagnostics(data.context).compaction).toMatchObject({
      phase: "prepared",
      transportRetries: 1,
    });
    expect(logs.join("\n")).not.toContain("PRIVATE-THROWN-TRANSPORT-DETAIL");
    await pi.handlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown", reason: "quit" },
      data.context,
    );
  });

  it("bounds persistent thrown transport failures to three attempts before safe fallback", async () => {
    const data = fixture();
    mkdirSync(join(data.cwd, ".pi"), { recursive: true });
    writeFileSync(join(data.cwd, ".pi", "ds4-context.json"), JSON.stringify({
      compaction: { transport: { baseDelayMs: 1 } },
    }));
    const routingSessionIds: string[] = [];
    let calls = 0;
    (data.context.modelRegistry as any).complete = async (...args: unknown[]) => {
      calls++;
      const options = args[2] as { sessionId?: string } | undefined;
      if (options?.sessionId) routingSessionIds.push(options.sessionId);
      throw new Error("connection timeout PRIVATE-PERSISTENT-TRANSPORT-DETAIL");
    };
    const logs: string[] = [];
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      logSink: (line) => logs.push(line),
    });
    await pi.handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "startup" },
      data.context,
    );

    const result = await pi.handlers.get("session_before_compact")?.[0]?.(
      beforeEvent(data.entries),
      data.context,
    );

    expect(result).toBeUndefined();
    expect(calls).toBe(3);
    expect(new Set(routingSessionIds).size).toBe(3);
    expect(runtime.diagnostics(data.context).compaction).toMatchObject({
      phase: "failed",
      transportRetries: 2,
      lastError: expect.stringContaining("category=transport; attempts=3"),
    });
    expect(logs.join("\n")).not.toContain("PRIVATE-PERSISTENT-TRANSPORT-DETAIL");
    await pi.handlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown", reason: "quit" },
      data.context,
    );
  });

  it("honors a configurable transport retry policy", async () => {
    const data = fixture();
    mkdirSync(join(data.cwd, ".pi"), { recursive: true });
    writeFileSync(join(data.cwd, ".pi", "ds4-context.json"), JSON.stringify({
      diagnostics: { logLevel: "debug" },
      compaction: { transport: { maxAttempts: 2, baseDelayMs: 1 } },
    }));
    let calls = 0;
    (data.context.modelRegistry as any).complete = async (...args: unknown[]) => {
      calls++;
      throw new Error("connection reset PRIVATE-CONFIGURED-DETAIL");
    };
    const logs: string[] = [];
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      logSink: (line) => logs.push(line),
    });
    await pi.handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "startup" },
      data.context,
    );

    const result = await pi.handlers.get("session_before_compact")?.[0]?.(
      beforeEvent(data.entries),
      data.context,
    );

    expect(result).toBeUndefined();
    expect(calls).toBe(2);
    expect(runtime.diagnostics(data.context).compaction).toMatchObject({
      phase: "failed",
      transportRetries: 1,
      lastError: expect.stringContaining("category=transport; attempts=2"),
    });
    expect(logs.map((line) => JSON.parse(line)).find(
      (entry) => entry.event === "compaction.transport_retry",
    )).toMatchObject({
      metadata: { failedAttempt: 1, nextAttempt: 2, maxAttempts: 2, delayMs: 1 },
    });
    await pi.handlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown", reason: "quit" },
      data.context,
    );
  });

  it("does not retry a transport failure after compaction is aborted", async () => {
    const data = fixture();
    const controller = new AbortController();
    let calls = 0;
    (data.context.modelRegistry as any).complete = async () => {
      calls++;
      controller.abort();
      throw new Error("network timeout PRIVATE-ABORTED-DETAIL");
    };
    const logs: string[] = [];
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      logSink: (line) => logs.push(line),
    });
    await pi.handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "startup" },
      data.context,
    );
    const event = beforeEvent(data.entries);
    event.signal = controller.signal;

    const result = await pi.handlers.get("session_before_compact")?.[0]?.(event, data.context);

    expect(result).toBeUndefined();
    expect(calls).toBe(1);
    expect(runtime.diagnostics(data.context).compaction).toMatchObject({
      phase: "failed",
      transportRetries: 0,
      lastError: "Compaction summary generation aborted",
    });
    expect(logs.join("\n")).not.toContain("PRIVATE-ABORTED-DETAIL");
    await pi.handlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown", reason: "quit" },
      data.context,
    );
  });

  it("honors an abort that fires during the transport retry delay", async () => {
    const data = fixture();
    const controller = new AbortController();
    let calls = 0;
    (data.context.modelRegistry as any).complete = async () => {
      calls++;
      setTimeout(() => controller.abort(), 10);
      return {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "socket timeout PRIVATE-DELAY-ABORT-DETAIL",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
    };
    const logs: string[] = [];
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      logSink: (line) => logs.push(line),
    });
    await pi.handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "startup" },
      data.context,
    );
    const event = beforeEvent(data.entries);
    event.signal = controller.signal;

    const result = await pi.handlers.get("session_before_compact")?.[0]?.(event, data.context);

    expect(result).toBeUndefined();
    expect(calls).toBe(1);
    expect(runtime.diagnostics(data.context).compaction).toMatchObject({
      phase: "failed",
      transportRetries: 0,
      lastError: "Compaction summary generation aborted",
    });
    expect(logs.join("\n")).not.toContain("PRIVATE-DELAY-ABORT-DETAIL");
    await pi.handlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown", reason: "quit" },
      data.context,
    );
  });

  it("categorizes provider input-limit failures without exposing raw provider details", async () => {
    const data = fixture();
    let calls = 0;
    (data.context.modelRegistry as any).complete = async () => {
      calls++;
      return {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Input validation error: 504278 prompt tokens exceed 272000; PRIVATE-PROVIDER-DETAIL",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    };
    const logs: string[] = [];
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      logSink: (line) => logs.push(line),
    });
    await pi.handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "startup" },
      data.context,
    );

    const result = await pi.handlers.get("session_before_compact")?.[0]?.(
      beforeEvent(data.entries),
      data.context,
    );

    expect(result).toBeUndefined();
    expect(calls).toBe(1);
    expect(runtime.diagnostics(data.context).compaction.lastError).toContain("category=input-limit");
    expect(runtime.diagnostics(data.context).compaction.lastError).not.toContain("504278");
    expect(logs.join("\n")).not.toContain("PRIVATE-PROVIDER-DETAIL");
    await pi.handlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown", reason: "quit" },
      data.context,
    );
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

  it("keeps calibrated proactive thresholds in provider-token units", async () => {
    const data = fixture(validSummary(), 60_000);
    Object.assign(data.context.model as object, {
      contextWindow: 128_000,
      maxTokens: 16_384,
    });
    (data.context as unknown as { getContextUsage: () => unknown }).getContextUsage = () => ({
      tokens: 60_000,
      contextWindow: 128_000,
      percent: 46.875,
    });
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      logSink: () => {},
    });
    await pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, data.context);

    const calibration = new DatabaseSync(join(data.agentDir, "ds4-context", "context.db"));
    calibration.exec(`
      INSERT INTO token_calibration(
        provider, model, estimated, actual, ratio, created_at,
        estimator_version, input_tokens, cache_read_tokens, cache_write_tokens
      ) VALUES
        ('test', 'model-test', 1000, 2000, 2, 1, 'chars-v1', 2000, 0, 0),
        ('test', 'model-test', 1000, 2000, 2, 2, 'chars-v1', 2000, 0, 0),
        ('test', 'model-test', 1000, 2000, 2, 3, 'chars-v1', 2000, 0, 0)
    `);
    calibration.close();

    await pi.handlers.get("agent_settled")?.[0]?.({ type: "agent_settled" }, data.context);

    expect(data.compactCalls()).toBe(0);
    expect(runtime.diagnostics(data.context).compaction).toMatchObject({
      contextTokens: 60_000,
      softLimitTokens: 102_400,
      proactiveThresholdTokens: 84_000,
      proactiveEligible: false,
    });
    await pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, data.context);
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

describe("DS4 compaction dedicated model and thinking", () => {
  async function runCompaction(
    data: ReturnType<typeof fixture>,
    configExtra: Record<string, unknown>,
  ): Promise<{
    receivedModels: unknown[];
    receivedOptions: unknown[];
    result?: CompactionHookResult;
  }> {
    mkdirSync(join(data.cwd, ".pi"), { recursive: true });
    writeFileSync(join(data.cwd, ".pi", "ds4-context.json"), JSON.stringify({
      project: { enabled: false },
      artifacts: { enabled: false },
      ...configExtra,
    }));
    const receivedModels: unknown[] = [];
    const receivedOptions: unknown[] = [];
    const originalComplete = (data.context.modelRegistry as any).complete.bind(data.context.modelRegistry);
    (data.context.modelRegistry as any).complete = (model: unknown, request: unknown, options: unknown) => {
      receivedModels.push(model);
      receivedOptions.push(options);
      return originalComplete(model, request, options);
    };
    if (!(data.context.modelRegistry as any).find) {
      (data.context.modelRegistry as any).find = () => undefined;
    }
    if (!(data.context.modelRegistry as any).hasConfiguredAuth) {
      (data.context.modelRegistry as any).hasConfiguredAuth = () => true;
    }
    const pi = new FakePi();
    registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir: data.agentDir,
      configDirName: ".pi",
      homeDir: data.root,
      idGenerator: () => "dedicated-summary",
      logSink: () => {},
    });
    await pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, data.context);
    const result = await pi.handlers.get("session_before_compact")?.[0]?.(
      beforeEvent(data.entries),
      data.context,
    ) as CompactionHookResult | undefined;
    await pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, data.context);
    return { receivedModels, receivedOptions, result };
  }

  it("uses the configured dedicated model for segment and aggregate calls", async () => {
    const data = fixture();
    const dedicated = { ...data.context.model, id: "dedicated-model", provider: "dedicated-provider" };
    (data.context.modelRegistry as any).find = (provider: string, id: string) =>
      provider === "dedicated-provider" && id === "dedicated-model" ? dedicated : undefined;
    (data.context.modelRegistry as any).hasConfiguredAuth = () => true;
    const { receivedModels, result } = await runCompaction(data, {
      compaction: { model: { provider: "dedicated-provider", id: "dedicated-model" } },
    });
    expect(result?.compaction?.summary).toBe(validSummary());
    expect(receivedModels.length).toBeGreaterThan(0);
    for (const model of receivedModels) {
      expect(model).toMatchObject({ provider: "dedicated-provider", id: "dedicated-model" });
    }
  });

  it("falls back to the session model when the dedicated model is not registered", async () => {
    const data = fixture();
    (data.context.modelRegistry as any).find = () => undefined;
    const { receivedModels } = await runCompaction(data, {
      compaction: { model: { provider: "missing-provider", id: "missing-model" } },
    });
    expect(receivedModels.length).toBeGreaterThan(0);
    for (const model of receivedModels) {
      expect(model).toMatchObject({ provider: "test", id: "model-test" });
    }
  });

  it("falls back to the session model when the dedicated model lacks authentication", async () => {
    const data = fixture();
    const dedicated = { ...data.context.model, id: "dedicated-model", provider: "dedicated-provider" };
    (data.context.modelRegistry as any).find = () => dedicated;
    (data.context.modelRegistry as any).hasConfiguredAuth = () => false;
    const { receivedModels } = await runCompaction(data, {
      compaction: { model: { provider: "dedicated-provider", id: "dedicated-model" } },
    });
    expect(receivedModels.length).toBeGreaterThan(0);
    for (const model of receivedModels) {
      expect(model).toMatchObject({ provider: "test", id: "model-test" });
    }
  });

  it("maps the configured thinking level into provider request options", async () => {
    const data = fixture();
    const { receivedOptions } = await runCompaction(data, {
      compaction: { summary: { thinking: "high" } },
    });
    expect(receivedOptions.length).toBeGreaterThan(0);
    for (const options of receivedOptions) {
      expect(options).toMatchObject({ samplingParams: { reasoning_effort: "high" } });
    }
  });

  it("keeps the request shape unchanged when thinking is off or absent", async () => {
    const data = fixture();
    const { receivedOptions } = await runCompaction(data, {});
    expect(receivedOptions.length).toBeGreaterThan(0);
    for (const options of receivedOptions) {
      const record = options as Record<string, unknown>;
      expect(record.samplingParams).toBeUndefined();
      expect(record.thinkingEnabled).toBeUndefined();
    }
  });
});
