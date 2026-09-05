import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "ds4-context-core/config/config";
import { calculateContextBudget } from "ds4-context-core/core/budget-manager";
import { createModelProfile, type ModelDescriptor } from "ds4-context-core/core/model-profile";
import { estimateMessageTokens } from "ds4-context-core/core/token-estimator";
import { PrivacyPolicyEngine } from "ds4-context-core/privacy/privacy-policy";
import { silentLogger } from "ds4-context-core/shared/logging";
import { parseDs4CompactionDetails } from "ds4-context-core/compaction/compaction-record";
import { REQUIRED_SUMMARY_SECTIONS, computeUpdateSourceHash } from "ds4-context-core/compaction/summary-contract";
import { CompactionCoordinator } from "../../src/pi-adapter/compaction-coordinator.ts";
import { prepareCompactionSource } from "../../src/pi-adapter/compaction-adapter.ts";

const summary = () => REQUIRED_SUMMARY_SECTIONS.map((name) => `## ${name}\n- None`).join("\n\n");
const response = (text = summary(), stopReason = "stop") => ({
  role: "assistant", content: [{ type: "text", text }], stopReason,
  usage: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 200,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(texts = ["NEW-EXACT"], previousSummary?: string) {
  const config = createDefaultConfig();
  config.context.maxSummaryTokens = 1024;
  config.compaction.transport = { maxAttempts: 3, baseDelayMs: 0 };
  const model = { provider: "remote", id: "test", contextWindow: 8000, maxTokens: 1024,
    api: "openai-responses", input: ["text"] } as Model<Api>;
  const entries = texts.map((content, i) => ({
    type: "message", id: `source-${i}`, parentId: i ? `source-${i - 1}` : null,
    timestamp: new Date(i + 1).toISOString(), message: { role: "user", content, timestamp: i + 1 },
  })) as SessionEntry[];
  const complete = vi.fn(async (_model: Model<Api>, _request: any, _options: any) => response());
  const ctx = { model, hasUI: false,
    sessionManager: { getBranch: () => entries, getEntries: () => entries, getLeafId: () => "retained" },
    getContextUsage: () => undefined,
    modelRegistry: { complete, find: vi.fn(), hasConfiguredAuth: vi.fn(() => true) },
  } as unknown as ExtensionContext;
  const controller = new AbortController();
  const event = {
    type: "session_before_compact", reason: "manual", signal: controller.signal, willRetry: false,
    preparation: {
      firstKeptEntryId: "retained", tokensBefore: 20_000, isSplitTurn: false,
      messagesToSummarize: entries.flatMap((entry) => entry.type === "message" ? [entry.message] : []),
      turnPrefixMessages: [], previousSummary,
      fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
      settings: { enabled: true, reserveTokens: 1024, keepRecentTokens: 1000 },
    }, branchEntries: entries,
  } as SessionBeforeCompactEvent;
  let nextId = 0;
  const debug = vi.fn();
  const warn = vi.fn();
  const resolveBudget = vi.fn((selected: ModelDescriptor) => ({
    budget: calculateContextBudget(createModelProfile(selected), config.context), recentTailTokens: 1000,
  }));
  const privacy = new PrivacyPolicyEngine(config.privacy);
  const coordinator = new CompactionCoordinator({
    config, sessionId: "unit", persisted: false, logger: { ...silentLogger, debug, warn },
    now: () => 1234, idGenerator: () => `generated-${++nextId}`, syncSessionIndex: () => {},
    latestManifest: () => undefined, resolveModelBudget: resolveBudget,
    classifyContent: (text, provider) => privacy.sanitizeText(text, provider),
  });
  return { config, model, entries, ctx, event, controller, complete, coordinator, debug, warn, resolveBudget };
}
const oversizedTexts = () => ["one", "two", "three"].map((word) => `${word} ${word[0]!.repeat(14_000)}`);

function detail(result: Awaited<ReturnType<CompactionCoordinator["beforeCompact"]>>) {
  const parsed = parseDs4CompactionDetails(result?.compaction?.details);
  if (!parsed) throw new Error("Expected DS4 compaction details");
  return parsed;
}

describe("compaction direct update", () => {
  it("grounds exact values in both old and new evidence, preserves cut point and split prefix, and binds source hash", async () => {
    const data = setup(["NEW-EXACT", "PREFIX-EXACT"], summary().replace("## Objective\n- None", "## Objective\n- Keep `OLD-EXACT`."));
    data.event.preparation.turnPrefixMessages = data.event.preparation.messagesToSummarize.splice(1);
    data.event.preparation.isSplitTurn = true;
    data.event.preparation.fileOps.read.add("new-file.ts");
    data.event.customInstructions = "Preserve the current task.";
    data.complete.mockResolvedValue(response(summary().replace("## Objective\n- None", "## Objective\n- Keep `OLD-EXACT`, `NEW-EXACT` and `PREFIX-EXACT`.")));
    const result = await data.coordinator.beforeCompact(data.event, data.ctx);
    const metadata = detail(result).ds4ContextEngine;
    expect(data.complete).toHaveBeenCalledTimes(1);
    expect(result?.compaction).toMatchObject({ firstKeptEntryId: "retained", tokensBefore: 20_000 });
    expect(metadata).toMatchObject({ summaryKind: "task-state", validationStatus: "valid", graphLevel: 1,
      sourceEntryIds: ["source-0", "source-1"], childSummaryIds: ["generated-2"], segmentSummaryId: "generated-1" });
    const predecessor = metadata.embeddedNodes[0]!;
    expect(metadata.sourceHash).toBe(computeUpdateSourceHash(prepareCompactionSource(data.event).sourceHash, predecessor));
    expect(computeUpdateSourceHash("different-source", predecessor)).not.toBe(metadata.sourceHash);
    expect(computeUpdateSourceHash(prepareCompactionSource(data.event).sourceHash, { ...predecessor, content: "different" })).not.toBe(metadata.sourceHash);
    const prompt = data.complete.mock.calls[0]![1].messages[0].content[0].text;
    expect(prompt).toContain("prefix of a split turn");
    expect(prompt).toContain("Preserve the current task.");
    expect(prompt).toContain("new-file.ts");
    expect(prompt).toContain("previous summary, or known file lists");
    expect(prompt).not.toContain("generated-2");
    expect(result?.compaction?.summary).toContain("`new-file.ts`");
    expect(data.coordinator.diagnostics(data.ctx)).toMatchObject({
      path: "direct-update", segmentCount: 0, aggregateCalls: 0, summaryCalls: 1,
    });
  });

  it.each(["remote", "local"])("sanitizes all update evidence for the selected %s model and retains classifications", async (provider) => {
    const secret = "PRIVATE-OLD-SECRET";
    const data = setup(["new source [ds4:local-only]PRIVATE-NEW-SECRET[/ds4:local-only]"],
      `[ds4:local-only]${summary()} ${secret}[/ds4:local-only]`);
    data.config.privacy.enabled = true;
    data.config.privacy.localProviders = ["local"];
    data.config.compaction.model = { provider, id: "dedicated" };
    const dedicated = { ...data.model, provider, id: "dedicated" };
    vi.mocked(data.ctx.modelRegistry.find).mockReturnValue(dedicated);
    data.event.customInstructions = "[ds4:local-only]PRIVATE-FOCUS[/ds4:local-only]";
    data.event.preparation.fileOps.read.add("[ds4:local-only]PRIVATE-PATH[/ds4:local-only]");
    const result = await data.coordinator.beforeCompact(data.event, data.ctx);
    const payload = JSON.stringify(data.complete.mock.calls);
    for (const value of [secret, "PRIVATE-NEW-SECRET", "PRIVATE-FOCUS", "PRIVATE-PATH"]) {
      if (provider === "local") expect(payload).toContain(value);
      else expect(payload).not.toContain(value);
    }
    expect(data.resolveBudget).toHaveBeenCalledWith(dedicated);
    expect(data.complete.mock.calls[0]?.[0]).toBe(dedicated);
    expect(detail(result).ds4ContextEngine).toMatchObject({ provider, model: "dedicated" });
    if (provider === "local") expect(result?.compaction?.summary).toContain("[ds4:local-only]");
    expect(JSON.stringify(data.debug.mock.calls)).not.toContain("PRIVATE-");
  });

  it("uses the complete prompt for an exact fit and switches to hierarchy one token below it", async () => {
    const first = setup(["x".repeat(3000)], summary());
    await first.coordinator.beforeCompact(first.event, first.ctx);
    const request = first.complete.mock.calls[0]![1];
    const tokens = estimateMessageTokens(request.messages[0]);
    expect(first.coordinator.diagnostics(first.ctx).directPromptTokens).toBe(tokens);
    for (const limit of [tokens, tokens - 1]) {
      const data = setup(["x".repeat(3000)], summary());
      const base = data.resolveBudget(data.model);
      data.resolveBudget.mockReturnValue({ ...base, budget: { ...base.budget, hardInputLimit: limit } });
      await data.coordinator.beforeCompact(data.event, data.ctx);
      expect(data.coordinator.diagnostics(data.ctx).path).toBe(limit === tokens ? "direct-update" : "hierarchical");
      expect(data.complete).toHaveBeenCalledTimes(limit === tokens ? 1 : 2);
      for (const call of data.complete.mock.calls) expect(estimateMessageTokens(call[1].messages[0])).toBeLessThanOrEqual(limit);
    }
  });

  it("reduces fan-out using summary headroom and preserves the legacy fill target option", async () => {
    for (const inputBudget of ["summary", "context"] as const) {
      const data = setup(["x".repeat(9600), "y".repeat(9600)]);
      data.config.compaction.inputBudget = inputBudget;
      data.config.context.targetFillRatio = 0.5;
      await data.coordinator.beforeCompact(data.event, data.ctx);
      expect(data.coordinator.diagnostics(data.ctx).segmentCount).toBe(inputBudget === "summary" ? 1 : 2);
      expect(data.complete).toHaveBeenCalledTimes(inputBudget === "summary" ? 1 : 3);
    }
  });

  it("does not install a direct update after output/validation failure and keeps bounded repair", async () => {
    for (const failure of ["invalid", "length", "repair"] as const) {
      const data = setup(["new"], summary());
      data.complete.mockResolvedValue(response(failure === "invalid" ? "bad structure" : failure === "repair"
        ? summary().replace("## Objective\n- None", "## Objective\n- Preserve the task.\n- Keep the context.\n- Continue the work.\n- Retain the request.\n- Keep `invented-value`.") : summary(),
      failure === "length" ? "length" : "stop"));
      const result = await data.coordinator.beforeCompact(data.event, data.ctx);
      expect(data.complete).toHaveBeenCalledTimes(1);
      if (failure === "repair") {
        expect(detail(result).ds4ContextEngine.validationIssueCodes).toContain("unsupported-exact-bullets-pruned");
        expect(result?.compaction?.summary).not.toContain("invented-value");
      } else {
        expect(result).toBeUndefined();
        expect(data.coordinator.summaryGraph(data.ctx).totalNodes).toBe(0);
        expect(data.coordinator.diagnostics(data.ctx).lastError).toContain(failure === "length" ? "output limit" : "update");
      }
    }
  });

  it("retries direct transport failures only, preserves usage and never logs provider details", async () => {
    const data = setup(["new"], summary());
    data.complete.mockResolvedValueOnce({ ...response("", "error"), errorMessage: "socket reset PRIVATE-ERROR" } as ReturnType<typeof response>);
    const result = await data.coordinator.beforeCompact(data.event, data.ctx);
    expect(data.complete).toHaveBeenCalledTimes(2);
    expect(result?.compaction?.usage).toMatchObject({ input: 200, output: 200 });
    expect(data.complete.mock.calls[0]![2].sessionId).not.toBe(data.complete.mock.calls[1]![2].sessionId);
    expect(data.coordinator.diagnostics(data.ctx)).toMatchObject({ summaryCalls: 1, transportRetries: 1 });
    expect(JSON.stringify([...data.warn.mock.calls, ...data.debug.mock.calls])).not.toContain("PRIVATE-ERROR");
  });

  it("uses defaults for legacy config objects and reports phase wall times without persisting them", async () => {
    const data = setup(["new"], summary());
    delete data.config.compaction.directUpdate;
    delete data.config.compaction.inputBudget;
    delete data.config.compaction.maxConcurrentSegments;
    const result = await data.coordinator.beforeCompact(data.event, data.ctx);
    const diagnostics = data.coordinator.diagnostics(data.ctx);
    expect(diagnostics).toMatchObject({ path: "direct-update", inputBudgetMode: "summary", maxConcurrentSegments: 2 });
    const timings = diagnostics.timings!;
    for (const value of Object.values(timings)) expect(value).toBeGreaterThanOrEqual(0);
    expect(timings.totalMs).toBeGreaterThanOrEqual(timings.preparationMs + timings.generationMs + timings.aggregationMs + timings.persistenceMs);
    expect(JSON.stringify(result?.compaction?.details)).not.toContain("timings");
    expect(data.debug).toHaveBeenCalledWith("compaction.timings", expect.objectContaining({ path: "direct-update", ...timings }));
  });
});

describe("bounded compaction segment concurrency", () => {
  it("runs at most two segments, keeps source order after out-of-order completion, and aggregates only after all settle", async () => {
    const data = setup(oversizedTexts());
    const gates = [deferred<ReturnType<typeof response>>(), deferred<ReturnType<typeof response>>(), deferred<ReturnType<typeof response>>()];
    let running = 0;
    let maximum = 0;
    data.complete.mockImplementation(async (_model, request) => {
      const prompt: string = request.messages[0].content[0].text;
      if (prompt.includes("ordered child summaries")) { expect(running).toBe(0); return response(); }
      const index = ["one", "two", "three"].findIndex((word) => prompt.includes(`${word} ${word[0]!.repeat(10)}`));
      running++;
      maximum = Math.max(maximum, running);
      try { return await gates[index]!.promise; } finally { running--; }
    });
    const pending = data.coordinator.beforeCompact(data.event, data.ctx);
    await vi.waitFor(() => expect(data.complete).toHaveBeenCalledTimes(2));
    expect(data.coordinator.summaryGraph(data.ctx).totalNodes).toBe(0);
    gates[1]!.resolve(response(summary().replace("## Objective\n- None", "## Objective\n- two")));
    await vi.waitFor(() => expect(data.complete).toHaveBeenCalledTimes(3));
    gates[2]!.resolve(response(summary().replace("## Objective\n- None", "## Objective\n- three")));
    gates[0]!.resolve(response(summary().replace("## Objective\n- None", "## Objective\n- one")));
    const result = await pending;
    expect(maximum).toBe(2);
    expect(data.complete).toHaveBeenCalledTimes(4);
    const metadata = detail(result).ds4ContextEngine;
    expect(metadata.childSummaryIds).toEqual(["generated-1", "generated-2", "generated-3"]);
    expect(metadata.sourceEntryIds).toEqual(["source-0", "source-1", "source-2"]);
    expect(metadata.embeddedNodes.map((node) => node.sourceEntryIds)).toEqual([["source-0"], ["source-1"], ["source-2"]]);
    const aggregate = data.complete.mock.calls[3]![1].messages[0].content[0].text;
    expect(aggregate.indexOf("- one")).toBeLessThan(aggregate.indexOf("- two"));
    expect(aggregate.indexOf("- two")).toBeLessThan(aggregate.indexOf("- three"));
    expect(result?.compaction?.usage).toMatchObject({ totalTokens: 800 });
    expect(new Set(data.complete.mock.calls.map((call) => call[2].sessionId)).size).toBe(4);
  });

  it.each(["failure", "abort"])("stops scheduling and drains aborted peers before fallback (%s)", async (reason) => {
    const data = setup(oversizedTexts());
    const first = deferred<ReturnType<typeof response>>();
    const drain = deferred<ReturnType<typeof response>>();
    let peerSignal: AbortSignal | undefined;
    data.complete.mockImplementationOnce(() => first.promise);
    data.complete.mockImplementationOnce(async (_model, _request, options) => {
      peerSignal = options.signal;
      return drain.promise; // Deliberately cooperative late settlement, no early fallback.
    });
    let settled = false;
    const pending = data.coordinator.beforeCompact(data.event, data.ctx).then((result) => { settled = true; return result; });
    await vi.waitFor(() => expect(data.complete).toHaveBeenCalledTimes(2));
    if (reason === "abort") data.controller.abort();
    first.resolve(response(reason === "failure" ? "invalid structure" : summary()));
    await vi.waitFor(() => expect(peerSignal?.aborted).toBe(true));
    expect(settled).toBe(false);
    expect(data.complete).toHaveBeenCalledTimes(2);
    expect(data.coordinator.summaryGraph(data.ctx).totalNodes).toBe(0);
    drain.resolve(response());
    expect(await pending).toBeUndefined();
    expect(data.complete).toHaveBeenCalledTimes(2);
    expect(data.coordinator.summaryGraph(data.ctx).totalNodes).toBe(0);
    expect(data.coordinator.diagnostics(data.ctx).timings?.generationMs).toBeGreaterThanOrEqual(0);
  });

  it("cancels a sibling's transport backoff without scheduling its retry", async () => {
    const data = setup(oversizedTexts());
    data.config.compaction.transport = { maxAttempts: 3, baseDelayMs: 60_000 };
    const peer = deferred<ReturnType<typeof response>>();
    data.complete.mockResolvedValueOnce({ ...response("", "error"), errorMessage: "socket reset" } as ReturnType<typeof response>);
    data.complete.mockImplementationOnce(() => peer.promise);
    const pending = data.coordinator.beforeCompact(data.event, data.ctx);
    await vi.waitFor(() => expect(data.complete).toHaveBeenCalledTimes(2));
    peer.resolve(response("invalid structure"));
    expect(await pending).toBeUndefined();
    expect(data.complete).toHaveBeenCalledTimes(2);
    expect(data.coordinator.diagnostics(data.ctx).transportRetries).toBe(0);
    expect(data.coordinator.summaryGraph(data.ctx).totalNodes).toBe(0);
  });

  it("honors sequential mode and avoids work when already aborted", async () => {
    const data = setup(oversizedTexts());
    data.config.compaction.maxConcurrentSegments = 1;
    const first = deferred<ReturnType<typeof response>>();
    data.complete.mockImplementationOnce(() => first.promise);
    const pending = data.coordinator.beforeCompact(data.event, data.ctx);
    await vi.waitFor(() => expect(data.complete).toHaveBeenCalledTimes(1));
    first.resolve(response());
    expect(await pending).toBeDefined();
    expect(data.complete).toHaveBeenCalledTimes(4);
    const aborted = setup();
    aborted.controller.abort();
    expect(await aborted.coordinator.beforeCompact(aborted.event, aborted.ctx)).toBeUndefined();
    expect(aborted.complete).not.toHaveBeenCalled();
  });
});
