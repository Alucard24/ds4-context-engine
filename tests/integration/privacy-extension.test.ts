import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { EmbeddingPort } from "ds4-context-core/retrieval/embedding";
import { registerDs4ContextEngine } from "../../src/extension/index.ts";
import { LocalFeatureHashEmbedding } from "../../src/pi-adapter/local-embedding.ts";

const temporaryDirectories: string[] = [];

function userMessage(content: string, timestamp: number) {
  return { role: "user" as const, content, timestamp };
}

class RecordingRemoteEmbedding implements EmbeddingPort {
  readonly identity = {
    provider: "embedding-remote",
    model: "semantic-v1",
    dimensions: 256,
    destination: "remote" as const,
  };
  readonly texts: string[] = [];
  private readonly local = new LocalFeatureHashEmbedding(256);

  embed(texts: readonly string[]): readonly (readonly number[])[] {
    this.texts.push(...texts);
    return this.local.embed(texts);
  }
}

class FakePi {
  readonly handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  readonly commands = new Map<string, any>();
  readonly tools: any[] = [];

  on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown): void {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
  }

  registerCommand(name: string, definition: any): void {
    this.commands.set(name, definition);
  }

  registerTool(tool: any): void {
    this.tools.push(tool);
  }

  getAllTools(): any[] {
    return [{
      name: "private_tool",
      description: "[ds4:local-only]PRIVATE-TOOL-DESCRIPTION[/ds4:local-only]",
      parameters: { type: "object", properties: {} },
      sourceInfo: { source: "extension", path: "test" },
    }];
  }

  getActiveTools(): string[] {
    return ["private_tool"];
  }
}

