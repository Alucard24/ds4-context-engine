import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { registerDs4ContextEngine } from "../../src/extension/index.ts";
import { MEMORY_CUSTOM_ENTRY_TYPE, PIN_CUSTOM_ENTRY_TYPE } from "ds4-context-core/memory/memory-types";
import { RANKING_FEEDBACK_CUSTOM_ENTRY_TYPE } from "ds4-context-core/ranking/learned-ranker";

class FakePi {
  readonly handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  readonly commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  readonly tools: any[] = [];
  private custom = 0;

  constructor(
    private readonly entries: SessionEntry[],
    private readonly sessionFile: string,
  ) {}

  on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }): void {
    this.commands.set(name, command);
  }

  registerTool(tool: any): void { this.tools.push({ ...tool, sourceInfo: { source: "extension" } }); }
  getActiveTools(): string[] { return this.tools.map((tool) => tool.name); }
  getAllTools(): any[] { return this.tools; }

  appendEntry(customType: string, data: unknown): void {
    const parentId = this.entries.at(-1)?.id ?? null;
    const entry = {
      type: "custom" as const,
      id: `custom-${++this.custom}`,
      parentId,
      timestamp: new Date(1_780_000_000_000 + this.custom).toISOString(),
      customType,
      data,
    };
    this.entries.push(entry);
    appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
  }
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(crossSession = false) {
  const root = mkdtempSync(join(tmpdir(), "ds4-memory-extension-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(project, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
    project: { enabled: false },
    memory: { crossSession },
  }));
  const user = {
    role: "user" as const,
    content: "Keep the Package export mode decision while continuing this task.",
    timestamp: 1,
  };
  const entries: SessionEntry[] = [{
    type: "message",
    id: "user-1",
    parentId: null,
    timestamp: "2026-08-24T00:00:01.000Z",
    message: user,
  }];
  const sessionFile = join(root, "session.jsonl");
  writeFileSync(sessionFile, [
    JSON.stringify({ type: "session", version: 3, id: "memory-session", timestamp: "2026-08-24T00:00:00.000Z", cwd: project }),
    ...entries.map((entry) => JSON.stringify(entry)),
  ].join("\n") + "\n");
  const notifications: string[] = [];
  let branchEntries = entries;
  const context = {
    cwd: project,
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
      confirm: async () => true,
    },
    sessionManager: {
      getSessionId: () => "memory-session",
      getSessionFile: () => sessionFile,
      getLeafId: () => branchEntries.at(-1)?.id ?? null,
      getEntries: () => entries,
      getBranch: () => branchEntries,
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
  return {
    root,
    project,
    agentDir,
    entries,
    sessionFile,
    user,
    notifications,
    context,
    setBranch(value: SessionEntry[]) { branchEntries = value; },
  };
}

function runtimeFor(data: ReturnType<typeof fixture>, idPrefix: string) {
  const pi = new FakePi(data.entries, data.sessionFile);
  const logs: string[] = [];
  let id = 0;
  const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
    agentDir: data.agentDir,
    configDirName: ".pi",
    homeDir: data.root,
    idGenerator: () => `${idPrefix}-${++id}`,
    now: (() => { let value = 1_780_000_100_000; return () => value++; })(),
    logSink: (line) => logs.push(line),
  });
  return { pi, runtime, logs };
}

