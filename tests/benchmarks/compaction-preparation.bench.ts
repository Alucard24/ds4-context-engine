import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { bench, describe } from "vitest";
import { createDefaultConfig } from "ds4-context-core/config/config";
import { calculateContextBudget } from "ds4-context-core/core/budget-manager";
import { createModelProfile } from "ds4-context-core/core/model-profile";
import { silentLogger } from "ds4-context-core/shared/logging";
import { prepareCompactionSource } from "../../src/pi-adapter/compaction-adapter.ts";
import { CompactionCoordinator } from "../../src/pi-adapter/compaction-coordinator.ts";

// Synthetic-only: no session files, database, credentials or provider calls.
const messages = Array.from({ length: 1_283 }, (_, index) => ({
  role: "user" as const,
  content: `Synthetic source ${index}: ${"x".repeat(900)}`,
  timestamp: index + 1,
}));
const prefix = Array.from({ length: 1_500 }, (_, index) => ({
  role: "user" as const,
  content: `Unrelated canonical entry ${index}: ${"y".repeat(900)}`,
  timestamp: -index,
}));
const entries = [...prefix, ...messages].map((message, index): SessionEntry => ({
  type: "message",
  id: `entry-${index}`,
  parentId: index === 0 ? null : `entry-${index - 1}`,
  timestamp: "2026-01-01T00:00:00.000Z",
  message,
}));
const config = createDefaultConfig();
const model = {
  provider: "synthetic", id: "no-network", contextWindow: 1_050_000, maxTokens: 32_768,
  api: "openai-responses", input: ["text"],
} as Model<Api>;
const ctx = {
  model, hasUI: false,
  sessionManager: {
    getBranch: () => entries,
    getEntries: () => entries,
    getLeafId: () => "retained",
  },
  getContextUsage: () => undefined,
  modelRegistry: {
    // A length response prevents graph persistence and skips all network activity.
    complete: async () => ({ stopReason: "length", content: [], usage: {} }),
    find: () => undefined,
    hasConfiguredAuth: () => true,
  },
} as unknown as ExtensionContext;
const event = {
  type: "session_before_compact",
  reason: "manual",
  signal: new AbortController().signal,
  willRetry: false,
  preparation: {
    firstKeptEntryId: "retained", tokensBefore: 207_703, isSplitTurn: false,
    messagesToSummarize: messages.map((message) => ({ ...message })),
    turnPrefixMessages: [],
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
    settings: { enabled: true, reserveTokens: 32_768, keepRecentTokens: 20_000 },
  },
  branchEntries: entries,
} as SessionBeforeCompactEvent;
const options = { time: 0, iterations: 1, warmupTime: 0, warmupIterations: 0 };

describe("synthetic compaction preparation (1,283 source messages, 1,500 preceding entries)", () => {
  bench("map canonical source and serialize once", () => {
    prepareCompactionSource(event);
  }, options);

  bench("entire DS4 preparation, local fake provider returns length", async () => {
    const coordinator = new CompactionCoordinator({
      config, sessionId: "synthetic", persisted: false, logger: silentLogger,
      now: () => 1, idGenerator: () => "unused", syncSessionIndex: () => {},
      latestManifest: () => undefined,
      resolveModelBudget: (selected) => ({
        budget: calculateContextBudget(createModelProfile(selected), config.context),
        recentTailTokens: 64_000,
      }),
      checkCoreCompatibility: () => {},
    });
    await coordinator.beforeCompact(event, ctx);
    const diagnostic = coordinator.diagnostics(ctx);
    if (diagnostic.phase !== "failed" || diagnostic.timings === undefined) {
      throw new Error("Synthetic compaction did not reach the expected local fallback");
    }
    if (process.env.DS4_BENCH_DIAGNOSTICS === "1") {
      console.info(JSON.stringify({
        timings: diagnostic.timings,
        segmentCount: diagnostic.segmentCount,
        sourceEntries: diagnostic.sourceEntries,
        sourcePromptTokens: diagnostic.sourcePromptTokens,
      }));
    }
  }, options);
});
