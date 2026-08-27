import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { MemoryConflictError } from "ds4-context-core/memory/memory-manager";
import type { MemoryItem, PinItem, ProjectMemorySource } from "ds4-context-core/memory/memory-types";
import type { PrivacyClassification } from "ds4-context-core/privacy/privacy-policy";
import {
  CONTEXT_PERSISTENCE_PARAMS,
  validateContextPersistenceParams,
} from "../../src/extension/context-persistence-contract.ts";
import {
  CONTEXT_PERSISTENCE_EGRESS_SENTINEL,
  sanitizeContextPersistenceHistory,
} from "../../src/extension/context-persistence-egress.ts";
import {
  createContextPersistenceTool,
  type ContextPersistenceRuntimePort,
  type ContextPersistenceRuntimeState,
} from "../../src/extension/context-persistence-tool.ts";
import { Ds4ContextRuntime } from "../../src/extension/runtime.ts";

const provenance = {
  sourceSessionId: "session-a",
  mutationEntryId: "mutation-a",
  sourceEntryIds: ["user-a"],
  contradicts: [],
};

function pin(overrides: Partial<PinItem> = {}): PinItem {
  return {
    id: "pin-a",
    scope: "session",
    sessionId: "session-a",
    classification: "normal",
    content: "Never expose pin body SECRET-PIN",
    status: "active",
    createdAt: 100,
    updatedAt: 200,
    provenance,
    ...overrides,
  };
}

function memory(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: "memory-a",
    scope: "session",
    sessionId: "session-a",
    key: "secret-key-name",
    classification: "normal",
    claim: "PostgreSQL is the durable default SECRET-MEMORY",
    status: "active",
    createdAt: 100,
    updatedAt: 300,
    originSessionId: "session-a",
    sourceEntryIds: ["user-a"],
    provenance,
    ...overrides,
  };
}

function source(overrides: Partial<ProjectMemorySource> = {}): ProjectMemorySource {
  return {
    projectPath: "/private/project",
    sessionId: "private-session-id",
    sessionFile: "/private/session.jsonl",
    status: "ready",
    indexedRecords: 10,
    indexedMutations: 3,
    malformedLines: 0,
    activeProjectMemories: 1,
    activeProjectPins: 2,
    indexedAt: 400,
    lastError: "private raw error",
    exclusionReason: "private reason",
    ...overrides,
  };
}

class FakeRuntime implements ContextPersistenceRuntimePort {
  state: ContextPersistenceRuntimeState = {
    available: true,
    phase: "managed",
    sessionId: "session-a",
    projectIdentity: "/private/project",
    projectTrusted: true,
    crossSessionEnabled: true,
    crossSessionReady: true,
    defaultClassification: "normal",
    maxResults: 12,
    maxPinChars: 4_000,
    maxClaimChars: 2_000,
    provider: "remote-provider",
  };
  pins = [pin()];
  memories = [memory()];
  sources = [source()];
  allowPreview = true;
  pinScans = 0;
  memoryScans = 0;
  mutationCalls = 0;
  sourcePolicyCalls = 0;
  sourcePolicyThrowAfterUpdate = false;
  throwStateAfterMutation = false;
  provenanceValid = true;
  throwBeforeAppend = false;
  throwAfterAppend = false;
  memoryConflict = false;
  outcomes: Array<{ outcome: string; errorCode?: string }> = [];

  contextPersistenceState(): ContextPersistenceRuntimeState {
    if (this.throwStateAfterMutation && this.mutationCalls > 0) {
      throw new Error("private post-materialization state error");
    }
    return this.state;
  }

  contextPersistenceSanitizeText(
    text: string,
    classification: PrivacyClassification | undefined,
    _provider: string,
  ) {
    return {
      value: text.replace(/SECRET-[A-Z]+/gu, "[REDACTED]"),
      classification: classification ?? "normal",
      allowed: this.allowPreview,
    };
  }