describe("DS4 memory and pins extension integration", () => {
  it("discovers, injects, diagnoses, and excludes project memory from sibling Pi sessions", async () => {
    const data = fixture(true);
    const sourceFile = join(data.root, "historical.jsonl");
    const sourceMutation = {
      schemaVersion: 1,
      mutationId: "historical-mutation",
      operation: "add",
      createdAt: 1_780_000_050_000,
      item: {
        id: "historical-memory",
        scope: "project",
        projectPath: data.project,
        key: "historical-database",
        classification: "internal",
        claim: "Historical sessions selected SQLite.",
        createdAt: 1_780_000_050_000,
        sourceEntryIds: ["historical-user"],
      },
    };
    writeFileSync(sourceFile, [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "historical-session",
        timestamp: "2026-08-23T00:00:00.000Z",
        cwd: data.project,
      }),
      JSON.stringify({
        type: "message",
        id: "historical-user",
        parentId: null,
        timestamp: "2026-08-23T00:00:01.000Z",
        message: { role: "user", content: "Choose SQLite.", timestamp: 1 },
      }),
      JSON.stringify({
        type: "custom",
        id: "historical-memory-entry",
        parentId: "historical-user",
        timestamp: "2026-08-23T00:00:02.000Z",
        customType: MEMORY_CUSTOM_ENTRY_TYPE,
        data: sourceMutation,
      }),
    ].join("\n") + "\n");

    const instance = runtimeFor(data, "cross");
    await instance.pi.handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "startup" },
      data.context,
    );

    expect(instance.runtime.listMemories(true)).toEqual([
      expect.objectContaining({
        id: "historical-memory",
        originSessionId: "historical-session",
        provenance: expect.objectContaining({
          mutationEntryId: "historical-memory-entry",
          sourceBranchEntryId: "historical-user",
        }),
      }),
    ]);
    expect(instance.runtime.diagnostics(data.context).memory.crossSession).toMatchObject({
      status: "ready",
      contributingSessions: 1,
    });

    const transformed = await instance.pi.handlers.get("context")?.[0]?.({
      type: "context",
      messages: [data.user],
    }, data.context) as { messages: Array<{ role: string; content: unknown }> };
    expect(JSON.stringify(transformed.messages)).toContain("Historical sessions selected SQLite");

    await instance.pi.commands.get("context")?.handler("memory sources", data.context);
    expect(data.notifications.at(-1)).toContain("historical-session");

    const tool = instance.pi.tools.find((candidate) => candidate.name === "context_persistence");
    if (!tool) throw new Error("Expected context_persistence tool");
    const sources = await tool.execute(
      "tool-memory-sources",
      { action: "memory_sources" },
      undefined,
      undefined,
      data.context,
    );
    const source = sources.details.items?.find((item: any) => item.kind === "project-memory-source");
    if (!source || source.kind !== "project-memory-source") throw new Error("Expected project source");
    const excluded = await tool.execute(
      "tool-memory-source-exclude",
      {
        action: "memory_source_exclude",
        id: source.sourceRef,
        targetRevision: source.targetRevision,
        reason: "obsolete",
      },
      undefined,
      undefined,
      data.context,
    );
    expect(excluded.details).toMatchObject({
      outcome: "committed",
      persistenceClass: "derived-local-policy",
      status: "excluded",
    });
    expect(instance.runtime.listMemories(true)).toHaveLength(0);
    expect(data.entries.filter((entry) => entry.type === "custom")).toHaveLength(0);

    const included = await tool.execute(
      "tool-memory-source-include",
      {
        action: "memory_source_include",
        id: source.sourceRef,
        targetRevision: excluded.details.targetRevision,
      },
      undefined,
      undefined,
      data.context,
    );
    expect(included.details).toMatchObject({
      outcome: "committed",
      persistenceClass: "derived-local-policy",
      status: "ready",
    });
    expect(instance.runtime.listMemories(true)).toHaveLength(1);
    expect(data.entries.filter((entry) => entry.type === "custom")).toHaveLength(0);

    const excludedBeforeRebuild = await tool.execute(
      "tool-memory-source-exclude-before-rebuild",
      {
        action: "memory_source_exclude",
        id: source.sourceRef,
        targetRevision: included.details.targetRevision,
      },
      undefined,
      undefined,
      data.context,
    );
    expect(excludedBeforeRebuild.details).toMatchObject({ outcome: "committed", status: "excluded" });
    const sourceJsonlBefore = await import("node:fs")
      .then(({ readFileSync }) => readFileSync(sourceFile, "utf8"));
    await instance.pi.handlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown", reason: "quit" },
      data.context,
    );
    rmSync(join(data.agentDir, "ds4-context", "context.db"), { force: true });
    rmSync(join(data.agentDir, "ds4-context", "context.db-wal"), { force: true });
    rmSync(join(data.agentDir, "ds4-context", "context.db-shm"), { force: true });

    const rebuilt = runtimeFor(data, "cross-rebuild");
    await rebuilt.pi.handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "resume" },
      data.context,
    );
    expect(rebuilt.runtime.listMemories(true)).toHaveLength(1);
    expect(rebuilt.runtime.projectMemorySources()).toEqual([
      expect.objectContaining({ sessionId: "historical-session", status: "ready" }),
    ]);
    expect(await import("node:fs").then(({ readFileSync }) => readFileSync(sourceFile, "utf8")))
      .toBe(sourceJsonlBefore);
    expect(data.entries.filter((entry) => entry.type === "custom")).toHaveLength(0);
    await rebuilt.pi.handlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown", reason: "quit" },
      data.context,
    );
  });

  it("records metadata-only ranking feedback and trains a local shadow model", async () => {
    const data = fixture();
    writeFileSync(join(data.agentDir, "ds4-context.json"), JSON.stringify({
      project: { enabled: false },
      ranking: {
        mode: "shadow",
        minimumTrainingSamples: 2,
        maxTrainingSamples: 20,
      },
    }));
    const instance = runtimeFor(data, "ranking");
    await instance.pi.handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "startup" },
      data.context,
    );
    await instance.pi.commands.get("context")?.handler(
      "memory add --scope project --key export-mode 'Package export mode is PerEndpoint.'",
      data.context,
    );
    await instance.pi.commands.get("context")?.handler(
      "memory add --scope project --key database 'Context database is SQLite.'",
      data.context,
    );
    const request = {
      role: "user" as const,
      content: "Check Package export mode and Context database SQLite decisions.",
      timestamp: 2,
    };
    await instance.pi.handlers.get("context")?.[0]?.({ type: "context", messages: [request] }, data.context);
    const memories = instance.runtime.listMemories(true);
    expect(memories).toHaveLength(2);

    await instance.pi.commands.get("context")?.handler(
      `ranking feedback useful memory:${memories[0]?.id} --classification internal`,
      data.context,
    );
    await instance.pi.commands.get("context")?.handler(
      `ranking feedback irrelevant memory:${memories[1]?.id} --classification local-only`,
      data.context,
    );
    const feedback = data.entries.filter((entry) =>
      entry.type === "custom" && entry.customType === RANKING_FEEDBACK_CUSTOM_ENTRY_TYPE
    );
    expect(feedback).toHaveLength(2);
    expect(JSON.stringify(feedback)).not.toContain("PerEndpoint");
    expect(JSON.stringify(feedback)).not.toContain("SQLite");

    await instance.pi.commands.get("context")?.handler("ranking train", data.context);
    const diagnostics = instance.runtime.diagnostics(data.context).ranking;
    expect(diagnostics).toMatchObject({
      mode: "shadow",
      modelLoaded: true,
      promoted: false,
      trainingSamples: 2,
    });
    expect(diagnostics.modelId).toMatch(/^ranking-[a-f0-9]{16}$/u);
    expect(data.notifications.at(-1)).toContain("DS4 Ranking Model Trained");
    expect(await import("node:fs").then(({ existsSync }) => existsSync(
      join(data.agentDir, "ds4-context", "ranking-model.json"),
    ))).toBe(true);

    await instance.pi.handlers.get("context")?.[0]?.({ type: "context", messages: [request] }, data.context);
    expect(instance.runtime.diagnostics(data.context).ranking).toMatchObject({
      status: "shadow",
      modelLoaded: true,
      candidateCount: 2,
    });
    const rankingManifest = instance.runtime.latestManifest()?.ranking;
    expect(rankingManifest).toMatchObject({ status: "shadow", candidateCount: 2 });
    expect(JSON.stringify(rankingManifest)).not.toContain(memories[0]?.id);
    expect(JSON.stringify(rankingManifest)).not.toContain("sourceKind");
    expect(JSON.stringify(rankingManifest)).not.toContain("staticScore");
    await instance.pi.handlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown", reason: "quit" },
      data.context,
    );
  });

  it("keeps model-callable persistence unavailable without a canonical Pi session file", async () => {
    const data = fixture();
    let confirmations = 0;
    const ephemeralContext = {
      ...data.context,
      ui: {
        ...data.context.ui,
        confirm: async () => {
          confirmations += 1;
          return true;
        },
      },
      sessionManager: {
        ...data.context.sessionManager,
        getSessionId: () => "ephemeral-session",
        getSessionFile: () => undefined,
      },
    } as ExtensionContext;
    const instance = runtimeFor(data, "tool-ephemeral");
    await instance.pi.handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "startup" },
      ephemeralContext,
    );
    const tool = instance.pi.tools.find((candidate) => candidate.name === "context_persistence");
    if (!tool) throw new Error("Expected context_persistence tool");

    const read = await tool.execute(
      "tool-ephemeral-read",
      { action: "pins_list" },
      undefined,
      undefined,
      ephemeralContext,
    );
    expect(read.details).toMatchObject({
      outcome: "unavailable",
      errorCode: "runtime-unavailable",
      persistenceClass: "read-only",
    });

    const write = await tool.execute(
      "tool-ephemeral-write",
      { action: "pin_add", content: "Must have an append-only Pi JSONL destination." },
      undefined,
      undefined,
      ephemeralContext,
    );
    expect(write.details).toMatchObject({
      outcome: "unavailable",
      errorCode: "runtime-unavailable",
      persistenceClass: "canonical-jsonl",
    });
    expect(confirmations).toBe(0);
    expect(data.entries.filter((entry) => entry.type === "custom")).toHaveLength(0);
    await instance.pi.handlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown", reason: "quit" },
      ephemeralContext,
    );
  });

  it("routes confirmed tool Pin and Memory mutations through Pi append-only JSONL and runtime projection", async () => {
    const data = fixture();
    const instance = runtimeFor(data, "tool-runtime");
    await instance.pi.handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "startup" },
      data.context,
    );
    const tool = instance.pi.tools.find((candidate) => candidate.name === "context_persistence");
    if (!tool) throw new Error("Expected context_persistence tool");

    const added = await tool.execute(
      "tool-pin-add",
      { action: "pin_add", content: "Never mutate canonical history in place.", scope: "branch" },
      undefined,
      undefined,
      data.context,
    );
    expect(added.details).toMatchObject({
      outcome: "committed",
      persistenceClass: "canonical-jsonl",
      kind: "pin",
      scope: "branch",
      status: "active",
    });
    expect(instance.runtime.listPins(true)).toEqual([
      expect.objectContaining({
        id: added.details.id,
        content: "Never mutate canonical history in place.",
        sourceEntryId: "user-1",
      }),
    ]);
    expect(data.entries.filter((entry) => entry.type === "custom")).toHaveLength(1);

    const memoryAdded = await tool.execute(
      "tool-memory-add",
      { action: "memory_add", content: "SQLite is the durable project decision.", key: "database" },
      undefined,
      undefined,
      data.context,
    );
    expect(memoryAdded.details).toMatchObject({
      outcome: "committed",
      persistenceClass: "canonical-jsonl",
      kind: "memory",
      scope: "session",
      status: "active",
    });
    expect(instance.runtime.listMemories(true)).toEqual([
      expect.objectContaining({
        id: memoryAdded.details.id,
        claim: "SQLite is the durable project decision.",
        key: "database",
        sourceEntryIds: expect.arrayContaining(["user-1"]),
      }),
    ]);

    const memories = await tool.execute(
      "tool-memory-list",
      { action: "memory_list" },
      undefined,
      undefined,
      data.context,
    );
    const memoryTarget = memories.details.items?.[0];
    if (!memoryTarget || memoryTarget.kind !== "memory") throw new Error("Expected listed Memory");
    const memorySuperseded = await tool.execute(
      "tool-memory-supersede",
      {
        action: "memory_supersede",
        id: memoryTarget.id,
        targetRevision: memoryTarget.targetRevision,
        content: "PostgreSQL is the durable project decision.",
      },
      undefined,
      undefined,
      data.context,
    );
    expect(memorySuperseded.details).toMatchObject({ outcome: "committed", status: "active" });
    expect(instance.runtime.listMemories(true)).toEqual([
      expect.objectContaining({
        id: memorySuperseded.details.id,
        claim: "PostgreSQL is the durable project decision.",
        key: "database",
      }),
    ]);

    const activeMemories = await tool.execute(
      "tool-memory-list-active",
      { action: "memory_list" },
      undefined,
      undefined,
      data.context,
    );
    const activeMemory = activeMemories.details.items?.[0];
    if (!activeMemory || activeMemory.kind !== "memory") throw new Error("Expected active Memory");
    const invalidated = await tool.execute(
      "tool-memory-invalidate",
      {
        action: "memory_invalidate",
        id: activeMemory.id,
        targetRevision: activeMemory.targetRevision,
        reason: "Decision withdrawn",
      },
      undefined,
      undefined,
      data.context,
    );
    expect(invalidated.details).toMatchObject({ outcome: "committed", status: "invalid" });
    expect(instance.runtime.listMemories(true)).toHaveLength(0);

    const listed = await tool.execute(
      "tool-pin-list",
      { action: "pins_list" },
      undefined,
      undefined,
      data.context,
    );
    const target = listed.details.items?.[0];
    if (!target || target.kind !== "pin") throw new Error("Expected listed Pin");
    const removed = await tool.execute(
      "tool-pin-unpin",
      { action: "pin_unpin", id: target.id, targetRevision: target.targetRevision },
      undefined,
      undefined,
      data.context,
    );
    expect(removed.details).toMatchObject({ outcome: "committed", status: "deleted" });
    expect(instance.runtime.listPins(true)).toHaveLength(0);
    const customEntries = data.entries.filter((entry) => entry.type === "custom");
    expect(customEntries).toHaveLength(5);
    expect(customEntries.map((entry) => entry.type === "custom" ? entry.customType : "")).toEqual([
      PIN_CUSTOM_ENTRY_TYPE,
      MEMORY_CUSTOM_ENTRY_TYPE,
      MEMORY_CUSTOM_ENTRY_TYPE,
      MEMORY_CUSTOM_ENTRY_TYPE,
      PIN_CUSTOM_ENTRY_TYPE,
    ]);
    const routineEvents = instance.logs
      .map((line) => JSON.parse(line) as { event?: string })
      .filter((record) => record.event === "context_persistence.outcome"
        || record.event === "pin.created"
        || record.event === "pin.deleted"
        || record.event === "memory.created"
        || record.event === "memory.superseded"
        || record.event === "memory.status_changed");
    expect(routineEvents).toHaveLength(0);
    instance.runtime.contextPersistenceRecordOutcome({
      action: "memory_add",
      outcome: "committed_projection_pending",
      persistenceClass: "canonical-jsonl",
      itemId: "memory-safe",
      errorCode: "committed-projection-pending",
    });
    expect(instance.logs.map((line) => JSON.parse(line)).at(-1)).toMatchObject({
      level: "warn",
      event: "context_persistence.outcome",
      metadata: { outcome: "committed_projection_pending", itemId: "memory-safe" },
    });
    await instance.pi.handlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown", reason: "quit" },
      data.context,
    );
    rmSync(join(data.agentDir, "ds4-context", "context.db"), { force: true });
    rmSync(join(data.agentDir, "ds4-context", "context.db-wal"), { force: true });
    rmSync(join(data.agentDir, "ds4-context", "context.db-shm"), { force: true });

    const rebuilt = runtimeFor(data, "tool-rebuild");
    await rebuilt.pi.handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "resume" },
      data.context,
    );
    expect(rebuilt.runtime.listPins(false)).toEqual([
      expect.objectContaining({ id: added.details.id, status: "deleted" }),
    ]);
    expect(rebuilt.runtime.listMemories(false)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: memoryAdded.details.id, status: "superseded" }),
      expect.objectContaining({ id: memorySuperseded.details.id, status: "invalid" }),
    ]));
    await rebuilt.pi.handlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown", reason: "quit" },
      data.context,
    );
  });

  it("persists manual mutations in Pi JSONL, injects metadata-only provenance, and rebuilds", async () => {
    const data = fixture();
    const first = runtimeFor(data, "runtime");
    await first.pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, data.context);

    await first.pi.commands.get("context")?.handler(
      "pin --scope branch --classification internal --source user-1 'Never rewrite canonical Pi JSONL.'",
      data.context,
    );
    await first.pi.commands.get("context")?.handler(
      "memory add --scope project --classification sensitive --key export-mode --source user-1 'Package export mode defaults to PerEndpoint.'",
      data.context,
    );

    expect(first.runtime.listPins(true)).toEqual([
      expect.objectContaining({ classification: "internal" }),
    ]);
    expect(first.runtime.listMemories(true)).toEqual([
      expect.objectContaining({ classification: "sensitive" }),
    ]);
    expect(data.entries.filter((entry) => entry.type === "custom").map((entry: any) => entry.customType))
      .toEqual([PIN_CUSTOM_ENTRY_TYPE, MEMORY_CUSTOM_ENTRY_TYPE]);
    const sessionText = await import("node:fs").then(({ readFileSync }) => readFileSync(data.sessionFile, "utf8"));
    expect(sessionText).toContain("Never rewrite canonical Pi JSONL.");
    expect(sessionText).toContain("Package export mode defaults to PerEndpoint.");

    const transformed = await first.pi.handlers.get("context")?.[0]?.({
      type: "context",
      messages: [data.user],
    }, data.context) as { messages: Array<{ role: string; content: unknown }> };
    expect(transformed.messages).toHaveLength(3);
    expect(String(transformed.messages[0]?.content)).toContain("DS4 PINNED CONTEXT");
    expect(String(transformed.messages[1]?.content)).toContain("DS4 DURABLE MEMORY");
    expect(transformed.messages[2]).toEqual(data.user);
    expect(first.runtime.latestManifest()).toMatchObject({
      plannerVersion: "managed-learned-ranking-v1",
      policyVersion: "9",
      pins: [expect.objectContaining({ scope: "branch", classification: "internal" })],
      memories: [expect.objectContaining({ key: "export-mode", classification: "sensitive" })],
    });
    expect(JSON.stringify(first.runtime.latestManifest())).not.toContain("PerEndpoint");
    expect(first.runtime.latestManifest()?.included).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "pin", sourceId: first.runtime.listPins(true)[0]?.id }),
      expect.objectContaining({ kind: "memory", sourceId: first.runtime.listMemories(true)[0]?.id }),
    ]));

    const oldMemory = first.runtime.listMemories(true)[0];
    if (!oldMemory) throw new Error("Expected memory");
    await first.pi.commands.get("context")?.handler(
      "memory add --scope project --key export-mode 'Package export mode defaults to SingleFile.'",
      data.context,
    );
    expect(data.notifications.at(-1)).toContain("conflicts with active item");
    expect(first.runtime.listMemories(true)).toHaveLength(1);

    await first.pi.commands.get("context")?.handler(
      `memory supersede ${oldMemory.id} --source user-1 'Package export mode defaults to SingleFile.'`,
      data.context,
    );
    expect(first.runtime.listMemories(true)[0]?.claim).toContain("SingleFile");
    expect(first.runtime.listMemories(true)[0]?.classification).toBe("sensitive");
    expect(first.runtime.listMemories(false).find((item) => item.id === oldMemory.id)).toMatchObject({
      status: "superseded",
      supersededBy: first.runtime.listMemories(true)[0]?.id,
    });

    const compactionOne = {
      type: "compaction" as const,
      id: "compact-1",
      parentId: data.entries.at(-1)?.id ?? null,
      timestamp: "2026-08-24T00:01:00.000Z",
      summary: "first compaction",
      firstKeptEntryId: "user-1",
      tokensBefore: 10_000,
    };
    const compactionTwo = {
      ...compactionOne,
      id: "compact-2",
      parentId: "compact-1",
      timestamp: "2026-08-24T00:02:00.000Z",
      summary: "second compaction",
    };
    data.entries.push(compactionOne, compactionTwo);
    appendFileSync(data.sessionFile, `${JSON.stringify(compactionOne)}\n${JSON.stringify(compactionTwo)}\n`);
    const afterCompaction = await first.pi.handlers.get("context")?.[0]?.({
      type: "context",
      messages: [data.user],
    }, data.context) as { messages: Array<{ role: string; content: unknown }> };
    expect(JSON.stringify(afterCompaction.messages)).toContain("SingleFile");
    expect(JSON.stringify(afterCompaction.messages)).toContain("Never rewrite canonical Pi JSONL");

    await first.pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, data.context);
    rmSync(join(data.agentDir, "ds4-context", "context.db"), { force: true });
    rmSync(join(data.agentDir, "ds4-context", "context.db-wal"), { force: true });
    rmSync(join(data.agentDir, "ds4-context", "context.db-shm"), { force: true });

    const resumed = runtimeFor(data, "resume");
    await resumed.pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "resume" }, data.context);
    expect(resumed.runtime.listPins(true)).toHaveLength(1);
    expect(resumed.runtime.listMemories(true)[0]?.claim).toContain("SingleFile");
    expect(resumed.runtime.listMemories(false).find((item) => item.id === oldMemory.id)?.status).toBe("superseded");

    data.setBranch(data.entries.filter((entry) => entry.id !== "user-1"));
    const sibling = await resumed.pi.handlers.get("context")?.[0]?.({
      type: "context",
      messages: [data.user],
    }, data.context) as { messages: Array<{ role: string; content: unknown }> };
    expect(JSON.stringify(sibling.messages)).not.toContain("DS4 PINNED CONTEXT");
    expect(JSON.stringify(sibling.messages)).toContain("SingleFile");
    await resumed.pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, data.context);
  });
});
