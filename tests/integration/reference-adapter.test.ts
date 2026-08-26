import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertRuntimeAdapterConformance,
  createRuntimeAdapterConformanceFixture,
  runRuntimeAdapterConformance,
  type RuntimeAdapterConformanceFactory,
} from "ds4-context-core/adapter/conformance";
import type {
  LocalKvRuntimePort,
  LocalKvRuntimeRequest,
} from "ds4-context-core/adapter/local-kv";
import {
  JsonlReferenceRuntimeAdapter,
  appendReferenceHistoryMessage,
  createReferenceHistory,
} from "../../packages/reference-adapter/src/index.ts";
import { describe, expect, it } from "vitest";

class ReferenceKvPort implements LocalKvRuntimePort {
  readonly handles = new Map<string, string>();
  reuseCalls = 0;
  fullReplayCalls = 0;
  shutdownCalls = 0;
  failReplay = false;

  async tryReuse(input: LocalKvRuntimeRequest) {
    this.reuseCalls += 1;
    if (!this.handles.has(input.eligibility.fingerprint)) return { status: "miss" as const };
    return {
      status: "hit" as const,
      output: { transport: "kv-hit" },
      savedPrefillTokens: input.prefixTokenCount,
      prefillLatencyMs: 0.5,
    };
  }

  async fullReplay(input: LocalKvRuntimeRequest) {
    this.fullReplayCalls += 1;
    if (this.failReplay) throw new Error("KV runtime unavailable");
    this.handles.set(input.eligibility.fingerprint, `native-handle-${this.fullReplayCalls}`);
    return {
      output: { transport: "full-replay" },
      prefillTokens: input.contextTokenCount,
      prefillLatencyMs: 12,
    };
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    this.handles.clear();
  }
}

function referenceFactory(): RuntimeAdapterConformanceFactory {
  return {
    name: "jsonl-reference-adapter",
    async create(fixture, transport) {
      const root = mkdtempSync(join(tmpdir(), "ds4-reference-adapter-"));
      const projectRoot = join(root, "project");
      const historyFile = join(root, "state", "session.jsonl");
      mkdirSync(projectRoot, { recursive: true });
      createReferenceHistory({
        historyFile,
        runtimeId: fixture.runtimeId,
        sessionId: fixture.sessionId,
        projectRoot,
        messages: fixture.messages,
      });
      return {
        adapter: new JsonlReferenceRuntimeAdapter({
          historyFile,
          runtimeId: fixture.runtimeId,
          projectRoot,
          model: fixture.model,
          transport,
        }),
        expectedProjectRoot: realpathSync.native(projectRoot),
        cleanup: () => rmSync(root, { recursive: true, force: true }),
      };
    },
  };
}