  contextPersistenceMutationPolicy(
    text: string,
    requested: PrivacyClassification | undefined,
    inherited: PrivacyClassification | undefined,
  ) {
    const ranks: Record<PrivacyClassification, number> = {
      normal: 0,
      internal: 1,
      sensitive: 2,
      "local-only": 3,
    };
    const secretDetected = /SECRET|api_key/iu.test(text);
    const markerDetected = /\[\/?ds4:/iu.test(text);
    const candidates = [
      requested,
      inherited,
      markerDetected ? "local-only" as const : undefined,
      secretDetected ? "sensitive" as const : undefined,
    ]
      .filter((value): value is PrivacyClassification => value !== undefined);
    const storedClassification = candidates.sort((left, right) => ranks[right] - ranks[left])[0];
    const classification = storedClassification ?? this.state.defaultClassification;
    return {
      classification,
      ...(storedClassification ? { storedClassification } : {}),
      allowed: classification !== "local-only" || this.state.provider === "faux",
      secretDetected,
      markerDetected,
    };
  }

  contextPersistenceResolveProvenance(ctx: ExtensionContext) {
    const branch = ctx.sessionManager.getBranch();
    const primary = [...branch].reverse().find((entry) =>
      entry.type === "message" && entry.message.role === "user");
    return primary
      ? {
          sessionId: ctx.sessionManager.getSessionId(),
          leafId: ctx.sessionManager.getLeafId() ?? undefined,
          branchEntryIds: branch.map((entry) => entry.id),
          primarySourceEntryId: primary.id,
        }
      : undefined;
  }

  contextPersistenceValidateProvenance(): boolean {
    return this.provenanceValid;
  }

  contextPersistenceResolvePin(id: string, activeOnly: boolean): PinItem | undefined {
    return this.pins.find((item) => item.id === id && (!activeOnly || item.status === "active"));
  }

  contextPersistenceResolveMemory(id: string, activeOnly: boolean): MemoryItem | undefined {
    return this.memories.find((item) => item.id === id && (!activeOnly || item.status === "active"));
  }

  contextPersistenceListPinsPage(ctx: ExtensionContext, activeOnly: boolean, limit: number) {
    const branchIds = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
    const items = this.pins
      .filter((item) => !activeOnly || item.status === "active")
      .sort((left, right) => Number(right.status === "active") - Number(left.status === "active")
        || Number(right.scope !== "branch" || branchIds.has(right.branchLeafId ?? ""))
          - Number(left.scope !== "branch" || branchIds.has(left.branchLeafId ?? ""))
        || right.updatedAt - left.updatedAt
        || left.id.localeCompare(right.id, "en-US"));
    return { items: items.slice(0, limit), hasMore: items.length > limit };
  }

  contextPersistenceListMemoriesPage(activeOnly: boolean, limit: number) {
    const items = this.memories
      .filter((item) => !activeOnly || item.status === "active")
      .sort((left, right) => Number(right.status === "active") - Number(left.status === "active")
        || right.updatedAt - left.updatedAt
        || left.id.localeCompare(right.id, "en-US"));
    return { items: items.slice(0, limit), hasMore: items.length > limit };
  }

  contextPersistenceScanPins(
    activeOnly: boolean,
    _pageSize: number,
    scanCap: number,
    signal?: AbortSignal,
  ) {
    this.pinScans += 1;
    const items = this.pins
      .filter((item) => !activeOnly || item.status === "active")
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id, "en-US"));
    return {
      items: items.slice(0, scanCap),
      incomplete: items.length > scanCap,
      aborted: signal?.aborted === true,
    };
  }

  contextPersistenceScanMemories(
    activeOnly: boolean,
    _pageSize: number,
    scanCap: number,
    signal?: AbortSignal,
  ) {
    this.memoryScans += 1;
    const items = this.memories
      .filter((item) => !activeOnly || item.status === "active")
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id, "en-US"));
    return {
      items: items.slice(0, scanCap),
      incomplete: items.length > scanCap,
      aborted: signal?.aborted === true,
    };
  }

  contextPersistenceProjectSourcesPage(limit: number) {
    const items = this.sources
      .sort((left, right) => right.indexedAt - left.indexedAt
        || left.sessionId.localeCompare(right.sessionId, "en-US"));
    return { items: items.slice(0, limit), hasMore: items.length > limit };
  }

  contextPersistenceResolveProjectSource(sessionId: string): ProjectMemorySource | undefined {
    return this.sources.find((item) => item.sessionId === sessionId);
  }

  contextPersistenceSetProjectSourceExcluded(
    sessionId: string,
    excluded: boolean,
    reason?: string,
  ): ProjectMemorySource | undefined {
    this.sourcePolicyCalls += 1;
    const target = this.contextPersistenceResolveProjectSource(sessionId);
    if (!target) return undefined;
    target.status = excluded ? "excluded" : "ready";
    target.exclusionReason = excluded ? reason : undefined;
    if (this.sourcePolicyThrowAfterUpdate) throw new Error("private source sync error");
    return target;
  }

  contextPersistenceCreatePin(
    input: {
      content: string;
      scope: "session" | "branch" | "project";
      sourceEntryId: string;
      supersedes?: string;
      classification?: PrivacyClassification;
    },
    _ctx: ExtensionContext,
    appendEntry: (customType: string, data: unknown) => void,
  ) {
    this.mutationCalls += 1;
    if (this.throwBeforeAppend) throw new Error("private pre-append error");
    const duplicate = this.pins.find((item) =>
      item.status === "active" && item.scope === input.scope && item.content === input.content);
    if (duplicate && !input.supersedes) return { pin: duplicate, duplicate: true };
    const created = pin({
      id: `pin-created-${this.mutationCalls}`,
      content: input.content,
      scope: input.scope,
      ...(input.scope === "branch" ? { branchLeafId: "leaf-a" } : {}),
      ...(input.classification ? { classification: input.classification } : {}),
      createdAt: 500 + this.mutationCalls,
      updatedAt: 500 + this.mutationCalls,
      provenance: { ...provenance, sourceEntryIds: [input.sourceEntryId] },
    });
    appendEntry("ds4-context-pin-v1", {
      operation: input.supersedes ? "supersede" : "add",
      item: { id: created.id },
    });
    if (this.throwAfterAppend) throw new Error("private projection error");
    if (input.supersedes) {
      const previous = this.pins.find((item) => item.id === input.supersedes);
      if (previous) {
        previous.status = "superseded";
        previous.updatedAt = created.updatedAt;
        previous.supersededBy = created.id;
      }
    }
    this.pins.push(created);
    return { pin: created, duplicate: false };
  }

  contextPersistenceUnpin(
    id: string,
    reason: string | undefined,
    _ctx: ExtensionContext,
    appendEntry: (customType: string, data: unknown) => void,
  ): PinItem {
    this.mutationCalls += 1;
    const target = this.pins.find((item) => item.id === id);
    if (!target) throw new Error("missing");
    appendEntry("ds4-context-pin-v1", { operation: "status", pinId: id });
    if (this.throwAfterAppend) throw new Error("private projection error");
    target.status = "deleted";
    target.updatedAt += 1;
    target.statusReason = reason;
    return target;
  }

  contextPersistenceCreateMemory(
    input: {
      claim: string;
      scope: "session" | "project";
      key?: string;
      classification?: PrivacyClassification;
      sourceEntryIds: string[];
    },
    _ctx: ExtensionContext,
    appendEntry: (customType: string, data: unknown) => void,
  ) {
    this.mutationCalls += 1;
    if (this.memoryConflict) throw new MemoryConflictError(["private-conflict-id"]);
    const duplicate = this.memories.find((item) =>
      item.status === "active" && item.scope === input.scope && item.claim === input.claim);
    if (duplicate) return { memory: duplicate, duplicate: true };
    const created = memory({
      id: `memory-created-${this.mutationCalls}`,
      claim: input.claim,
      scope: input.scope,
      ...(input.key ? { key: input.key } : { key: undefined }),
      ...(input.classification ? { classification: input.classification } : { classification: undefined }),
      createdAt: 600 + this.mutationCalls,
      updatedAt: 600 + this.mutationCalls,
      sourceEntryIds: [...input.sourceEntryIds],
      provenance: { ...provenance, sourceEntryIds: [...input.sourceEntryIds] },
    });
    appendEntry("ds4-context-memory-v1", { operation: "add", item: { id: created.id } });
    if (this.throwAfterAppend) throw new Error("private projection error");
    this.memories.push(created);
    return { memory: created, duplicate: false };
  }

  contextPersistenceSupersedeMemory(
    id: string,
    claim: string,
    sourceEntryIds: string[],
    classification: PrivacyClassification | undefined,
    _ctx: ExtensionContext,
    appendEntry: (customType: string, data: unknown) => void,
  ): MemoryItem {
    this.mutationCalls += 1;
    const target = this.memories.find((item) => item.id === id && item.status === "active");
    if (!target) throw new Error("missing");
    const created = memory({
      id: `memory-created-${this.mutationCalls}`,
      claim,
      scope: target.scope,
      key: target.key,
      ...(classification ? { classification } : { classification: undefined }),
      createdAt: 600 + this.mutationCalls,
      updatedAt: 600 + this.mutationCalls,
      sourceEntryIds: [...sourceEntryIds],
      provenance: { ...provenance, sourceEntryIds: [...sourceEntryIds], supersedes: id },
    });
    appendEntry("ds4-context-memory-v1", {
      operation: "supersede",
      previousId: id,
      item: { id: created.id },
    });
    if (this.throwAfterAppend) throw new Error("private projection error");
    target.status = "superseded";
    target.updatedAt = created.updatedAt;
    target.supersededBy = created.id;
    this.memories.push(created);
    return created;
  }

  contextPersistenceSetMemoryStatus(
    id: string,
    status: "invalid" | "expired",
    reason: string | undefined,
    _ctx: ExtensionContext,
    appendEntry: (customType: string, data: unknown) => void,
  ): MemoryItem {
    this.mutationCalls += 1;
    const target = this.memories.find((item) => item.id === id && item.status === "active");
    if (!target) throw new Error("missing");
    appendEntry("ds4-context-memory-v1", { operation: "status", memoryId: id, status });
    if (this.throwAfterAppend) throw new Error("private projection error");
    target.status = status;
    target.updatedAt += 1;
    target.statusReason = reason;
    return target;
  }

  contextPersistenceRecordOutcome(record: { outcome: string; errorCode?: string }): void {
    this.outcomes.push(record);
  }
}

function context(options: {
  hasUI?: boolean;
  confirm?: (title: string, message: string) => Promise<boolean>;
} = {}): ExtensionContext {
  const branch = [
    { id: "user-a", type: "message", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "remember" } },
    { id: "leaf-a", type: "message", parentId: "user-a", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [] } },
  ];
  return {
    cwd: "/private/project",
    hasUI: options.hasUI ?? false,
    mode: "print",
    ui: {
      confirm: options.confirm ?? (async () => false),
    },
    model: { provider: "remote-provider" },
    sessionManager: {
      getSessionId: () => "session-a",
      getLeafId: () => "leaf-a",
      getBranch: () => branch,
    },
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
}

