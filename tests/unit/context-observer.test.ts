import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "ds4-context-core/config/config";
import { calculateContextBudget } from "ds4-context-core/core/budget-manager";
import { createModelProfile } from "ds4-context-core/core/model-profile";
import { planManagedContext } from "ds4-context-core/planner/context-planner";
import {
  buildPiObserverManifest,
  findPiPinnedMessageIndices,
  findPiSourceEntryIds,
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

  it("maps synthetic retrieval and project provenance without stealing the current user source", () => {
    const { ctx, pi, event, model } = fixture();
    const profile = createModelProfile(model);
    const contextConfig = { ...DEFAULT_CONFIG.context, mode: "managed" as const };
    const evidence = { role: "user" as const, content: "PRIVATE_RETRIEVED_PAYLOAD", timestamp: 2 };
    const project = { role: "user" as const, content: "PRIVATE_PROJECT_PAYLOAD", timestamp: 3 };
    const plan = planManagedContext({
      messages: event.messages,
      fixedTokens: 10,
      budget: calculateContextBudget(profile, contextConfig),
      config: contextConfig,
      supplementalMessages: [
        {
          id: "retrieval:entry-old",
          message: evidence,
          kind: "retrieval",
          sourceIds: ["entry-old"],
          score: 180,
          reason: "exact identifier match",
        },
        {
          id: "project:snippet-1",
          message: project,
          kind: "project",
          sourceIds: ["project:snippet-1"],
          score: 80,
          reason: "exact file match",
          projectSnippet: {
            snippetId: "snippet-1",
            path: "src/Target.ts",
            hash: "hash-1",
            startLine: 1,
            endLine: 20,
          },
        },
      ],
    });
    const manifest = buildPiObserverManifest({
      pi,
      event: { type: "context", messages: plan.messages },
      ctx,
      contextConfig,
      manifestId: "manifest-retrieval",
      createdAt: 1,
      policyVersion: "6",
      plannerVersion: "managed-privacy-v1",
      plan,
      projectRevision: {
        projectPath: "/workspace",
        branch: "main",
        head: "abc123",
        dirty: true,
        changedFiles: ["src/Target.ts"],
        indexedAt: 1,
      },
    });

    expect(manifest.retrievedEventIds).toEqual(["entry-old"]);
    expect(manifest.included.find((item) => item.kind === "retrieval")).toMatchObject({
      sourceId: "entry-old",
      role: "user",
    });
    expect(manifest.included.find((item) => item.kind === "project")).toMatchObject({
      sourceId: "project:snippet-1",
      role: "user",
    });
    expect(manifest.projectSnippets).toEqual([expect.objectContaining({
      snippetId: "snippet-1",
      path: "src/Target.ts",
      hash: "hash-1",
    })]);
    expect(manifest.projectRevision).toMatchObject({ head: "abc123", dirty: true });
    expect(manifest.included.find((item) => item.kind === "current")?.sourceId).toBe("entry-3");
    expect(JSON.stringify(manifest)).not.toContain("PRIVATE_RETRIEVED_PAYLOAD");
    expect(JSON.stringify(manifest)).not.toContain("PRIVATE_PROJECT_PAYLOAD");
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
      policyVersion: "6",
      plannerVersion: "managed-privacy-v1",
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

describe("planned entry id mapping", () => {
  it("maps planned messages back to entry ids and skips synthetic evidence", () => {
    const { ctx, event, model } = fixture();
    const profile = createModelProfile(model);
    const contextConfig = { ...DEFAULT_CONFIG.context, mode: "managed" as const, recentTailTokens: 0 };
    const memory = { role: "user" as const, content: "PRIVATE_MEMORY_PAYLOAD", timestamp: 2 };
    const plan = planManagedContext({
      messages: event.messages,
      fixedTokens: 10,
      budget: calculateContextBudget(profile, contextConfig),
      config: contextConfig,
      supplementalMessages: [
        {
          id: "memory:m1",
          message: memory,
          kind: "memory",
          sourceIds: ["m1"],
          score: 90,
          reason: "memory match",
        },
      ],
    });
    const syntheticIndices = new Set(
      [...plan.selected, ...plan.excluded]
        .filter((metadata) => metadata.kind === "memory")
        .map((metadata) => metadata.originalIndex),
    );
    const sources = findPiSourceEntryIds(plan.originalMessages, ctx, syntheticIndices);

    expect(plan.originalMessages).toEqual([event.messages[0], event.messages[1], memory, event.messages[2]]);
    expect(sources).toEqual(["entry-1", "entry-2", undefined, "entry-3"]);
  });

  it("keeps native ds4:pin groups mapped as real sources", () => {
    const { ctx, event, model } = fixture();
    const profile = createModelProfile(model);
    const contextConfig = { ...DEFAULT_CONFIG.context, mode: "managed" as const, recentTailTokens: 0 };
    const plan = planManagedContext({
      messages: event.messages,
      fixedTokens: 10,
      budget: calculateContextBudget(profile, contextConfig),
      config: contextConfig,
    });
    const sources = findPiSourceEntryIds(plan.originalMessages, ctx);

    expect(sources).toEqual(["entry-1", "entry-2", "entry-3"]);
  });
});
