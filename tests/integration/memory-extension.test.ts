import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { registerDs4ContextEngine } from "../../src/extension/index.ts";
import { MEMORY_CUSTOM_ENTRY_TYPE, PIN_CUSTOM_ENTRY_TYPE } from "../../src/memory/memory-types.ts";

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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ds4-memory-extension-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(project, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({ project: { enabled: false } }));
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
    ui: { notify: (message: string) => notifications.push(message), setStatus: () => {} },
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
  let id = 0;
  const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
    agentDir: data.agentDir,
    configDirName: ".pi",
    homeDir: data.root,
    idGenerator: () => `${idPrefix}-${++id}`,
    now: (() => { let value = 1_780_000_100_000; return () => value++; })(),
    logSink: () => {},
  });
  return { pi, runtime };
}

describe("DS4 memory and pins extension integration", () => {
  it("persists manual mutations in Pi JSONL, injects metadata-only provenance, and rebuilds", async () => {
    const data = fixture();
    const first = runtimeFor(data, "runtime");
    await first.pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, data.context);

    await first.pi.commands.get("context")?.handler(
      "pin --scope branch --source user-1 'Never rewrite canonical Pi JSONL.'",
      data.context,
    );
    await first.pi.commands.get("context")?.handler(
      "memory add --scope project --key export-mode --source user-1 'Package export mode defaults to PerEndpoint.'",
      data.context,
    );

    expect(first.runtime.listPins(true)).toHaveLength(1);
    expect(first.runtime.listMemories(true)).toHaveLength(1);
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
      plannerVersion: "managed-memory-v1",
      policyVersion: "5",
      pins: [expect.objectContaining({ scope: "branch" })],
      memories: [expect.objectContaining({ key: "export-mode" })],
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