describe("context_persistence contract and read slice", () => {
  it("uses a Google-compatible enum schema and sequential execution", () => {
    const runtime = new FakeRuntime();
    const tool = createContextPersistenceTool(runtime, {
      processSecret: new Uint8Array(32).fill(7),
    });
    expect(tool.executionMode).toBe("sequential");
    expect(tool.description).toContain("explicit user request");
    expect(tool.description).toContain("local user confirmation");
    expect(tool.promptGuidelines?.join(" ")).toContain("Never create a pin or memory merely because information appears useful");
    expect(tool.promptGuidelines?.join(" ")).toContain("context_persistence itself obtains the required local UI confirmation");
    expect(tool.promptGuidelines?.join(" ")).toContain("Never reuse an egress omission marker as tool input");
    expect(tool.promptGuidelines?.join(" ")).toContain("never mutate from a fuzzy query");
    expect(CONTEXT_PERSISTENCE_PARAMS.properties.action).toMatchObject({ type: "string" });
    expect(CONTEXT_PERSISTENCE_PARAMS.properties.action).toHaveProperty("enum");
    expect(CONTEXT_PERSISTENCE_PARAMS.properties.scope).toHaveProperty(
      "description",
      "Add only; Memory excludes branch",
    );
    expect(CONTEXT_PERSISTENCE_PARAMS.properties.reason).toHaveProperty(
      "description",
      "Lifecycle or source exclusion only",
    );
  });

  it("rejects action-inapplicable fields and branch Memory", () => {
    expect(validateContextPersistenceParams({ action: "pins_list", reason: "no" })).toEqual({
      ok: false,
      errorCode: "invalid-parameters",
    });
    expect(validateContextPersistenceParams({
      action: "memory_add",
      content: "claim",
      scope: "branch",
    })).toEqual({ ok: false, errorCode: "invalid-scope" });
    expect(validateContextPersistenceParams({
      action: "pin_add",
      content: "claim",
      confirmed: true,
    } as any)).toEqual({ ok: false, errorCode: "invalid-parameters" });
  });

  it("reserves the historical egress placeholder across all string arguments", () => {
    const placeholder = CONTEXT_PERSISTENCE_EGRESS_SENTINEL;
    const cases = [
      { action: "pin_add", content: placeholder },
      { action: "memory_find", query: `prefix ${placeholder} suffix` },
      { action: "memory_add", content: "claim", key: placeholder },
      { action: "pin_unpin", id: "pin-a", targetRevision: "rev_x", reason: placeholder },
      { action: "pin_unpin", id: placeholder, targetRevision: "rev_x" },
      { action: "pin_unpin", id: "pin-a", targetRevision: placeholder },
    ] as const;
    for (const params of cases) {
      expect(validateContextPersistenceParams(params)).toEqual({
        ok: false,
        errorCode: "egress-placeholder",
      });
    }
  });

  it("reports action-specific validation failures with the correct persistence class", async () => {
    const tool = createContextPersistenceTool(new FakeRuntime(), {
      processSecret: new Uint8Array(32).fill(7),
    });
    const write = await tool.execute("call-invalid-write", {
      action: "pin_add",
      content: "claim",
      reason: "not-applicable",
    } as any, undefined, undefined, context());
    expect(write.details).toMatchObject({
      outcome: "rejected",
      errorCode: "invalid-parameters",
      persistenceClass: "canonical-jsonl",
    });
    const read = await tool.execute("call-invalid-read", {
      action: "pins_list",
      reason: "not-applicable",
    } as any, undefined, undefined, context());
    expect(read.details).toMatchObject({
      outcome: "rejected",
      errorCode: "invalid-parameters",
      persistenceClass: "read-only",
    });
  });

  it("returns ordered metadata needed for an exact follow-up without raw bodies or keys", async () => {
    const runtime = new FakeRuntime();
    runtime.memories = [
      memory({ id: "memory-z", updatedAt: 400 }),
      memory({ id: "memory-a", updatedAt: 400, key: "private-key" }),
      memory({ id: "memory-old", status: "invalid", updatedAt: 900 }),
    ];
    const tool = createContextPersistenceTool(runtime, {
      processSecret: new Uint8Array(32).fill(7),
    });
    const result = await tool.execute("call-list", {
      action: "memory_list",
      activeOnly: false,
      maxResults: 2,
    }, undefined, undefined, context());
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(result.details).toMatchObject({
      schema: "ds4-context-persistence-result-v1",
      action: "memory_list",
      count: 2,
      truncated: true,
      incomplete: false,
    });
    expect((result.details.items ?? []).map((item) => "id" in item ? item.id : "")).toEqual([
      "memory-a",
      "memory-z",
    ]);
    expect(text).toContain("memory memory-a");
    expect(text).toContain("revision=rev_");
    expect(text).not.toContain("PostgreSQL is the durable default");
    expect(text).not.toContain("private-key");
    expect(JSON.stringify(result.details)).not.toContain("private-key");
  });

  it("sanitizes a complete find body before truncation and can suppress previews", async () => {
    const runtime = new FakeRuntime();
    const tool = createContextPersistenceTool(runtime, {
      processSecret: new Uint8Array(32).fill(8),
    });
    const included = await tool.execute("call-find", {
      action: "memory_find",
      query: "durable default",
    }, undefined, undefined, context());
    const includedText = included.content[0]?.type === "text" ? included.content[0].text : "";
    expect(includedText).toContain("[REDACTED]");
    expect(includedText).not.toContain("SECRET-MEMORY");
    expect(JSON.stringify(included.details)).not.toContain("PostgreSQL");

    runtime.allowPreview = false;
    const omitted = await tool.execute("call-find-2", {
      action: "memory_find",
      query: "durable default",
    }, undefined, undefined, context());
    const omittedText = omitted.content[0]?.type === "text" ? omitted.content[0].text : "";
    expect(omittedText).toContain("preview omitted by policy");
    expect(omittedText).not.toContain("PostgreSQL");
  });

  it("uses a visible exact-ID fast path without reading or previewing the body", async () => {
    const runtime = new FakeRuntime();
    const tool = createContextPersistenceTool(runtime, {
      processSecret: new Uint8Array(32).fill(8),
    });
    const result = await tool.execute("call-exact", {
      action: "memory_find",
      query: "memory-a",
    }, undefined, undefined, context());
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(runtime.memoryScans).toBe(0);
    expect(result.details.items?.[0]).toMatchObject({
      id: "memory-a",
      matchKind: "metadata-only",
      previewStatus: "omitted-by-policy",
    });
    expect(text).not.toContain("PostgreSQL");
    expect(text).not.toContain("[REDACTED]");
  });

  it("uses volatile source refs and omits source identity, paths, errors, and reasons", async () => {
    const runtime = new FakeRuntime();
    let byte = 0;
    const tool = createContextPersistenceTool(runtime, {
      processSecret: new Uint8Array(32).fill(9),
      now: () => 1_000,
      randomBytes: (size) => new Uint8Array(size).fill(++byte),
    });
    const result = await tool.execute("call-sources", {
      action: "memory_sources",
    }, undefined, undefined, context());
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("source_");
    expect(serialized).not.toContain("private-session-id");
    expect(serialized).not.toContain("/private/");
    expect(serialized).not.toContain("private raw error");
    expect(serialized).not.toContain("private reason");
  });

  it("confirms exact derived source-policy changes without canonical append or private identity egress", async () => {
    const runtime = new FakeRuntime();
    let confirmation = "";
    let confirmations = 0;
    const tool = createContextPersistenceTool(runtime, {
      processSecret: new Uint8Array(32).fill(17),
      now: () => 1_000,
      randomBytes: (size) => new Uint8Array(size).fill(7),
    });
    const ctx = context({
      hasUI: true,
      confirm: async (_title, message) => {
        confirmations += 1;
        confirmation = message;
        return true;
      },
    });
    const listed = await tool.execute("call-sources", {
      action: "memory_sources",
    }, undefined, undefined, ctx);
    const target = listed.details.items?.[0];
    if (!target || target.kind !== "project-memory-source") throw new Error("Expected source target");

    const excluded = await tool.execute("call-source-exclude", {
      action: "memory_source_exclude",
      id: target.sourceRef,
      targetRevision: target.targetRevision,
      reason: "Obsolete source branch",
    }, undefined, undefined, ctx);
    expect(excluded.details).toMatchObject({
      outcome: "committed",
      persistenceClass: "derived-local-policy",
      sourceRef: target.sourceRef,
      kind: "project-memory-source",
      status: "excluded",
    });
    expect(excluded.details.targetRevision).toMatch(/^rev_/u);
    expect(excluded.details.targetRevision).not.toBe(target.targetRevision);
    expect(confirmation).toContain(target.sourceRef);
    expect(confirmation).toContain("Status: ready");
    expect(confirmation).toContain("derived local SQLite policy (disposable)");
    expect(confirmation).not.toContain("private-session-id");
    expect(confirmation).not.toContain("/private/");
    expect(confirmation).not.toContain("Obsolete source branch");
    expect(JSON.stringify(excluded)).not.toContain("private-session-id");
    expect(JSON.stringify(excluded)).not.toContain("Obsolete source branch");
    expect(runtime.sourcePolicyCalls).toBe(1);
    expect(runtime.mutationCalls).toBe(0);

    const stale = await tool.execute("call-source-include-stale", {
      action: "memory_source_include",
      id: target.sourceRef,
      targetRevision: target.targetRevision,
    }, undefined, undefined, ctx);
    expect(stale.details).toMatchObject({ outcome: "rejected", errorCode: "stale-target" });
    expect(runtime.sourcePolicyCalls).toBe(1);

    const included = await tool.execute("call-source-include", {
      action: "memory_source_include",
      id: target.sourceRef,
      targetRevision: excluded.details.targetRevision ?? "",
    }, undefined, undefined, ctx);
    expect(included.details).toMatchObject({
      outcome: "committed",
      persistenceClass: "derived-local-policy",
      status: "ready",
    });
    expect(runtime.sourcePolicyCalls).toBe(2);

    const idempotent = await tool.execute("call-source-include-again", {
      action: "memory_source_include",
      id: target.sourceRef,
      targetRevision: included.details.targetRevision ?? "",
    }, undefined, undefined, ctx);
    expect(idempotent.details).toMatchObject({ outcome: "ok", status: "ready" });
    expect(runtime.sourcePolicyCalls).toBe(2);
    expect(confirmations).toBe(3);
  });

  it("fails source policy closed for capabilities, secrets, cancellation, and expired source refs", async () => {
    const runtime = new FakeRuntime();
    let now = 1_000;
    let confirmations = 0;
    const tool = createContextPersistenceTool(runtime, {
      processSecret: new Uint8Array(32).fill(18),
      now: () => now,
      randomBytes: (size) => new Uint8Array(size).fill(8),
    });
    const accepted = context({
      hasUI: true,
      confirm: async () => {
        confirmations += 1;
        return true;
      },
    });
    const listed = await tool.execute("call-sources", {
      action: "memory_sources",
    }, undefined, undefined, accepted);
    const target = listed.details.items?.[0];
    if (!target || target.kind !== "project-memory-source") throw new Error("Expected source target");

    runtime.state.crossSessionEnabled = false;
    const disabled = await tool.execute("call-source-disabled", {
      action: "memory_source_exclude",
      id: target.sourceRef,
      targetRevision: target.targetRevision,
    }, undefined, undefined, accepted);
    expect(disabled.details).toMatchObject({ outcome: "unavailable", errorCode: "cross-session-disabled" });
    expect(confirmations).toBe(0);

    runtime.state.crossSessionEnabled = true;
    runtime.state.sessionId = "session-b";
    const wrongSession = await tool.execute("call-source-wrong-session", {
      action: "memory_source_exclude",
      id: target.sourceRef,
      targetRevision: target.targetRevision,
    }, undefined, undefined, accepted);
    expect(wrongSession.details).toMatchObject({ outcome: "rejected", errorCode: "stale-target" });
    runtime.state.sessionId = "session-a";

    const secret = await tool.execute("call-source-secret", {
      action: "memory_source_exclude",
      id: target.sourceRef,
      targetRevision: target.targetRevision,
      reason: "api_key=PRIVATE-VALUE",
    }, undefined, undefined, accepted);
    expect(secret.details).toMatchObject({ outcome: "rejected", errorCode: "secret-in-reason" });
    expect(confirmations).toBe(0);

    const cancelled = await tool.execute("call-source-cancel", {
      action: "memory_source_exclude",
      id: target.sourceRef,
      targetRevision: target.targetRevision,
    }, undefined, undefined, context({ hasUI: true, confirm: async () => false }));
    expect(cancelled.details).toMatchObject({ outcome: "cancelled", persistenceClass: "derived-local-policy" });
    expect(runtime.sourcePolicyCalls).toBe(0);

    now += 15 * 60 * 1_000 + 1;
    const expired = await tool.execute("call-source-expired", {
      action: "memory_source_exclude",
      id: target.sourceRef,
      targetRevision: target.targetRevision,
    }, undefined, undefined, accepted);
    expect(expired.details).toMatchObject({ outcome: "rejected", errorCode: "source-not-found" });
    expect(runtime.sourcePolicyCalls).toBe(0);
  });

  it("rejects exclusion of the active session as a project source", async () => {
    const runtime = new FakeRuntime();
    runtime.sources = [source({ sessionId: "session-a" })];
    let confirmations = 0;
    const tool = createContextPersistenceTool(runtime, {
      processSecret: new Uint8Array(32).fill(20),
      randomBytes: (size) => new Uint8Array(size).fill(10),
    });
    const ctx = context({
      hasUI: true,
      confirm: async () => {
        confirmations += 1;
        return true;
      },
    });
    const listed = await tool.execute("call-active-source-list", {
      action: "memory_sources",
    }, undefined, undefined, ctx);
    const target = listed.details.items?.[0];
    if (!target || target.kind !== "project-memory-source") throw new Error("Expected source target");
    const result = await tool.execute("call-active-source-exclude", {
      action: "memory_source_exclude",
      id: target.sourceRef,
      targetRevision: target.targetRevision,
    }, undefined, undefined, ctx);
    expect(result.details).toMatchObject({ outcome: "rejected", errorCode: "source-not-excludable" });
    expect(confirmations).toBe(0);
    expect(runtime.sourcePolicyCalls).toBe(0);
  });

  it("recognizes a derived source-policy commit even when post-update sync throws", async () => {
    const runtime = new FakeRuntime();
    const tool = createContextPersistenceTool(runtime, {
      processSecret: new Uint8Array(32).fill(19),
      randomBytes: (size) => new Uint8Array(size).fill(9),
    });
    const ctx = context({ hasUI: true, confirm: async () => true });
    const listed = await tool.execute("call-sources", {
      action: "memory_sources",
    }, undefined, undefined, ctx);
    const target = listed.details.items?.[0];
    if (!target || target.kind !== "project-memory-source") throw new Error("Expected source target");
    runtime.sourcePolicyThrowAfterUpdate = true;
    const result = await tool.execute("call-source-post-update-failure", {
      action: "memory_source_exclude",
      id: target.sourceRef,
      targetRevision: target.targetRevision,
    }, undefined, undefined, ctx);
    expect(result.details).toMatchObject({
      outcome: "committed",
      persistenceClass: "derived-local-policy",
      status: "excluded",
    });
    expect(JSON.stringify(result)).not.toContain("private source sync error");
  });

  it("applies provider-aware secret protection even when general privacy is disabled", () => {
    const runtime = new Ds4ContextRuntime({ agentDir: "/tmp", configDirName: ".pi" });
    const remote = runtime.contextPersistenceSanitizeText(
      "api_key=supersecretvalue",
      "normal",
      "unknown-remote",
    );
    expect(remote).toMatchObject({ classification: "sensitive", allowed: false });
    expect(remote.value).toBe("");

    const local = runtime.contextPersistenceSanitizeText(
      "api_key=supersecretvalue",
      "normal",
      "faux",
    );
    expect(local).toMatchObject({ classification: "sensitive", allowed: true });
    expect(local.value).toContain("[DS4 REDACTED SECRET]");
    expect(local.value).not.toContain("supersecretvalue");

    const inherited = runtime.contextPersistenceMutationPolicy(
      "replacement",
      "normal",
      "sensitive",
      "unknown-remote",
    );
    expect(inherited).toMatchObject({
      classification: "sensitive",
      storedClassification: "sensitive",
      allowed: false,
    });
    const marked = runtime.contextPersistenceMutationPolicy(
      "[ds4:local-only]local[/ds4:local-only]",
      undefined,
      undefined,
      "unknown-remote",
    );
    expect(marked).toMatchObject({
      classification: "local-only",
      markerDetected: true,
      allowed: false,
    });
  });

  it("denies local-only writes to remote providers and permits confirmed marker elevation locally", async () => {
    const runtime = new FakeRuntime();
    let confirmations = 0;
    let appends = 0;
    const tool = createContextPersistenceTool(runtime, {
      appendEntry: () => { appends += 1; },
    });
    const ctx = context({
      hasUI: true,
      confirm: async () => {
        confirmations += 1;
        return true;
      },
    });
    const denied = await tool.execute("call-local-only-remote", {
      action: "pin_add",
      content: "Provider-private constraint",
      classification: "local-only",
    }, undefined, undefined, ctx);
    expect(denied.details).toMatchObject({
      outcome: "rejected",
      errorCode: "provider-policy-denied",
    });
    expect(confirmations).toBe(0);
    expect(appends).toBe(0);

    runtime.state.provider = "faux";
    const local = await tool.execute("call-local-only-local", {
      action: "pin_add",
      content: "[ds4:local-only]Local constraint[/ds4:local-only]",
    }, undefined, undefined, ctx);
    expect(local.details).toMatchObject({
      outcome: "committed",
      classification: "local-only",
    });
    expect(confirmations).toBe(1);
    expect(appends).toBe(1);
    expect(runtime.pins.at(-1)?.classification).toBe("local-only");

    const driftingRuntime = new FakeRuntime();
    driftingRuntime.state.provider = "faux";
    let driftingAppends = 0;
    const driftingTool = createContextPersistenceTool(driftingRuntime, {
      appendEntry: () => { driftingAppends += 1; },
    });
    const drifted = await driftingTool.execute("call-provider-drift", {
      action: "memory_add",
      content: "[ds4:local-only]Local decision[/ds4:local-only]",
    }, undefined, undefined, context({
      hasUI: true,
      confirm: async () => {
        driftingRuntime.state.provider = "remote-provider";
        return true;
      },
    }));
    expect(drifted.details).toMatchObject({ outcome: "rejected", errorCode: "provider-policy-denied" });
    expect(driftingAppends).toBe(0);
  });

  it("confirms a Pin add locally and returns only committed metadata", async () => {
    const runtime = new FakeRuntime();
    let appends = 0;
    let confirmation = "";
    const tool = createContextPersistenceTool(runtime, {
      processSecret: new Uint8Array(32).fill(10),
      appendEntry: () => { appends += 1; },
    });
    const result = await tool.execute("call-pin-add", {
      action: "pin_add",
      content: "Persist SECRET-PIN-CONTENT",
      scope: "session",
    }, undefined, undefined, context({
      hasUI: true,
      confirm: async (title, message) => {
        expect(title).toBe("DS4 Context Persistence");
        confirmation = message;
        return true;
      },
    }));
    const serialized = JSON.stringify(result);
    expect(confirmation).toContain("Persist SECRET-PIN-CONTENT");
    expect(appends).toBe(1);
    expect(runtime.mutationCalls).toBe(1);
    expect(result.details).toMatchObject({
      action: "pin_add",
      outcome: "committed",
      persistenceClass: "canonical-jsonl",
      kind: "pin",
      status: "active",
      classification: "sensitive",
    });
    expect(serialized).not.toContain("SECRET-PIN-CONTENT");
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(/^Committed pin pin-created-/u) });
  });

  it("keeps duplicate adds idempotent and rejects untrusted or oversized adds before confirmation", async () => {
    const runtime = new FakeRuntime();
    let appends = 0;
    let confirmations = 0;
    const tool = createContextPersistenceTool(runtime, {
      appendEntry: () => { appends += 1; },
    });
    const duplicate = await tool.execute("call-duplicate", {
      action: "pin_add",
      content: runtime.pins[0]?.content ?? "",
    }, undefined, undefined, context({
      hasUI: true,
      confirm: async () => {
        confirmations += 1;
        return true;
      },
    }));
    expect(duplicate.details).toMatchObject({
      outcome: "ok",
      duplicate: true,
      id: "pin-a",
      kind: "pin",
    });
    expect(appends).toBe(0);

    runtime.state.projectTrusted = false;
    const untrusted = await tool.execute("call-untrusted", {
      action: "pin_add",
      content: "Project constraint",
      scope: "project",
    }, undefined, undefined, context({
      hasUI: true,
      confirm: async () => {
        confirmations += 1;
        return true;
      },
    }));
    expect(untrusted.details).toMatchObject({ outcome: "rejected", errorCode: "project-untrusted" });

    runtime.state.projectTrusted = true;
    const trustDrift = await tool.execute("call-trust-drift", {
      action: "pin_add",
      content: "Project constraint after trust drift",
      scope: "project",
    }, undefined, undefined, context({
      hasUI: true,
      confirm: async () => {
        confirmations += 1;
        runtime.state.projectTrusted = false;
        return true;
      },
    }));
    expect(trustDrift.details).toMatchObject({ outcome: "rejected", errorCode: "project-untrusted" });

    runtime.state.maxPinChars = 3;
    const oversized = await tool.execute("call-oversized", {
      action: "pin_add",
      content: "four",
    }, undefined, undefined, context({
      hasUI: true,
      confirm: async () => {
        confirmations += 1;
        return true;
      },
    }));
    expect(oversized.details).toMatchObject({ outcome: "rejected", errorCode: "content-too-long" });
    expect(confirmations).toBe(2);
    expect(appends).toBe(0);
  });

  it("rejects classification downgrade, preserves target classification, and requires the exact revision", async () => {
    const runtime = new FakeRuntime();
    runtime.pins = [pin({ classification: "sensitive" })];
    let appends = 0;
    const tool = createContextPersistenceTool(runtime, {
      processSecret: new Uint8Array(32).fill(11),
      appendEntry: () => { appends += 1; },
    });
    const base = context({ hasUI: true, confirm: async () => true });
    let branch = base.sessionManager.getBranch();
    const progressing = {
      ...base,
      sessionManager: {
        ...base.sessionManager,
        getLeafId: () => branch.at(-1)?.id ?? null,
        getBranch: () => branch,
      },
    } as ExtensionContext;
    const read = await tool.execute("call-pin-list", {
      action: "pins_list",
    }, undefined, undefined, progressing);
    branch = [
      ...branch,
      { id: "read-result", type: "message", parentId: branch.at(-1)?.id ?? null, timestamp: "2026-01-01T00:00:02.000Z", message: { role: "toolResult", toolCallId: "call-pin-list", toolName: "context_persistence", content: [] } },
      { id: "supersede-call", type: "message", parentId: "read-result", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "assistant", content: [] } },
    ] as ReturnType<typeof base.sessionManager.getBranch>;
    const target = read.details.items?.[0];
    if (!target || target.kind !== "pin") throw new Error("Expected Pin target");

    const stale = await tool.execute("call-stale", {
      action: "pin_supersede",
      id: target.id,
      targetRevision: "rev_stale",
      content: "Replacement",
    }, undefined, undefined, progressing);
    expect(stale.details).toMatchObject({ outcome: "rejected", errorCode: "stale-target" });
    expect(appends).toBe(0);

    const downgrade = await tool.execute("call-supersede-downgrade", {
      action: "pin_supersede",
      id: target.id,
      targetRevision: target.targetRevision,
      content: "Replacement",
      classification: "normal",
    }, undefined, undefined, progressing);
    expect(downgrade.details).toMatchObject({ outcome: "rejected", errorCode: "invalid-classification" });
    expect(appends).toBe(0);

    const committed = await tool.execute("call-supersede", {
      action: "pin_supersede",
      id: target.id,
      targetRevision: target.targetRevision,
      content: "Replacement",
    }, undefined, undefined, progressing);
    expect(committed.details).toMatchObject({
      outcome: "committed",
      classification: "sensitive",
      scope: "session",
    });
    expect(appends).toBe(1);
  });

  it("rejects a target changed concurrently while local confirmation is open", async () => {
    const runtime = new FakeRuntime();
    let appends = 0;
    const tool = createContextPersistenceTool(runtime, {
      processSecret: new Uint8Array(32).fill(21),
      appendEntry: () => { appends += 1; },
    });
    const listed = await tool.execute("call-pin-list", {
      action: "pins_list",
    }, undefined, undefined, context());
    const target = listed.details.items?.[0];
    if (!target || target.kind !== "pin") throw new Error("Expected Pin target");
    const result = await tool.execute("call-pin-concurrent-unpin", {
      action: "pin_unpin",
      id: target.id,
      targetRevision: target.targetRevision,
    }, undefined, undefined, context({
      hasUI: true,
      confirm: async () => {
        const item = runtime.pins.find((candidate) => candidate.id === target.id);
        if (item) item.updatedAt += 1;
        return true;
      },
    }));
    expect(result.details).toMatchObject({ outcome: "rejected", errorCode: "stale-target" });
    expect(appends).toBe(0);
  });

  it("rejects secret-like unpin reasons and commits an exact confirmed unpin", async () => {
    const runtime = new FakeRuntime();
    let appends = 0;
    let confirmation = "";
    const tool = createContextPersistenceTool(runtime, {
      processSecret: new Uint8Array(32).fill(12),
      appendEntry: () => { appends += 1; },
    });
    const read = await tool.execute("call-pin-list", {
      action: "pins_list",
    }, undefined, undefined, context());
    const target = read.details.items?.[0];
    if (!target || target.kind !== "pin") throw new Error("Expected Pin target");
    const rejected = await tool.execute("call-unpin-secret", {
      action: "pin_unpin",
      id: target.id,
      targetRevision: target.targetRevision,
      reason: "api_key=TOP-SECRET-REASON",
    }, undefined, undefined, context({ hasUI: true, confirm: async () => true }));
    expect(rejected.details).toMatchObject({ outcome: "rejected", errorCode: "secret-in-reason" });
    expect(appends).toBe(0);

    const committed = await tool.execute("call-unpin", {
      action: "pin_unpin",
      id: target.id,
      targetRevision: target.targetRevision,
      reason: "constraint completed",
    }, undefined, undefined, context({
      hasUI: true,
      confirm: async (_title, message) => {
        confirmation = message;
        return true;
      },
    }));
    expect(confirmation).toContain("Never expose pin body SECRET-PIN");
    expect(committed.details).toMatchObject({ outcome: "committed", status: "deleted" });
    expect(JSON.stringify(committed)).not.toContain("constraint completed");
    expect(JSON.stringify(committed)).not.toContain("SECRET-PIN");
    expect(appends).toBe(1);
  });

  it("does not append after cancellation, abort, or provenance drift", async () => {
    const runtime = new FakeRuntime();
    let appends = 0;
    const tool = createContextPersistenceTool(runtime, {
      appendEntry: () => { appends += 1; },
    });
    const cancelled = await tool.execute("call-cancel", {
      action: "pin_add",
      content: "Cancelled content",
    }, undefined, undefined, context({ hasUI: true, confirm: async () => false }));
    expect(cancelled.details.outcome).toBe("cancelled");

    const closed = await tool.execute("call-dialog-closed", {
      action: "pin_add",
      content: "Closed dialog content",
    }, undefined, undefined, context({
      hasUI: true,
      confirm: async () => { throw new Error("private dialog failure"); },
    }));
    expect(closed.details.outcome).toBe("cancelled");
    expect(JSON.stringify(closed)).not.toContain("private dialog failure");

    let preAbortConfirmations = 0;
    const preAbortedController = new AbortController();
    preAbortedController.abort();
    const preAborted = await tool.execute("call-pre-abort", {
      action: "pin_add",
      content: "Pre-aborted content",
    }, preAbortedController.signal, undefined, context({
      hasUI: true,
      confirm: async () => {
        preAbortConfirmations += 1;
        return true;
      },
    }));
    expect(preAborted.details).toMatchObject({
      outcome: "cancelled",
      errorCode: "aborted",
      persistenceClass: "canonical-jsonl",
    });
    expect(preAbortConfirmations).toBe(0);

    runtime.provenanceValid = false;
    const drifted = await tool.execute("call-drift", {
      action: "pin_add",
      content: "Drifted content",
    }, undefined, undefined, context({ hasUI: true, confirm: async () => true }));
    expect(drifted.details).toMatchObject({ outcome: "rejected", errorCode: "provenance-unavailable" });

    runtime.provenanceValid = true;
    const controller = new AbortController();
    const aborted = await tool.execute("call-abort", {
      action: "pin_add",
      content: "Aborted content",
    }, controller.signal, undefined, context({
      hasUI: true,
      confirm: async () => {
        controller.abort();
        return true;
      },
    }));
    expect(aborted.details).toMatchObject({ outcome: "cancelled", errorCode: "aborted" });
    expect(appends).toBe(0);
    expect(runtime.mutationCalls).toBe(0);
  });

  it("rejects a cancelled call's sanitized placeholder retry before confirmation or append", async () => {
    const runtime = new FakeRuntime();
    let appends = 0;
    let confirmations = 0;
    let accept = false;
    const tool = createContextPersistenceTool(runtime, {
      appendEntry: () => { appends += 1; },
    });
    const ctx = context({
      hasUI: true,
      confirm: async () => {
        confirmations += 1;
        return accept;
      },
    });
    const cancelled = await tool.execute("call-cancelled-original", {
      action: "memory_add",
      content: "Original durable claim",
      key: "durable.key",
    }, undefined, undefined, ctx);
    expect(cancelled.details.outcome).toBe("cancelled");

    const sanitizedCall = sanitizeContextPersistenceHistory({
      id: "call-cancelled-original",
      name: "context_persistence",
      arguments: {
        action: "memory_add",
        content: "Original durable claim",
        key: "durable.key",
      },
    }).value as {
      arguments: { action: "memory_add"; content: string; key: string };
    };
    expect(sanitizedCall.arguments).toMatchObject({
      content: CONTEXT_PERSISTENCE_EGRESS_SENTINEL,
      key: CONTEXT_PERSISTENCE_EGRESS_SENTINEL,
    });

    accept = true;
    const retry = await tool.execute(
      "call-placeholder-retry",
      sanitizedCall.arguments,
      undefined,
      undefined,
      ctx,
    );
    expect(retry.details).toMatchObject({
      outcome: "rejected",
      errorCode: "egress-placeholder",
      persistenceClass: "canonical-jsonl",
    });
    expect(confirmations).toBe(1);
    expect(appends).toBe(0);
    expect(runtime.mutationCalls).toBe(0);
  });

  it("distinguishes indeterminate append from committed projection failure", async () => {
    const indeterminateRuntime = new FakeRuntime();
    const indeterminateTool = createContextPersistenceTool(indeterminateRuntime, {
      appendEntry: () => { throw new Error("private append error"); },
    });
    const indeterminate = await indeterminateTool.execute("call-indeterminate", {
      action: "pin_add",
      content: "Append maybe",
    }, undefined, undefined, context({ hasUI: true, confirm: async () => true }));
    expect(indeterminate.details).toMatchObject({
      outcome: "indeterminate",
      errorCode: "append-indeterminate",
      kind: "pin",
    });
    expect(JSON.stringify(indeterminate)).not.toContain("private append error");

    const pendingRuntime = new FakeRuntime();
    pendingRuntime.throwAfterAppend = true;
    const pendingTool = createContextPersistenceTool(pendingRuntime, { appendEntry: () => {} });
    const pending = await pendingTool.execute("call-pending", {
      action: "pin_add",
      content: "Projection fails",
    }, undefined, undefined, context({ hasUI: true, confirm: async () => true }));
    expect(pending.details).toMatchObject({
      outcome: "committed_projection_pending",
      errorCode: "committed-projection-pending",
      kind: "pin",
    });
    expect(JSON.stringify(pending)).not.toContain("private projection error");

    const resultFailureRuntime = new FakeRuntime();
    resultFailureRuntime.throwStateAfterMutation = true;
    const resultFailureTool = createContextPersistenceTool(resultFailureRuntime, { appendEntry: () => {} });
    const resultFailure = await resultFailureTool.execute("call-post-materialization-failure", {
      action: "pin_add",
      content: "Result construction fails after materialization",
    }, undefined, undefined, context({ hasUI: true, confirm: async () => true }));
    expect(resultFailure.details).toMatchObject({
      outcome: "committed_projection_pending",
      errorCode: "committed-projection-pending",
      kind: "pin",
    });
    expect(JSON.stringify(resultFailure)).not.toContain("private post-materialization state error");
  });

  it("converts pre-append and unavailable runtime failures without leaking error details", async () => {
    const runtime = new FakeRuntime();
    runtime.throwBeforeAppend = true;
    let appends = 0;
    const tool = createContextPersistenceTool(runtime, { appendEntry: () => { appends += 1; } });
    const failed = await tool.execute("call-pre-append-failure", {
      action: "pin_add",
      content: "Runtime fails before append",
    }, undefined, undefined, context({ hasUI: true, confirm: async () => true }));
    expect(failed.details).toMatchObject({
      outcome: "unavailable",
      errorCode: "runtime-unavailable",
      persistenceClass: "canonical-jsonl",
    });
    expect(JSON.stringify(failed)).not.toContain("private pre-append error");
    expect(appends).toBe(0);

    runtime.state.available = false;
    runtime.state.errorCode = "memory-unavailable";
    const unavailable = await tool.execute("call-runtime-unavailable", {
      action: "memory_list",
    }, undefined, undefined, context());
    expect(unavailable.details).toMatchObject({
      outcome: "unavailable",
      errorCode: "memory-unavailable",
      persistenceClass: "read-only",
    });

    let unavailableConfirmations = 0;
    const unavailableWrite = await tool.execute("call-runtime-unavailable-write", {
      action: "pin_add",
      content: "Must not reach confirmation",
    }, undefined, undefined, context({
      hasUI: true,
      confirm: async () => {
        unavailableConfirmations += 1;
        return true;
      },
    }));
    expect(unavailableWrite.details).toMatchObject({
      outcome: "unavailable",
      errorCode: "memory-unavailable",
      persistenceClass: "canonical-jsonl",
    });
    expect(unavailableConfirmations).toBe(0);
  });

  it("adds session and project Memory with bounded confirmed content and idempotent duplicates", async () => {
    const runtime = new FakeRuntime();
    runtime.memories = [];
    let appends = 0;
    const appendedTypes: string[] = [];
    const confirmations: string[] = [];
    const tool = createContextPersistenceTool(runtime, {
      processSecret: new Uint8Array(32).fill(13),
      appendEntry: (customType) => {
        appends += 1;
        appendedTypes.push(customType);
      },
    });
    const ctx = context({
      hasUI: true,
      confirm: async (_title, message) => {
        confirmations.push(message);
        return true;
      },
    });
    const added = await tool.execute("call-memory-add", {
      action: "memory_add",
      content: "Durable choice SECRET-VALUE",
      key: "architecture.default",
    }, undefined, undefined, ctx);
    expect(added.details).toMatchObject({
      outcome: "committed",
      persistenceClass: "canonical-jsonl",
      kind: "memory",
      scope: "session",
      status: "active",
      classification: "sensitive",
    });
    expect(added.details.targetRevision).toMatch(/^rev_/u);
    expect(confirmations[0]).toContain("Durable choice SECRET-VALUE");
    expect(confirmations[0]).toContain("Key: architecture.default");
    expect(JSON.stringify(added)).not.toContain("Durable choice");
    expect(JSON.stringify(added)).not.toContain("architecture.default");
    expect(appendedTypes).toEqual(["ds4-context-memory-v1"]);

    const duplicate = await tool.execute("call-memory-duplicate", {
      action: "memory_add",
      content: "Durable choice SECRET-VALUE",
      key: "architecture.default",
    }, undefined, undefined, ctx);
    expect(duplicate.details).toMatchObject({ outcome: "ok", duplicate: true, kind: "memory" });
    expect(appends).toBe(1);

    const project = await tool.execute("call-memory-project", {
      action: "memory_add",
      content: "Project-wide durable choice",
      scope: "project",
    }, undefined, undefined, ctx);
    expect(project.details).toMatchObject({ outcome: "committed", scope: "project", kind: "memory" });
    expect(appends).toBe(2);
  });

  it("rejects Memory conflicts, untrusted projects, and configured claim limits before append", async () => {
    const runtime = new FakeRuntime();
    let confirmations = 0;
    let appends = 0;
    const tool = createContextPersistenceTool(runtime, {
      appendEntry: () => { appends += 1; },
    });
    const ctx = context({
      hasUI: true,
      confirm: async () => {
        confirmations += 1;
        return true;
      },
    });

    runtime.state.projectTrusted = false;
    const untrusted = await tool.execute("call-memory-untrusted", {
      action: "memory_add",
      content: "Project fact",
      scope: "project",
    }, undefined, undefined, ctx);
    expect(untrusted.details).toMatchObject({ outcome: "rejected", errorCode: "project-untrusted" });

    runtime.state.projectTrusted = true;
    runtime.state.maxClaimChars = 3;
    const oversized = await tool.execute("call-memory-long", {
      action: "memory_add",
      content: "four",
    }, undefined, undefined, ctx);
    expect(oversized.details).toMatchObject({ outcome: "rejected", errorCode: "claim-too-long" });
    expect(confirmations).toBe(0);

    runtime.state.maxClaimChars = 2_000;
    runtime.memoryConflict = true;
    const conflict = await tool.execute("call-memory-conflict", {
      action: "memory_add",
      content: "Conflicting fact",
    }, undefined, undefined, ctx);
    expect(conflict.details).toMatchObject({ outcome: "rejected", errorCode: "duplicate-conflict" });
    expect(JSON.stringify(conflict)).not.toContain("private-conflict-id");
    expect(confirmations).toBe(1);
    expect(appends).toBe(0);
  });

  it("supersedes exact Memory without lowering or unnecessarily materializing classification", async () => {
    const runtime = new FakeRuntime();
    runtime.state.defaultClassification = "sensitive";
    runtime.memories = [memory({ classification: undefined, key: "private-key" })];
    let appends = 0;
    let confirmation = "";
    const tool = createContextPersistenceTool(runtime, {
      processSecret: new Uint8Array(32).fill(14),
      appendEntry: () => { appends += 1; },
    });
    const ctx = context({
      hasUI: true,
      confirm: async (_title, message) => {
        confirmation = message;
        return true;
      },
    });
    const listed = await tool.execute("call-memory-list", {
      action: "memory_list",
    }, undefined, undefined, ctx);
    const target = listed.details.items?.[0];
    if (!target || target.kind !== "memory") throw new Error("Expected Memory target");

    const stale = await tool.execute("call-memory-stale", {
      action: "memory_supersede",
      id: target.id,
      targetRevision: "rev_stale",
      content: "Replacement fact",
    }, undefined, undefined, ctx);
    expect(stale.details).toMatchObject({ outcome: "rejected", errorCode: "stale-target" });

    const downgrade = await tool.execute("call-memory-downgrade", {
      action: "memory_supersede",
      id: target.id,
      targetRevision: target.targetRevision,
      content: "Replacement fact",
      classification: "normal",
    }, undefined, undefined, ctx);
    expect(downgrade.details).toMatchObject({ outcome: "rejected", errorCode: "invalid-classification" });

    const committed = await tool.execute("call-memory-supersede", {
      action: "memory_supersede",
      id: target.id,
      targetRevision: target.targetRevision,
      content: "Replacement fact",
    }, undefined, undefined, ctx);
    expect(committed.details).toMatchObject({
      outcome: "committed",
      kind: "memory",
      scope: "session",
      status: "active",
      classification: "sensitive",
    });
    expect(runtime.memories.at(-1)?.classification).toBeUndefined();
    expect(confirmation).toContain("Replacement fact");
    expect(confirmation).toContain("Key: private-key");
    expect(JSON.stringify(committed)).not.toContain("Replacement fact");
    expect(JSON.stringify(committed)).not.toContain("private-key");
    expect(appends).toBe(1);
  });

  it.each([
    ["memory_invalidate", "invalid"],
    ["memory_expire", "expired"],
  ] as const)("commits exact confirmed %s status without echoing claim or reason", async (action, status) => {
    const runtime = new FakeRuntime();
    let appends = 0;
    let confirmation = "";
    const tool = createContextPersistenceTool(runtime, {
      processSecret: new Uint8Array(32).fill(status === "invalid" ? 15 : 16),
      appendEntry: () => { appends += 1; },
    });
    const ctx = context({
      hasUI: true,
      confirm: async (_title, message) => {
        confirmation = message;
        return true;
      },
    });
    const listed = await tool.execute("call-memory-list", {
      action: "memory_list",
    }, undefined, undefined, ctx);
    const target = listed.details.items?.[0];
    if (!target || target.kind !== "memory") throw new Error("Expected Memory target");

    const secretReason = await tool.execute("call-memory-secret-reason", {
      action,
      id: target.id,
      targetRevision: target.targetRevision,
      reason: "api_key=PRIVATE-VALUE",
    }, undefined, undefined, ctx);
    expect(secretReason.details).toMatchObject({ outcome: "rejected", errorCode: "secret-in-reason" });

    const committed = await tool.execute("call-memory-status", {
      action,
      id: target.id,
      targetRevision: target.targetRevision,
      reason: "User requested lifecycle change",
    }, undefined, undefined, ctx);
    expect(committed.details).toMatchObject({
      outcome: "committed",
      kind: "memory",
      status,
      classification: "normal",
    });
    expect(confirmation).toContain("PostgreSQL is the durable default SECRET-MEMORY");
    expect(confirmation).toContain("Reason: User requested lifecycle change");
    expect(JSON.stringify(committed)).not.toContain("PostgreSQL");
    expect(JSON.stringify(committed)).not.toContain("lifecycle change");
    expect(appends).toBe(1);
  });

  it("reports committed projection pending for a post-append Memory failure", async () => {
    const runtime = new FakeRuntime();
    runtime.throwAfterAppend = true;
    const tool = createContextPersistenceTool(runtime, { appendEntry: () => {} });
    const pending = await tool.execute("call-memory-pending", {
      action: "memory_add",
      content: "Projection fails after Memory append",
    }, undefined, undefined, context({ hasUI: true, confirm: async () => true }));
    expect(pending.details).toMatchObject({
      outcome: "committed_projection_pending",
      errorCode: "committed-projection-pending",
      kind: "memory",
      scope: "session",
    });
    expect(pending.details.targetRevision).toBeUndefined();
    expect(JSON.stringify(pending)).not.toContain("private projection error");
  });

  it("resolves primary provenance before the current tool call and detects branch drift", () => {
    const runtime = new Ds4ContextRuntime({ agentDir: "/tmp", configDirName: ".pi" });
    const branch = [
      { id: "user-primary", type: "message", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "persist this" } },
      { id: "assistant-call", type: "message", parentId: "user-primary", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call-current", name: "context_persistence", arguments: {} }] } },
      { id: "user-after", type: "message", parentId: "assistant-call", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "must not become provenance" } },
    ];
    let activeBranch = branch;
    const ctx = {
      ...context(),
      sessionManager: {
        getSessionId: () => "session-a",
        getLeafId: () => activeBranch.at(-1)?.id ?? null,
        getBranch: () => activeBranch,
      },
    } as unknown as ExtensionContext;
    const resolved = runtime.contextPersistenceResolveProvenance(ctx, "call-current");
    expect(resolved?.primarySourceEntryId).toBe("user-primary");
    expect(resolved && runtime.contextPersistenceValidateProvenance(ctx, resolved)).toBe(true);
    activeBranch = activeBranch.slice(0, -1);
    expect(resolved && runtime.contextPersistenceValidateProvenance(ctx, resolved)).toBe(false);
  });

  it("fails every write closed without UI before any mutation can reach the runtime", async () => {
    const runtime = new FakeRuntime();
    const tool = createContextPersistenceTool(runtime);
    const writes = [
      { action: "pin_add", content: "persist this" },
      { action: "pin_supersede", id: "pin-a", targetRevision: "rev_x", content: "replace" },
      { action: "pin_unpin", id: "pin-a", targetRevision: "rev_x" },
      { action: "memory_add", content: "persist this" },
      { action: "memory_supersede", id: "memory-a", targetRevision: "rev_x", content: "replace" },
      { action: "memory_invalidate", id: "memory-a", targetRevision: "rev_x" },
      { action: "memory_expire", id: "memory-a", targetRevision: "rev_x" },
      { action: "memory_source_exclude", id: "source_abcdefghijklmnopqrstuv", targetRevision: "rev_x" },
      { action: "memory_source_include", id: "source_abcdefghijklmnopqrstuv", targetRevision: "rev_x" },
    ] as const;
    for (const [index, params] of writes.entries()) {
      const result = await tool.execute(
        `call-write-${index}`,
        params,
        undefined,
        undefined,
        context(),
      );
      expect(result.details).toMatchObject({
        outcome: "unavailable",
        persistenceClass: params.action.startsWith("memory_source_")
          ? "derived-local-policy"
          : "canonical-jsonl",
        errorCode: "confirmation-required",
      });
    }
    expect(runtime.mutationCalls).toBe(0);
    expect(runtime.sourcePolicyCalls).toBe(0);
  });
});

