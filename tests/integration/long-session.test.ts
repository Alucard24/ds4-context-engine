import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { registerDs4ContextEngine } from "../../src/extension/index.ts";

class FakePi {
  readonly handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();

  on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  registerCommand(): void {}
  registerTool(): void {}
  getActiveTools(): string[] { return []; }
  getAllTools(): unknown[] { return []; }
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function rowCount(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as unknown as { count: number };
  return row.count;
}

describe("long-session hardening", () => {
  it("bounds managed context and disposable growth without changing canonical JSONL", async () => {
    const root = mkdtempSync(join(tmpdir(), "ds4-long-session-"));
    temporaryDirectories.push(root);
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      context: { recentTailTokens: 8_000 },
      retrieval: { exact: false, fts: false, semantic: false },
      project: { enabled: false },
      memory: { enabled: false },
      artifacts: { enabled: false },
      compaction: { enabled: false },
      quality: { enabled: true, maxSamples: 8 },
      diagnostics: { storeContextManifest: false },
    }));

    const sessionId = "long-session";
    const messageCount = 1_201;
    const entries = Array.from({ length: messageCount }, (_, index) => {
      const id = `entry-${String(index).padStart(4, "0")}`;
      const role = index % 2 === 0 ? "user" as const : "assistant" as const;
      const current = index === messageCount - 1;
      return {
        type: "message" as const,
        id,
        parentId: index === 0 ? null : `entry-${String(index - 1).padStart(4, "0")}`,
        timestamp: new Date(1_700_000_000_000 + index).toISOString(),
        message: {
          role,
          content: current
            ? "CURRENT-LONG-SESSION-REQUEST must remain verbatim"
            : `${role} historical turn ${index} ${"bounded-context-payload ".repeat(9)}`,
          timestamp: 1_700_000_000_000 + index,
        },
      };
    });
    const sessionFile = join(project, "session.jsonl");
    writeFileSync(sessionFile, [
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-08-26T00:00:00.000Z",
        cwd: project,
      }),
      ...entries.map((entry) => JSON.stringify(entry)),
    ].join("\n") + "\n");
    const canonicalBefore = readFileSync(sessionFile);
    const messages = entries.map((entry) => entry.message) as ContextEvent["messages"];
    const model = {
      id: "long-32k",
      name: "Long 32k",
      api: "openai-responses" as const,
      provider: "faux",
      baseUrl: "http://localhost",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 4_096,
    };
    const context = {
      cwd: project,
      mode: "tui",
      hasUI: false,
      ui: { notify: () => {}, setStatus: () => {} },
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => sessionFile,
        getLeafId: () => entries.at(-1)?.id,
        getEntries: () => entries,
        getBranch: () => entries,
        buildContextEntries: () => entries,
      },
      model,
      scopedModels: [],
      modelRegistry: {},
      isProjectTrusted: () => true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      getContextUsage: () => undefined,
      getSystemPrompt: () => "long-session-system",
      waitForIdle: async () => {},
    } as unknown as ExtensionContext;
    const pi = new FakePi();
    let sequence = 0;
    let clock = 10_000;
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir,
      configDirName: ".pi",
      homeDir: root,
      now: () => ++clock,
      idGenerator: () => `long-manifest-${++sequence}`,
      logSink: () => {},
    });

    await pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, context);
    const transform = pi.handlers.get("context")?.[0];
    const settled = pi.handlers.get("agent_settled")?.[0];
    if (!transform || !settled) throw new Error("Expected context and settled handlers");

    for (let iteration = 0; iteration < 24; iteration++) {
      const result = await transform({ type: "context", messages }, context) as {
        messages?: ContextEvent["messages"];
      };
      const selected = result.messages ?? messages;
      const manifest = runtime.latestManifest();
      expect(manifest?.planning).toMatchObject({ mode: "managed", originalMessageCount: messageCount });
      expect(manifest?.planning?.fallbackReason).toBeUndefined();
      expect(manifest?.estimatedInputTokens).toBeLessThanOrEqual(manifest?.hardInputLimit ?? 0);
      expect(selected.length).toBeLessThan(messageCount);
      expect(selected.at(-1)).toEqual(messages.at(-1));
      expect(JSON.stringify(selected.at(-1))).toContain("CURRENT-LONG-SESSION-REQUEST");
      await settled({ type: "agent_settled" }, context);
    }

    expect(runtime.diagnostics(context)).toMatchObject({
      phase: "managed",
      observation: { mode: "managed", originalMessageCount: messageCount },
      quality: { enabled: true, storedSamples: 8 },
      ranking: { mode: "off" },
    });
    expect(readFileSync(sessionFile)).toEqual(canonicalBefore);
    await pi.handlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown", reason: "quit" },
      context,
    );

    const database = new DatabaseSync(join(agentDir, "ds4-context", "context.db"), { readOnly: true });
    expect(rowCount(database, "entries")).toBe(messageCount);
    expect(rowCount(database, "context_quality_samples")).toBe(8);
    expect(rowCount(database, "context_manifests")).toBe(0);
    expect(rowCount(database, "derived_embeddings")).toBe(0);
    expect(rowCount(database, "memory_mutations")).toBe(0);
    expect(rowCount(database, "pin_mutations")).toBe(0);
    database.close();
  });
});