describe("JSONL reference runtime adapter", () => {
  it("passes the reusable runtime adapter conformance kit", async () => {
    const report = await runRuntimeAdapterConformance(referenceFactory());

    expect(report.passed).toBe(true);
    expect(report.cases).toHaveLength(7);
    expect(report.cases.every((item) => item.passed)).toBe(true);
    expect(JSON.stringify(report)).not.toContain("DS4_CONFORMANCE_PRIVATE_VALUE");
    expect(JSON.stringify(report)).not.toContain("sk-conformance-credential");
    expect(() => assertRuntimeAdapterConformance(report)).not.toThrow();
  });

  it("rejects truncated canonical history without rewriting it", async () => {
    const root = mkdtempSync(join(tmpdir(), "ds4-reference-corrupt-"));
    try {
      const projectRoot = join(root, "project");
      const historyFile = join(root, "session.jsonl");
      mkdirSync(projectRoot, { recursive: true });
      const fixture = createRuntimeAdapterConformanceFixture();
      createReferenceHistory({
        historyFile,
        runtimeId: fixture.runtimeId,
        sessionId: fixture.sessionId,
        projectRoot,
        messages: fixture.messages,
      });
      const raw = readFileSync(historyFile, "utf8");
      writeFileSync(historyFile, raw.slice(0, -1), "utf8");
      const adapter = new JsonlReferenceRuntimeAdapter({
        historyFile,
        runtimeId: fixture.runtimeId,
        projectRoot,
        model: fixture.model,
        transport: async () => ({ content: "unused" }),
      });

      await expect(adapter.snapshotHistory()).rejects.toThrow("canonical history is unavailable");
      expect(adapter.diagnostics()).toContainEqual(expect.objectContaining({
        code: "canonical-history-read-failed",
      }));
      expect(readFileSync(historyFile, "utf8")).toBe(raw.slice(0, -1));
      await adapter.shutdown();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses only privacy-filtered local prefixes without persisting runtime handles", async () => {
    const root = mkdtempSync(join(tmpdir(), "ds4-reference-kv-"));
    try {
      const projectRoot = join(root, "project");
      const historyFile = join(root, "session.jsonl");
      mkdirSync(projectRoot, { recursive: true });
      const fixture = createRuntimeAdapterConformanceFixture();
      createReferenceHistory({
        historyFile,
        runtimeId: fixture.runtimeId,
        sessionId: fixture.sessionId,
        projectRoot,
        messages: fixture.messages,
      });
      const canonicalBefore = readFileSync(historyFile, "utf8");
      const port = new ReferenceKvPort();
      let nativeTransportCalls = 0;
      const preparedPrefixes: string[] = [];
      const adapter = new JsonlReferenceRuntimeAdapter({
        historyFile,
        runtimeId: fixture.runtimeId,
        projectRoot,
        model: fixture.model,
        transport: async () => {
          nativeTransportCalls += 1;
          return { transport: "native" };
        },
        localKv: {
          enabled: true,
          port,
          runtimeRevision: "reference-runtime-build-1",
          modelRevision: "model-checksum-1",
          prepare(payload) {
            const value = payload as { prefix: string };
            preparedPrefixes.push(value.prefix);
            return {
              promptPrefix: value.prefix,
              systemOptions: { seed: 1 },
              toolOptions: [{ name: "read", schema: "v1" }],
              prefixTokenCount: 80,
              contextTokenCount: 100,
            };
          },
        },
      });
      const payload = {
        prefix: "[ds4:local-only]PRIVATE_LOCAL_PREFIX[/ds4:local-only]",
        messages: [{ role: "user", content: "continue" }],
      };

      expect(adapter.negotiateCapabilities([{ id: "local-kv-reuse" }]).enabled)
        .toEqual(["local-kv-reuse"]);
      const cold = await adapter.complete({ provider: "ollama", model: fixture.model.id, payload });
      const warm = await adapter.complete({ provider: "ollama", model: fixture.model.id, payload });

      expect(cold).toMatchObject({
        status: "completed",
        localKv: { mode: "full-replay", replayPrefillTokens: 100 },
      });
      expect(warm).toMatchObject({
        status: "completed",
        localKv: { mode: "hit", savedPrefillTokens: 80 },
      });
      expect(preparedPrefixes).toEqual(["PRIVATE_LOCAL_PREFIX", "PRIVATE_LOCAL_PREFIX"]);
      expect(nativeTransportCalls).toBe(0);
      expect(port.handles.size).toBe(1);
      expect(readFileSync(historyFile, "utf8")).toBe(canonicalBefore);
      const serializedDiagnostics = JSON.stringify(adapter.localKvDiagnostics());
      expect(serializedDiagnostics).not.toContain("PRIVATE_LOCAL_PREFIX");
      expect(serializedDiagnostics).not.toContain("native-handle");
      expect(adapter.localKvDiagnostics()).toMatchObject({
        hits: 1,
        misses: 1,
        fullReplays: 1,
        savedPrefillTokens: 80,
        contextTokens: 200,
      });

      await adapter.shutdown();
      await adapter.shutdown();
      expect(port.shutdownCalls).toBe(1);
      expect(port.handles.size).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces remote privacy before bypassing local KV and falls back after KV transport failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "ds4-reference-kv-privacy-"));
    try {
      const projectRoot = join(root, "project");
      const historyFile = join(root, "session.jsonl");
      mkdirSync(projectRoot, { recursive: true });
      const fixture = createRuntimeAdapterConformanceFixture();
      createReferenceHistory({
        historyFile,
        runtimeId: fixture.runtimeId,
        sessionId: fixture.sessionId,
        projectRoot,
        messages: fixture.messages,
      });
      const port = new ReferenceKvPort();
      const transported: unknown[] = [];
      let prepareCalls = 0;
      const adapter = new JsonlReferenceRuntimeAdapter({
        historyFile,
        runtimeId: fixture.runtimeId,
        projectRoot,
        model: fixture.model,
        transport: async (request) => {
          transported.push(request.payload);
          return { transport: "native-full-replay" };
        },
        localKv: {
          enabled: true,
          port,
          runtimeRevision: "reference-runtime-build-1",
          modelRevision: "model-checksum-1",
          prepare(payload) {
            prepareCalls += 1;
            const value = payload as { prefix: string };
            return {
              promptPrefix: value.prefix,
              systemOptions: {},
              toolOptions: [],
              prefixTokenCount: 20,
              contextTokenCount: 40,
            };
          },
        },
      });

      const remote = await adapter.complete({
        provider: "openai",
        model: fixture.model.id,
        payload: {
          prefix: "[ds4:local-only]DO_NOT_CACHE_OR_SEND[/ds4:local-only]",
          messages: [{ role: "user", content: "sk-secret123456" }],
        },
      });
      expect(remote).toMatchObject({ status: "completed", privacy: { destination: "remote", changed: true } });
      expect(prepareCalls).toBe(0);
      expect(port.reuseCalls).toBe(0);
      expect(JSON.stringify(transported[0])).not.toContain("DO_NOT_CACHE_OR_SEND");
      expect(JSON.stringify(transported[0])).not.toContain("secret123456");

      port.failReplay = true;
      const localFallback = await adapter.complete({
        provider: "ollama",
        model: fixture.model.id,
        payload: { prefix: "eligible-local-prefix", messages: [] },
      });
      expect(localFallback).toMatchObject({ status: "completed", output: { transport: "native-full-replay" } });
      expect(adapter.localKvDiagnostics()).toMatchObject({
        misses: 1,
        fullReplays: 1,
        transportFailures: 1,
      });
      expect(adapter.diagnostics()).toContainEqual(expect.objectContaining({
        code: "local-kv-replay-failed",
        capability: "local-kv-reuse",
      }));
      await adapter.shutdown();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("observes canonical appends and reproduces them on rebuild", async () => {
    const root = mkdtempSync(join(tmpdir(), "ds4-reference-append-"));
    try {
      const projectRoot = join(root, "project");
      const historyFile = join(root, "session.jsonl");
      mkdirSync(projectRoot, { recursive: true });
      const fixture = createRuntimeAdapterConformanceFixture();
      createReferenceHistory({
        historyFile,
        runtimeId: fixture.runtimeId,
        sessionId: fixture.sessionId,
        projectRoot,
        messages: fixture.messages,
      });
      const adapter = new JsonlReferenceRuntimeAdapter({
        historyFile,
        runtimeId: fixture.runtimeId,
        projectRoot,
        model: fixture.model,
        transport: async () => ({ content: "unused" }),
      });
      const initial = await adapter.snapshotHistory();
      appendReferenceHistoryMessage(historyFile, {
        id: `${fixture.sessionId}:entry-appended`,
        sourceEntryId: "entry-appended",
        role: "user",
        blocks: [{ type: "text", text: "Canonical append" }],
        provenance: {
          source: "runtime-session",
          runtimeId: fixture.runtimeId,
          sessionId: fixture.sessionId,
          entryId: "entry-appended",
        },
        flags: {},
      });

      const appended = await adapter.snapshotHistory();
      const rebuilt = await adapter.rebuildDerivedState();
      expect(appended.revision).not.toBe(initial.revision);
      expect(appended.messages.at(-1)?.sourceEntryId).toBe("entry-appended");
      expect(rebuilt).toEqual(appended);
      expect(() => appendReferenceHistoryMessage(historyFile, appended.messages.at(-1)!))
        .toThrow("history-message-id-duplicate");
      await adapter.shutdown();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
