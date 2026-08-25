import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Api,
  AssistantMessage,
  Model,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { continuationItemHashes } from "../../src/continuation/native-continuation.ts";
import { registerDs4ContextEngine } from "../../src/extension/index.ts";

class FakePi {
  readonly handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  readonly commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  readonly providers = new Map<string, ProviderConfig>();

  on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  registerCommand(
    name: string,
    command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
  ): void {
    this.commands.set(name, command);
  }

  registerProvider(name: string, config: ProviderConfig): void {
    this.providers.set(name, config);
  }

  registerTool(): void {}
  getActiveTools(): string[] { return []; }
  getAllTools(): unknown[] { return []; }
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const model: Model<Api> = {
  id: "gpt-test",
  name: "GPT Test",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
};

function assistantMessage(responseId: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{
      type: "text",
      text: "first answer",
      textSignature: JSON.stringify({ v: 1, id: "msg_1" }),
    }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-test",
    responseId,
    usage: {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  };
}

describe("DS4 native continuation integration", () => {
  it("registers an opt-in OpenAI Responses wrapper, records metadata only, and invalidates on branch change", async () => {
    const root = mkdtempSync(join(tmpdir(), "ds4-native-continuation-"));
    temporaryDirectories.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      retrieval: { exact: false, fts: false },
      project: { enabled: false },
      memory: { enabled: false },
      artifacts: { enabled: false },
      compaction: { enabled: false },
      privacy: {
        enabled: true,
        remoteDefaultAllowed: ["normal"],
      },
      nativeContinuation: {
        enabled: true,
        allowProviderStorage: true,
        profiles: ["openai/*"],
        maxStateAgeMs: 60_000,
        retryManagedReplay: true,
      },
    }));

    const privateMarker = "[ds4:local-only]PRIVATE-CONTINUATION-SOURCE[/ds4:local-only]";
    const firstUser = { role: "user" as const, content: `${privateMarker} first request`, timestamp: 1 };
    const entries: any[] = [{
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-08-25T00:00:01.000Z",
      message: firstUser,
    }];
    const sessionFile = join(cwd, "session.jsonl");
    const writeSession = () => writeFileSync(sessionFile, [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-08-25T00:00:00.000Z",
        cwd,
      }),
      ...entries.map((entry) => JSON.stringify(entry)),
    ].join("\n") + "\n");
    writeSession();

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
        getSessionId: () => "session-1",
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
      getSystemPrompt: () => "stable system",
      waitForIdle: async () => {},
    } as unknown as ExtensionContext;

    const pi = new FakePi();
    let manifestSequence = 0;
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir,
      configDirName: ".pi",
      homeDir: root,
      idGenerator: () => `manifest-${++manifestSequence}`,
      now: (() => {
        let clock = 1_000;
        return () => ++clock;
      })(),
      logSink: () => {},
    });

    await pi.handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "startup" },
      context,
    );
    expect(pi.providers.get("openai")).toMatchObject({ api: "openai-responses" });
    expect(typeof pi.providers.get("openai")?.streamSimple).toBe("function");

    const contextHandler = pi.handlers.get("context")?.[0];
    if (!contextHandler) throw new Error("Expected context handler");
    const firstContext = await contextHandler(
      { type: "context", messages: [firstUser] },
      context,
    ) as { messages?: unknown[] };
    expect(JSON.stringify(firstContext.messages)).not.toContain("PRIVATE-CONTINUATION-SOURCE");
    expect(runtime.latestManifest()?.nativeContinuation).toMatchObject({
      enabled: true,
      eligible: true,
      mode: "pending",
      providerStorage: "opt-in",
    });

    const rawInitialInput = [
      { role: "developer", content: "stable system" },
      { role: "user", content: [{ type: "input_text", text: `${privateMarker} first request` }] },
    ];
    const rawBasePayload = {
      model: "gpt-test",
      input: rawInitialInput,
      tools: [],
      stream: true,
      prompt_cache_key: "session-1",
      store: false,
    };
    const providerHandler = pi.handlers.get("before_provider_request")?.[0];
    if (!providerHandler) throw new Error("Expected provider payload handler");
    const basePayload = await providerHandler(
      { type: "before_provider_request", payload: rawBasePayload },
      context,
    ) as Record<string, unknown>;
    expect(JSON.stringify(basePayload)).not.toContain("PRIVATE-CONTINUATION-SOURCE");
    const sanitizedInitialInput = basePayload.input as unknown[];
    const first = runtime.prepareNativeContinuation(basePayload, model, "session-1", {
      forceManagedReplay: false,
      retryOfContinuation: false,
    });
    expect(first.payload).toMatchObject({ store: true, input: sanitizedInitialInput });
    if (!first.attempt) throw new Error("Expected first native continuation attempt");

    const responseId = "resp_must_not_appear_in_manifest";
    const assistantItem = {
      type: "message",
      role: "assistant",
      id: "msg_1",
      status: "completed",
      content: [{ type: "output_text", text: "first answer", annotations: [] }],
    };
    const firstAssistant = assistantMessage(responseId);
    runtime.completeNativeContinuation(
      first.attempt,
      firstAssistant,
      continuationItemHashes([assistantItem]),
    );
    expect(runtime.latestManifest()?.nativeContinuation?.mode).toBe("managed-replay");
    expect(JSON.stringify(runtime.latestManifest())).not.toContain(responseId);

    const nextUser = { role: "user" as const, content: "second request", timestamp: 3 };
    entries.push({
      type: "message",
      id: "entry-2",
      parentId: "entry-1",
      timestamp: "2026-08-25T00:00:02.000Z",
      message: firstAssistant,
    }, {
      type: "message",
      id: "entry-3",
      parentId: "entry-2",
      timestamp: "2026-08-25T00:00:03.000Z",
      message: nextUser,
    });
    writeSession();
    await contextHandler({
      type: "context",
      messages: [firstUser, firstAssistant, nextUser],
    }, context);

    const checkedSecondPayload = await providerHandler({
      type: "before_provider_request",
      payload: {
        ...rawBasePayload,
        input: [...rawInitialInput, assistantItem, { role: "user", content: "second request" }],
      },
    }, context) as Record<string, unknown>;
    expect(JSON.stringify(checkedSecondPayload)).not.toContain("PRIVATE-CONTINUATION-SOURCE");
    const second = runtime.prepareNativeContinuation(checkedSecondPayload, model, "session-1", {
      forceManagedReplay: false,
      retryOfContinuation: false,
    });
    expect(second.payload).toMatchObject({
      store: true,
      previous_response_id: responseId,
      input: [{ role: "user", content: "second request" }],
    });
    expect(runtime.latestManifest()?.nativeContinuation).toMatchObject({
      mode: "native-continuation",
      attempted: true,
      stateReused: true,
      fullInputItems: 4,
      sentInputItems: 1,
      omittedInputItems: 3,
    });
    expect(JSON.stringify(runtime.latestManifest())).not.toContain(responseId);
    expect(JSON.stringify(runtime.latestManifest())).not.toContain("PRIVATE-CONTINUATION-SOURCE");

    await pi.commands.get("context")?.handler(
      "continuation",
      context as unknown as ExtensionCommandContext,
    );
    expect(notifications.at(-1)).toContain("DS4 Optional Native Continuation");
    expect(notifications.at(-1)).not.toContain(responseId);

    await pi.handlers.get("session_tree")?.[0]?.({
      type: "session_tree",
      oldLeafId: "entry-3",
      newLeafId: "entry-1",
    }, context);
    expect(runtime.diagnostics(context).nativeContinuation).toMatchObject({
      stateAvailable: false,
      lastInvalidationReason: "session-branch-changed",
    });

    expect(readFileSync(sessionFile, "utf8")).toContain("PRIVATE-CONTINUATION-SOURCE");
    const database = new DatabaseSync(join(agentDir, "ds4-context", "context.db"), { readOnly: true });
    const stored = database.prepare(`
      SELECT group_concat(manifest_json, '') AS manifests
      FROM context_manifests
      WHERE session_id = 'session-1'
    `).get() as unknown as { manifests: string };
    expect(stored.manifests).not.toContain(responseId);
    expect(stored.manifests).not.toContain("PRIVATE-CONTINUATION-SOURCE");
    database.close();

    await pi.handlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown", reason: "quit" },
      context,
    );
  });
});
