import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { calculateContextBudget } from "../../src/core/budget-manager.ts";
import { createModelProfile } from "../../src/core/model-profile.ts";
import { planManagedContext } from "../../src/planner/context-planner.ts";
import {
  buildPiObserverManifest,
  findPiPinnedMessageIndices,
} from "../../src/pi-adapter/context-observer.ts";

function fixture() {
  const messages = [
    { role: "user", content: "PRIVATE_OLD_PAYLOAD", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "ack" }], timestamp: 2 },
    { role: "user", content: "PRIVATE_CURRENT_PAYLOAD", timestamp: 3 },
  ];
  const entries = messages.map((message, index) => ({
    type: "message",
    id: `entry-${index + 1}`,
    parentId: index === 0 ? null : `entry-${index}`,
    timestamp: `2026-08-24T00:00:0${index + 1}.000Z`,
    message,
  })) as unknown as SessionEntry[];
  entries.push({
    type: "label",
    id: "label-1",
    parentId: "entry-3",
    timestamp: "2026-08-24T00:00:04.000Z",
    targetId: "entry-1",
    label: "ds4:pin durable constraint",
  });
  const model = {
    id: "model",
    name: "Model",
    api: "openai-responses",
    provider: "test",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 4_096,
  };
  const ctx = {
    cwd: "/project",
    sessionManager: {
      getSessionId: () => "session",
      getSessionFile: () => "/project/session.jsonl",
      getLeafId: () => "entry-3",
      getEntries: () => entries,
      getBranch: () => entries,
      buildContextEntries: () => entries,
    },
    model,
    getSystemPrompt: () => "system",
    getContextUsage: () => undefined,
  } as unknown as ExtensionContext;
  const pi = {
    getActiveTools: () => [],
    getAllTools: () => [],
  } as unknown as ExtensionAPI;
  const event = { type: "context", messages } as unknown as ContextEvent;
  return { ctx, pi, event, model };
}

describe("Pi managed-context adapter", () => {
  it("maps active ds4:pin labels to message indices", () => {
    const { ctx, event } = fixture();
    expect(findPiPinnedMessageIndices(event, ctx)).toEqual([0]);
  });

  it("preserves source provenance for planner exclusions", () => {
    const { ctx, pi, event, model } = fixture();
    const profile = createModelProfile(model);
    const contextConfig = { ...DEFAULT_CONFIG.context, mode: "managed" as const, recentTailTokens: 0 };
    const plan = planManagedContext({
      messages: event.messages,
      fixedTokens: 10,
      budget: calculateContextBudget(profile, contextConfig),
      config: contextConfig,
    });
    const manifest = buildPiObserverManifest({
      pi,
      event: { type: "context", messages: plan.messages },
      ctx,
      contextConfig,
      manifestId: "manifest",
      createdAt: 1,
      policyVersion: "1",
      plannerVersion: "managed-v1",
      plan,
    });

    expect(manifest.included.find((item) => item.kind === "current")?.sourceId).toBe("entry-3");
    expect(manifest.excluded.filter((item) => item.groupId === "group:0-1").map((item) => item.sourceId))
      .toEqual(["entry-1", "entry-2"]);
    expect(manifest.planning).toMatchObject({ mode: "managed", originalMessageCount: 3 });
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("PRIVATE_OLD_PAYLOAD");
    expect(serialized).not.toContain("PRIVATE_CURRENT_PAYLOAD");
  });
});
