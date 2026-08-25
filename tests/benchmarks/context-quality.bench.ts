import { bench, describe } from "vitest";
import { DEFAULT_CONFIG } from "ds4-context-core/config/config";
import { calculateContextBudget } from "ds4-context-core/core/budget-manager";
import { createModelProfile } from "ds4-context-core/core/model-profile";
import type { ContextManifest } from "ds4-context-core/manifest/context-manifest";
import { planManagedContext } from "ds4-context-core/planner/context-planner";
import { evaluateManifestQuality } from "ds4-context-core/quality/context-quality";

const included = Array.from({ length: 500 }, (_, index) => ({
  kind: index === 499 ? "current" as const : "recent" as const,
  sourceId: `entry-${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  groupId: `group:${Math.floor(index / 2)}`,
  tokens: 20 + index % 30,
  score: index,
  reason: "Synthetic benchmark selection",
}));
const excluded = Array.from({ length: 500 }, (_, index) => ({
  kind: index % 2 === 0 ? "retrieval" as const : "project" as const,
  sourceId: `excluded-${index}`,
  groupId: `excluded:${index}`,
  tokens: 30 + index % 20,
  score: index,
  reason: "Synthetic benchmark budget drop",
}));
const manifest: ContextManifest = {
  schemaVersion: 1,
  id: "quality-benchmark-manifest",
  sessionId: "quality-benchmark-session",
  provider: "benchmark",
  model: "model",
  contextWindow: 128_000,
  outputReserve: 16_000,
  hardInputLimit: 100_000,
  targetInputTokens: 80_000,
  estimatedInputTokens: 30_000,
  included,
  excluded,
  summaryIds: [],
  retrievedEventIds: [],
  projectSnippets: [],
  composition: {
    systemTokens: 0,
    toolTokens: 0,
    messageTokens: 30_000,
    messageCount: included.length,
    toolCount: 0,
  },
  planning: {
    mode: "managed",
    originalMessageTokens: 60_000,
    originalMessageCount: 1000,
    fixedTokens: 0,
    messageTargetTokens: 80_000,
    messageHardLimitTokens: 100_000,
    recentTailTokenLimit: 20_000,
    selectedGroupCount: 250,
    excludedGroupCount: 500,
    durationMs: 5,
  },
  policyVersion: "policy-v1",
  plannerVersion: "managed-v1",
  promptHash: "benchmark-hash",
  createdAt: 1,
};

const pendingSamples: Array<{ manifest: ContextManifest }> = [];
const planningMessages = Array.from({ length: 1000 }, (_, index) => ({
  role: index % 2 === 0 ? "user" : "assistant",
  content: `synthetic planning message ${index} ${"x".repeat(80)}`,
  timestamp: index,
}));
const planningBudget = calculateContextBudget(createModelProfile({
  provider: "benchmark",
  id: "model",
  contextWindow: 128_000,
  maxTokens: 16_000,
}), DEFAULT_CONFIG.context);

function planWithQualityScheduling(enabled: boolean): void {
  planManagedContext({
    messages: planningMessages,
    fixedTokens: 2000,
    budget: planningBudget,
    config: DEFAULT_CONFIG.context,
  });
  if (!enabled) return;
  pendingSamples.push({ manifest });
  pendingSamples.length = 0;
}

describe("context quality metrics overhead", () => {
  bench("1000-message planner with metrics disabled", () => {
    planWithQualityScheduling(false);
  }, { time: 1_000 });

  bench("1000-message planner with quality scheduling", () => {
    planWithQualityScheduling(true);
  }, { time: 1_000 });

  bench("deferred metadata-only 1000-item materialization", () => {
    evaluateManifestQuality(manifest, {
      recent: 20_000,
      retrieval: 16_000,
      project: 20_000,
    });
  }, { time: 1_000 });
});