describe("context_persistence historical egress", () => {
  it("sanitizes provider-specific call/result payload linkages", () => {
    const payload = {
      anthropic: [{
        type: "tool_use",
        id: "call-anthropic",
        name: "context_persistence",
        input: { action: "memory_find", query: "ANTHROPIC-SECRET" },
      }, {
        type: "tool_result",
        tool_use_id: "call-anthropic",
        content: "memory memory-a: ANTHROPIC-PREVIEW",
      }],
      google: [{
        functionCall: {
          id: "call-google",
          name: "context_persistence",
          args: { action: "pins_find", query: "GOOGLE-SECRET" },
        },
      }, {
        functionResponse: {
          id: "call-google",
          name: "context_persistence",
          response: { output: "pin pin-a: GOOGLE-PREVIEW" },
        },
      }],
    };
    const serialized = JSON.stringify(sanitizeContextPersistenceHistory(payload).value);
    for (const secret of ["ANTHROPIC-SECRET", "ANTHROPIC-PREVIEW", "GOOGLE-SECRET", "GOOGLE-PREVIEW"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("preview omitted by policy");
  });

  it("rebuilds historical mutation output from allowlisted metadata only", () => {
    const history = [{
      role: "toolResult",
      toolCallId: "call-pin-add",
      toolName: "context_persistence",
      content: [{ type: "text", text: "Committed pin pin-created: RAW-CONTENT" }],
      details: {
        schema: "ds4-context-persistence-result-v1",
        action: "pin_add",
        outcome: "committed",
        persistenceClass: "canonical-jsonl",
        id: "pin-created",
        kind: "pin",
        scope: "session",
        status: "active",
        classification: "sensitive",
        targetRevision: "rev_abcdefghijklmnopqrstuv",
        forbiddenReason: "RAW-REASON",
      },
    }];
    const serialized = JSON.stringify(sanitizeContextPersistenceHistory(history).value);
    expect(serialized).toContain("Committed pin pin-created.");
    expect(serialized).toContain("rev_abcdefghijklmnopqrstuv");
    expect(serialized).not.toContain("RAW-CONTENT");
    expect(serialized).not.toContain("RAW-REASON");
  });

  it("removes current and historical sensitive arguments and provider-visible previews", () => {
    const history = [{
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "call-persistence",
        name: "context_persistence",
        arguments: {
          action: "memory_find",
          query: "TOP-SECRET-QUERY",
          key: "TOP-SECRET-KEY",
          reason: "TOP-SECRET-REASON",
          content: "TOP-SECRET-CONTENT",
          id: "/private/item-id",
          targetRevision: "/private/revision",
        },
      }],
    }, {
      role: "toolResult",
      toolCallId: "call-persistence",
      toolName: "context_persistence",
      content: [{ type: "text", text: "memory_find: 1 match(es); truncated=false; incomplete=false.\nmemory memory-a; scope=session; status=active; classification=normal; createdAt=100; updatedAt=200; revision=rev_abcdefghijklmnopqrstuv; match=exact-phrase; score=90\nmemory memory-a: TOP-SECRET-PREVIEW" }],
      details: {
        schema: "ds4-context-persistence-result-v1",
        action: "memory_find",
        outcome: "ok",
        persistenceClass: "read-only",
        count: 1,
        truncated: false,
        incomplete: false,
        items: [{
          id: "memory-a",
          kind: "memory",
          scope: "session",
          status: "active",
          classification: "normal",
          createdAt: 100,
          updatedAt: 200,
          targetRevision: "rev_abcdefghijklmnopqrstuv",
          matchKind: "exact-phrase",
          score: 90,
          previewStatus: "included",
          forbiddenPath: "/private/path",
        }],
        forbiddenError: "raw error",
      },
    }];
    const sanitized = sanitizeContextPersistenceHistory(history);
    const serialized = JSON.stringify(sanitized.value);
    expect(sanitized.changed).toBe(true);
    for (const secret of ["TOP-SECRET-QUERY", "TOP-SECRET-KEY", "TOP-SECRET-REASON", "TOP-SECRET-CONTENT", "TOP-SECRET-PREVIEW", "/private/path", "/private/item-id", "/private/revision", "raw error"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain(CONTEXT_PERSISTENCE_EGRESS_SENTINEL);
    expect(serialized).toContain("memory-a");
    expect(serialized).toContain("preview omitted by policy");
  });
});