function fixture(root: string) {
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const sessionFile = join(root, "session.jsonl");
  mkdirSync(join(project, ".pi"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(project, "PrivacyPolicy.ts"), [
    "[ds4:local-only]",
    "export const PrivacyProjectCode = 'PROJECT-LOCAL-SECRET';",
    "[/ds4:local-only]",
  ].join("\n"));
  writeFileSync(join(project, ".pi", "ds4-context.json"), JSON.stringify({
    privacy: {
      enabled: true,
      localProviders: [],
      remoteDefaultAllowed: ["normal", "internal"],
      remoteProviders: {
        "remote-test": ["normal", "internal"],
        "embedding-remote": ["normal", "internal"],
      },
      redactSecrets: true,
    },
    retrieval: {
      semantic: true,
      embedding: {
        mode: "remote",
        provider: "embedding-remote",
        model: "semantic-v1",
        remoteProfiles: ["embedding-remote/semantic-v1"]
      }
    },
    project: { enabled: true, maxFiles: 100, maxTotalBytes: 1_000_000 },
    artifacts: { enabled: false },
    compaction: { enabled: false },
  }));

  const pinMutation = {
    schemaVersion: 1,
    mutationId: "pin-mutation",
    operation: "add",
    item: {
      id: "pin-local",
      scope: "session",
      classification: "local-only",
      content: "DURABLE-LOCAL-PIN",
      createdAt: 3,
    },
    createdAt: 3,
  };
  const memoryMutation = {
    schemaVersion: 1,
    mutationId: "memory-mutation",
    operation: "add",
    item: {
      id: "memory-sensitive",
      scope: "session",
      key: "release-code",
      classification: "sensitive",
      claim: "release-code defaults to DURABLE-SENSITIVE-MEMORY",
      createdAt: 4,
      sourceEntryIds: ["entry-user"],
    },
    createdAt: 4,
  };
  const entries = [
    { type: "session", version: 3, id: "privacy-session", timestamp: "2026-08-24T00:00:00.000Z", cwd: project },
    { type: "message", id: "entry-user", parentId: null, timestamp: "2026-08-24T00:00:01.000Z", message: userMessage("[ds4:local-only]HistoricalCode HISTORICAL-LOCAL-SECRET[/ds4:local-only]", 1) },
    { type: "custom", id: "entry-pin", parentId: "entry-user", timestamp: "2026-08-24T00:00:02.000Z", customType: "ds4-context-pin-v1", data: pinMutation },
    { type: "custom", id: "entry-memory", parentId: "entry-pin", timestamp: "2026-08-24T00:00:03.000Z", customType: "ds4-context-memory-v1", data: memoryMutation },
    { type: "message", id: "entry-current", parentId: "entry-memory", timestamp: "2026-08-24T00:00:04.000Z", message: userMessage("Use release-code, HistoricalCode, and PrivacyProjectCode", 4) },
  ] as unknown as SessionEntry[];
  writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  let leafId = "entry-current";
  const context = {
    cwd: project,
    hasUI: false,
    ui: { notify() {}, setStatus() {} },
    model: {
      provider: "remote-test",
      id: "remote-model",
      contextWindow: 128_000,
      maxTokens: 16_384,
      reasoning: false,
      input: ["text"],
    },
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "privacy-session",
      getLeafId: () => leafId,
      getEntries: () => entries,
      getBranch: () => entries,
      buildContextEntries: () => entries.filter((entry) => entry.id === "entry-current"),
    },
    getSystemPrompt: () => [
      "normal-system",
      "[ds4:local-only]PRIVATE-SYSTEM-TEXT[/ds4:local-only]",
      "api_key=system-secret-value",
    ].join("\n"),
    getContextUsage: () => undefined,
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
  return { agentDir, context, entries, setLeaf: (value: string) => { leafId = value; } };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("privacy extension integration", () => {
  it("filters every context source and rechecks provider payload without persisting content", async () => {
    const root = mkdtempSync(join(tmpdir(), "ds4-privacy-extension-"));
    temporaryDirectories.push(root);
    const { agentDir, context } = fixture(root);
    const pi = new FakePi();
    const logs: string[] = [];
    const embeddingPort = new RecordingRemoteEmbedding();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir,
      configDirName: ".pi",
      homeDir: root,
      embeddingPort,
      now: () => 1_800_000_000_000,
      idGenerator: (() => {
        let value = 0;
        return () => `privacy-id-${++value}`;
      })(),
      logSink: (line) => logs.push(line),
    });

    await pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, context);
    const nativeSecret = "NATIVE-LOCAL-SECRET";
    const credential = "sk-nativecredential123";
    const contextResult = await pi.handlers.get("context")?.[0]?.({
      type: "context",
      messages: [userMessage(
        `normal request [ds4:local-only]${nativeSecret}[/ds4:local-only] ${credential}`,
        10,
      )],
    }, context) as { messages?: unknown[] };
    const rendered = JSON.stringify(contextResult.messages);

    expect(rendered).toContain("normal request");
    expect(rendered).not.toContain(nativeSecret);
    expect(rendered).not.toContain(credential);
    expect(rendered).not.toContain("DURABLE-LOCAL-PIN");
    expect(rendered).not.toContain("DURABLE-SENSITIVE-MEMORY");

    const rawPayload = {
      model: "remote-model",
      system: "[ds4:local-only]FINAL-SYSTEM-SECRET[/ds4:local-only]",
      messages: [{ role: "user", content: "[ds4:local-only]FINAL-PAYLOAD-SECRET[/ds4:local-only]" }],
    };
    const providerResult = await pi.handlers.get("before_provider_request")?.[0]?.({
      type: "before_provider_request",
      payload: rawPayload,
    }, context);
    const providerJson = JSON.stringify(providerResult);
    expect(providerJson).not.toContain("FINAL-SYSTEM-SECRET");
    expect(providerJson).not.toContain("FINAL-PAYLOAD-SECRET");
    expect(providerJson).toContain("remote-model");

    const diagnostics = runtime.diagnostics(context);
    expect(diagnostics.privacy.destination).toBe("remote");
    expect(diagnostics.privacy.enforcement).toBe("context-and-provider");
    expect(diagnostics.privacy.providerChecks).toBe(1);
    expect(diagnostics.privacy.excludedSources).toBe(4);
    expect(diagnostics.project.semantic).toMatchObject({
      enabled: true,
      provider: "embedding-remote",
      destination: "remote",
      skippedByPrivacy: 1,
    });
    expect(diagnostics.lastManifest?.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: "pin-local", classification: "local-only" }),
      expect.objectContaining({ sourceId: "memory-sensitive", classification: "sensitive" }),
      expect.objectContaining({ sourceId: "entry-user", kind: "retrieval", classification: "local-only" }),
      expect.objectContaining({ kind: "project", classification: "local-only" }),
    ]));
    expect(diagnostics.lastManifest?.privacy?.providerChecks).toBe(1);
    const manifestJson = JSON.stringify(diagnostics.lastManifest);
    for (const secret of [
      nativeSecret,
      credential,
      "DURABLE-LOCAL-PIN",
      "DURABLE-SENSITIVE-MEMORY",
      "PRIVATE-SYSTEM-TEXT",
      "system-secret-value",
      "PRIVATE-TOOL-DESCRIPTION",
      "HISTORICAL-LOCAL-SECRET",
      "PROJECT-LOCAL-SECRET",
      "FINAL-SYSTEM-SECRET",
      "FINAL-PAYLOAD-SECRET",
    ]) {
      expect(manifestJson).not.toContain(secret);
      expect(logs.join("\n")).not.toContain(secret);
      expect(embeddingPort.texts.join("\n")).not.toContain(secret);
    }
  });

  it("fails closed when context preparation itself throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "ds4-privacy-fail-closed-"));
    temporaryDirectories.push(root);
    const { agentDir, context } = fixture(root);
    const pi = new FakePi();
    pi.getAllTools = () => { throw new Error("synthetic tool registry failure"); };
    registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir,
      configDirName: ".pi",
      homeDir: root,
      logSink: () => {},
    });
    await pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, context);
    const result = await pi.handlers.get("context")?.[0]?.({
      type: "context",
      messages: [userMessage("FAIL-CLOSED-LOCAL-CONTENT", 10)],
    }, context) as { messages?: unknown[] };

    expect(JSON.stringify(result.messages)).not.toContain("FAIL-CLOSED-LOCAL-CONTENT");
    expect(JSON.stringify(result.messages)).toContain("privacy enforcement failed closed");
  });

  it("replaces an uninspectable provider payload instead of letting Pi send it unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "ds4-privacy-payload-failure-"));
    temporaryDirectories.push(root);
    const { agentDir, context } = fixture(root);
    const pi = new FakePi();
    const logs: string[] = [];
    registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir,
      configDirName: ".pi",
      homeDir: root,
      logSink: (line) => logs.push(line),
    });
    await pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, context);
    const payload = new Proxy({}, {
      ownKeys() { throw new Error("PROXY-PAYLOAD-LOCAL-SECRET"); },
    });
    const result = await pi.handlers.get("before_provider_request")?.[0]?.({
      type: "before_provider_request",
      payload,
    }, context);

    expect(result).toEqual({});
    expect(logs.join("\n")).not.toContain("PROXY-PAYLOAD-LOCAL-SECRET");
    expect(logs.join("\n")).toContain("privacy.provider_fail_closed");
  });

  it("retains local-only content for an explicitly local provider while stripping markers", async () => {
    const root = mkdtempSync(join(tmpdir(), "ds4-privacy-local-"));
    temporaryDirectories.push(root);
    const { agentDir, context } = fixture(root);
    (context.model as { provider: string }).provider = "ollama";
    writeFileSync(join(context.cwd, ".pi", "ds4-context.json"), JSON.stringify({
      privacy: { enabled: true, localProviders: ["ollama"] },
      project: { enabled: false },
      artifacts: { enabled: false },
      compaction: { enabled: false },
    }));
    const pi = new FakePi();
    const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
      agentDir,
      configDirName: ".pi",
      homeDir: root,
      logSink: () => {},
    });
    await pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, context);
    await pi.handlers.get("model_select")?.[0]?.({
      type: "model_select",
      model: context.model,
      source: "set",
    }, context);
    const result = await pi.handlers.get("context")?.[0]?.({
      type: "context",
      messages: [userMessage("[ds4:local-only]LOCAL-MODEL-CONTENT[/ds4:local-only]", 10)],
    }, context) as { messages?: unknown[] };

    expect(JSON.stringify(result.messages)).toContain("LOCAL-MODEL-CONTENT");
    expect(JSON.stringify(result.messages)).not.toContain("ds4:local-only");
    expect(runtime.diagnostics(context).privacy.destination).toBe("local");
  });
});
