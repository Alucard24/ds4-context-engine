import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSessionContext,
  type ContextEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { registerDs4ContextEngine } from "../../src/extension/index.ts";

type Message = Extract<SessionEntry, { type: "message" }>["message"];
type AssistantMessage = Extract<Message, { role: "assistant" }>;

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

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function model(id: string, window: number) {
  return {
    id, name: id, api: "openai-responses" as const, provider: "faux", baseUrl: "http://localhost",
    reasoning: false, input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: window, maxTokens: 4_096,
  };
}

function assistant(content: AssistantMessage["content"], stopReason: "stop" | "toolUse" = "stop"): AssistantMessage {
  return {
    role: "assistant" as const, content, api: "openai-responses", provider: "faux", model: "model-bpe",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: 1,
  };
}

function fixture(window: number, autoTune: boolean) {
  const root = mkdtempSync(join(tmpdir(), "ds4-real-context-"));
  directories.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
    project: { enabled: false }, memory: { enabled: false }, artifacts: { enabled: false },
    compaction: { enabled: false },
    modelAwareness: { autoTune, overrides: { "faux/model-bpe": { tokenEstimator: "o200k-base-v1" } } },
  }));
  const sessionFile = join(cwd, "session.jsonl");
  const entries: SessionEntry[] = [];
  function add(message: Message): string {
    const id = `entry-${entries.length}`;
    entries.push({
      type: "message", id, parentId: entries.at(-1)?.id ?? null,
      timestamp: new Date(1_780_000_000_000 + entries.length * 1000).toISOString(), message,
    });
    writeFileSync(sessionFile, [
      JSON.stringify({ type: "session", version: 3, id: "real-context-fixture", timestamp: "2026-08-24T00:00:00.000Z", cwd }),
      ...entries.map((entry) => JSON.stringify(entry)),
    ].join("\n") + "\n");
    return id;
  }
  const primaryModel = model("model-bpe", window);
  const context = {
    cwd, mode: "tui", hasUI: true,
    ui: { notify: () => {}, setStatus: () => {} },
    sessionManager: {
      getSessionId: () => "real-context-fixture", getSessionFile: () => sessionFile,
      getLeafId: () => entries.at(-1)?.id,
      getEntries: () => entries, getBranch: () => entries, buildContextEntries: () => entries,
    },
    model: primaryModel, scopedModels: [], modelRegistry: {},
    isProjectTrusted: () => true, isIdle: () => true, hasPendingMessages: () => false,
    getContextUsage: () => undefined, getSystemPrompt: () => "stable system", waitForIdle: async () => {},
  } as unknown as ExtensionContext & { model: typeof primaryModel };
  const pi = new FakePi();
  const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
    agentDir, homeDir: root, configDirName: ".pi", logSink: () => {},
  });
  const event = (): ContextEvent => ({ type: "context", messages: buildSessionContext(entries).messages });
  const transform = async () => {
    const handler = pi.handlers.get("context")?.[0];
    if (!handler) throw new Error("Missing context handler");
    return await handler(event(), context) as { messages?: ContextEvent["messages"] } | undefined;
  };
  return { add, entries, event, context, pi, runtime, transform };
}

function filler(turn: number): string {
  return Array.from({ length: 170 }, (_, i) => `check-${turn}-${i.toString(36).padStart(3, "0")}-ok`).join(" ");
}

describe("DS4/Pi model awareness on canonical multi-turn context (no provider transport)", () => {
  it("reconstructs a Pi compaction boundary and keeps its summary under the BPE-managed budget", async () => {
    const data = fixture(32_000, false);
    const oldDecision = "RAW_OLD_DECISION cobalt-713 was set to 42 days.";
    data.add({ role: "user", content: oldDecision, timestamp: 1 });
    data.add(assistant([{ type: "text", text: "Recorded." }]));
    for (let turn = 0; turn < 12; turn++) {
      data.add({ role: "user", content: `Earlier turn ${turn}: ${filler(turn)}`, timestamp: turn + 2 });
      data.add(assistant([{ type: "text", text: `Response ${turn}.` }]));
    }
    const firstKeptEntryId = data.add({ role: "user", content: "Keep this recent turn.", timestamp: 40 });
    data.entries.push({ type: "compaction", id: "compaction-entry", parentId: firstKeptEntryId,
      timestamp: "2026-08-24T00:01:00.000Z", firstKeptEntryId,
      summary: "COMPACTED_FACT cobalt-713 expiry is 42 days.", tokensBefore: 30_000, fromHook: false });
    data.add({ role: "user", content: "What is the expiry recorded in the summary?", timestamp: 41 });
    const canonical = data.event().messages;
    expect(canonical.some((message) => message.role === "compactionSummary"
      && message.summary.includes("COMPACTED_FACT"))).toBe(true);
    expect(JSON.stringify(canonical)).not.toContain("RAW_OLD_DECISION");
    await data.pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, data.context);
    const selected = (await data.transform())?.messages ?? [];
    expect(JSON.stringify(selected)).toContain("COMPACTED_FACT");
    expect(JSON.stringify(selected)).not.toContain("RAW_OLD_DECISION");
    expect(data.runtime.latestManifest()?.planning?.mode).toBe("managed");
    expect(data.runtime.latestManifest()?.modelAwareness?.calibration.estimator).toBe("o200k-base-v1");
    expect(data.runtime.latestManifest()?.estimatedInputTokens).toBeLessThanOrEqual(data.runtime.latestManifest()?.hardInputLimit ?? 0);
    await data.pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, data.context);
  });

  it("plans a long JSONL branch, retrieves an old decision, and keeps a recent tool call/result together", async () => {
    const data = fixture(32_000, true);
    const decisionId = data.add({ role: "user", content: "DECISION cobalt-713: expiry is 42 days, never log credentials.", timestamp: 1 });
    data.add(assistant([{ type: "text", text: "Decision acknowledged." }]));
    for (let turn = 0; turn < 30; turn++) {
      data.add({ role: "user", content: `routine turn ${turn}: ${filler(turn)}`, timestamp: turn + 2 });
      data.add(assistant([{ type: "text", text: `Routine response ${turn}.` }]));
    }
    data.add({ role: "user", content: "Run the latest build.", timestamp: 100 });
    data.add(assistant([{ type: "toolCall", id: "build-call-1", name: "bash", arguments: { command: "build" } }], "toolUse"));
    data.add({ role: "toolResult", toolCallId: "build-call-1", toolName: "bash",
      content: [{ type: "text", text: `BUILD_OK checksum=v3 ${filler(200)}` }], isError: false, timestamp: 101 });
    data.add(assistant([{ type: "text", text: "The build passed." }]));
    data.add({ role: "user", content: "Why is cobalt-713 expiry 42 days? What did the latest build report?", timestamp: 102 });
    await data.pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, data.context);
    const originalCount = data.event().messages.length;
    const result = await data.transform();
    const selected = result?.messages ?? [];
    const text = JSON.stringify(selected);
    expect(originalCount).toBeGreaterThan(60);
    expect(selected.length).toBeLessThan(originalCount);
    expect(text).toContain("cobalt-713");
    expect(text).toContain("BUILD_OK");
    expect(selected.some((message) => message.role === "assistant"
      && message.content.some((part) => part.type === "toolCall" && part.id === "build-call-1"))).toBe(true);
    expect(selected.some((message) => message.role === "toolResult" && message.toolCallId === "build-call-1")).toBe(true);
    expect(data.runtime.retrievalDiagnostics().selected.map((item) => item.entryId)).toContain(decisionId);
    expect(data.runtime.latestManifest()?.planning).toMatchObject({ mode: "managed", originalMessageCount: originalCount });
    expect(data.runtime.latestManifest()?.modelAwareness?.calibration.estimator).toBe("o200k-base-v1");
    expect(data.runtime.latestManifest()?.modelAwareness?.autoTune?.status).toBe("insufficient-samples");
    expect(data.runtime.latestManifest()?.estimatedInputTokens).toBeLessThanOrEqual(data.runtime.latestManifest()?.hardInputLimit ?? 0);
    await data.pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, data.context);
  });

  it("calibrates one BPE profile across successive turns, expands only after eight usages, and isolates another estimator", async () => {
    const data = fixture(128_000, true);
    await data.pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, data.context);
    let initialTail = 0;
    for (let turn = 0; turn < 8; turn++) {
      data.add({ role: "user", content: `Turn ${turn}: explain ${filler(turn)}`, timestamp: turn + 1 });
      await data.transform();
      const manifest = data.runtime.latestManifest();
      expect(manifest?.modelAwareness?.calibration.estimator).toBe("o200k-base-v1");
      expect(manifest?.modelAwareness?.autoTune?.status).toBe("insufficient-samples");
      if (turn === 0) initialTail = manifest?.modelAwareness?.adaptive.recentTailTokens ?? 0;
      const estimate = manifest?.estimatedInputTokens ?? 0;
      expect(estimate).toBeGreaterThan(0);
      const actual = Math.round(estimate * 1.05);
      await data.pi.handlers.get("message_end")?.[0]?.({ type: "message_end", message: {
        role: "assistant", stopReason: "stop", usage: { input: actual, output: 4, cacheRead: 0, cacheWrite: 0 },
      } }, data.context);
      expect(data.runtime.latestManifest()?.actualInputTokens).toBe(actual);
      data.add(assistant([{ type: "text", text: `Answer ${turn}.` }]));
    }
    data.add({ role: "user", content: "Turn 8: summarize the decisions.", timestamp: 9 });
    await data.transform();
    expect(data.runtime.latestManifest()?.modelAwareness).toMatchObject({
      calibration: { calibrated: true, acceptedSamples: 8, observedSamples: 8, estimator: "o200k-base-v1" },
      autoTune: { status: "expanded", acceptedSamples: 8, boostFactor: 1.125 },
    });
    expect(data.runtime.latestManifest()?.modelAwareness?.adaptive.recentTailTokens).toBeGreaterThan(initialTail);
    expect(data.runtime.latestManifest()?.estimatedInputTokens).toBeLessThanOrEqual(data.runtime.latestManifest()?.hardInputLimit ?? 0);

    const bpeModel = data.context.model;
    const charsModel = model("model-chars", 128_000);
    data.context.model = charsModel;
    await data.pi.handlers.get("model_select")?.[0]?.({
      type: "model_select", model: charsModel, previousModel: bpeModel, source: "set",
    }, data.context);
    await data.transform();
    expect(data.runtime.latestManifest()?.modelAwareness).toMatchObject({
      calibration: { estimator: "chars-v1", observedSamples: 0, appliedRatio: 1 },
      autoTune: { status: "insufficient-samples" },
    });
    data.context.model = bpeModel;
    await data.pi.handlers.get("model_select")?.[0]?.({
      type: "model_select", model: bpeModel, previousModel: charsModel, source: "set",
    }, data.context);
    await data.transform();
    expect(data.runtime.latestManifest()?.modelAwareness).toMatchObject({
      calibration: { estimator: "o200k-base-v1", observedSamples: 8 },
      autoTune: { status: "expanded" },
    });
    // A near-limit provider usage sample can be a ratio outlier; it still removes
    // headroom for the next turn instead of letting eight older low usages dominate.
    const nearLimit = Math.floor((data.runtime.latestManifest()?.hardInputLimit ?? 0) * 0.85);
    await data.pi.handlers.get("message_end")?.[0]?.({ type: "message_end", message: {
      role: "assistant", stopReason: "stop", usage: { input: nearLimit, output: 4, cacheRead: 0, cacheWrite: 0 },
    } }, data.context);
    data.add(assistant([{ type: "text", text: "Long response." }]));
    data.add({ role: "user", content: "Next turn: re-evaluate available headroom.", timestamp: 10 });
    await data.transform();
    expect(data.runtime.latestManifest()?.modelAwareness).toMatchObject({
      calibration: { estimator: "o200k-base-v1", acceptedSamples: 8, hardBoundSamples: 1 },
      autoTune: { status: "no-headroom" },
    });
    expect(data.runtime.latestManifest()?.modelAwareness?.adaptive.recentTailTokens).toBeLessThanOrEqual(initialTail);
    await data.pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, data.context);
  });
});
