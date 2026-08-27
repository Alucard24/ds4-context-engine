import { createHmac, randomBytes } from "node:crypto";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { MemoryConflictError } from "ds4-context-core/memory/memory-manager";
import {
  MEMORY_CUSTOM_ENTRY_TYPE,
  PIN_CUSTOM_ENTRY_TYPE,
  type MemoryItem,
  type PinItem,
  type ProjectMemorySource,
} from "ds4-context-core/memory/memory-types";
import type { PrivacyClassification } from "ds4-context-core/privacy/privacy-policy";
import { stableStringify } from "ds4-context-core/shared/stable-json";
import {
  CONTEXT_PERSISTENCE_DESCRIPTION,
  CONTEXT_PERSISTENCE_PARAMS,
  CONTEXT_PERSISTENCE_PROMPT_GUIDELINES,
  CONTEXT_PERSISTENCE_PROMPT_SNIPPET,
  CONTEXT_PERSISTENCE_TOOL_NAME,
  isReadAction,
  validateContextPersistenceParams,
  type ContextPersistenceAction,
  type ContextPersistenceParams,
} from "./context-persistence-contract.ts";
import {
  buildFailureResult,
  buildMutationResult,
  buildReadResult,
  type ContextPersistenceDetails,
  type ContextPersistenceReadItem,
  type MatchKind,
  type MemoryReadItem,
  type PinReadItem,
  type SourceReadItem,
} from "./context-persistence-result.ts";

const FIND_PAGE_SIZE = 128;
const FIND_SCAN_CAP = 4_096;
const BODY_CEILING = 20_000;
const PREVIEW_SCALARS = 160;
const SOURCE_REF_TTL_MS = 15 * 60 * 1_000;
const SOURCE_REF_CAP = 1_024;
const REVISION_TTL_MS = 15 * 60 * 1_000;
const REVISION_CAP = 4_096;
const SAFE_ITEM_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

export interface ContextPersistenceRuntimeState {
  available: boolean;
  errorCode?: "memory-unavailable" | "runtime-unavailable";
  phase: string;
  sessionId: string;
  projectIdentity: string;
  projectTrusted: boolean;
  crossSessionEnabled: boolean;
  crossSessionReady: boolean;
  defaultClassification: PrivacyClassification;
  maxResults: number;
  maxPinChars: number;
  maxClaimChars: number;
  provider: string;
}

export interface ContextPersistenceSanitization {
  value: string;
  classification: PrivacyClassification;
  allowed: boolean;
}

export interface ContextPersistenceMutationPolicy {
  classification: PrivacyClassification;
  storedClassification?: PrivacyClassification;
  allowed: boolean;
  secretDetected: boolean;
  markerDetected: boolean;
}

export interface ContextPersistenceProvenance {
  sessionId: string;
  leafId?: string;
  branchEntryIds: string[];
  primarySourceEntryId: string;
}

export type ContextPersistenceAppender = (customType: string, data: unknown) => void;

export interface ContextPersistenceOutcomeRecord {
  action: ContextPersistenceAction;
  outcome: ContextPersistenceDetails["outcome"];
  persistenceClass: ContextPersistenceDetails["persistenceClass"];
  scope?: "session" | "branch" | "project";
  itemId?: string;
  classification?: PrivacyClassification;
  resultCount?: number;
  duplicate?: boolean;
  errorCode?: string;
}

export interface ContextPersistencePage<T> {
  items: T[];
  hasMore: boolean;
}

export interface ContextPersistenceBoundedRead<T> {
  items: T[];
  incomplete: boolean;
  aborted: boolean;
}

export interface ContextPersistenceRuntimePort {
  contextPersistenceState(ctx: ExtensionContext): ContextPersistenceRuntimeState;
  contextPersistenceSanitizeText(
    text: string,
    classification: PrivacyClassification | undefined,
    provider: string,
  ): ContextPersistenceSanitization;
  contextPersistenceMutationPolicy(
    text: string,
    requested: PrivacyClassification | undefined,
    inherited: PrivacyClassification | undefined,
    provider: string,
  ): ContextPersistenceMutationPolicy;
  contextPersistenceResolveProvenance(
    ctx: ExtensionContext,
    toolCallId: string,
  ): ContextPersistenceProvenance | undefined;
  contextPersistenceValidateProvenance(
    ctx: ExtensionContext,
    provenance: ContextPersistenceProvenance,
  ): boolean;
  contextPersistenceResolvePin(id: string, activeOnly: boolean): PinItem | undefined;
  contextPersistenceResolveMemory(id: string, activeOnly: boolean): MemoryItem | undefined;
  contextPersistenceListPinsPage(
    ctx: ExtensionContext,
    activeOnly: boolean,
    limit: number,
  ): ContextPersistencePage<PinItem>;
  contextPersistenceListMemoriesPage(
    activeOnly: boolean,
    limit: number,
  ): ContextPersistencePage<MemoryItem>;
  contextPersistenceScanPins(
    activeOnly: boolean,
    pageSize: number,
    scanCap: number,
    signal?: AbortSignal,
  ): ContextPersistenceBoundedRead<PinItem>;
  contextPersistenceScanMemories(
    activeOnly: boolean,
    pageSize: number,
    scanCap: number,
    signal?: AbortSignal,
  ): ContextPersistenceBoundedRead<MemoryItem>;
  contextPersistenceProjectSourcesPage(
    limit: number,
  ): ContextPersistencePage<ProjectMemorySource>;
  contextPersistenceResolveProjectSource(sessionId: string): ProjectMemorySource | undefined;
  contextPersistenceSetProjectSourceExcluded(
    sessionId: string,
    excluded: boolean,
    reason?: string,
  ): ProjectMemorySource | undefined;
  contextPersistenceCreatePin(
    input: {
      content: string;
      scope: "session" | "branch" | "project";
      sourceEntryId: string;
      supersedes?: string;
      classification?: PrivacyClassification;
    },
    ctx: ExtensionContext,
    appendEntry: ContextPersistenceAppender,
  ): { pin: PinItem; duplicate: boolean };
  contextPersistenceUnpin(
    id: string,
    reason: string | undefined,
    ctx: ExtensionContext,
    appendEntry: ContextPersistenceAppender,
  ): PinItem;
  contextPersistenceCreateMemory(
    input: {
      claim: string;
      scope: "session" | "project";
      key?: string;
      classification?: PrivacyClassification;
      sourceEntryIds: string[];
    },
    ctx: ExtensionContext,
    appendEntry: ContextPersistenceAppender,
  ): { memory: MemoryItem; duplicate: boolean };
  contextPersistenceSupersedeMemory(
    id: string,
    claim: string,
    sourceEntryIds: string[],
    classification: PrivacyClassification | undefined,
    ctx: ExtensionContext,
    appendEntry: ContextPersistenceAppender,
  ): MemoryItem;
  contextPersistenceSetMemoryStatus(
    id: string,
    status: "invalid" | "expired",
    reason: string | undefined,
    ctx: ExtensionContext,
    appendEntry: ContextPersistenceAppender,
  ): MemoryItem;
  contextPersistenceRecordOutcome(record: ContextPersistenceOutcomeRecord): void;
}

export interface ContextPersistenceToolDependencies {
  now?: () => number;
  processSecret?: Uint8Array;
  randomBytes?: (size: number) => Uint8Array;
  appendEntry?: ContextPersistenceAppender;
}

interface SourceHandle {
  sourceRef: string;
  projectIdentity: string;
  sessionId: string;
  emittedAt: number;
  lastAccessAt: number;
}

interface BranchRevisionHandle {
  entryIds: string[];
  emittedAt: number;
}

interface TargetRevisionHandle {
  kind: "pin" | "memory";
  id: string;
  sessionId: string;
  projectIdentity: string;
  branchRevision: string;
  fingerprint: string;
  emittedAt: number;
}

interface SourceRevisionHandle {
  sourceRef: string;
  sourceSessionId: string;
  sessionId: string;
  projectIdentity: string;
  fingerprint: string;
  emittedAt: number;
}

interface ScoredPin {
  item: PinItem;
  applicable: boolean;
  matchKind: MatchKind;
  score: number;
  preview?: string;
  previewStatus: "included" | "omitted-by-policy";
}

interface ScoredMemory {
  item: MemoryItem;
  matchKind: MatchKind;
  score: number;
  preview?: string;
  previewStatus: "included" | "omitted-by-policy";
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeSearch(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function terms(value: string): string[] {
  return value.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function classification(
  stored: PrivacyClassification | undefined,
  state: ContextPersistenceRuntimeState,
): PrivacyClassification {
  return stored ?? state.defaultClassification;
}

const CLASSIFICATION_RANK: Record<PrivacyClassification, number> = {
  normal: 0,
  internal: 1,
  sensitive: 2,
  "local-only": 3,
};

function classificationDowngrade(
  requested: PrivacyClassification | undefined,
  inherited: PrivacyClassification,
): boolean {
  return requested !== undefined
    && CLASSIFICATION_RANK[requested] < CLASSIFICATION_RANK[inherited];
}

function replacementStoredClassification(
  requested: PrivacyClassification | undefined,
  inheritedStored: PrivacyClassification | undefined,
  inheritedEffective: PrivacyClassification,
  policy: ContextPersistenceMutationPolicy,
): PrivacyClassification | undefined {
  if (CLASSIFICATION_RANK[policy.classification] > CLASSIFICATION_RANK[inheritedEffective]) {
    return policy.classification;
  }
  return requested === undefined ? inheritedStored : policy.classification;
}

function activeFirst(status: string): number {
  return status === "active" ? 0 : 1;
}

function pinApplicable(item: PinItem, branchIds: ReadonlySet<string>): boolean {
  return item.scope !== "branch" || (Boolean(item.branchLeafId) && branchIds.has(item.branchLeafId ?? ""));
}

function scoredPinOrder(left: ScoredPin, right: ScoredPin): number {
  return right.score - left.score
    || activeFirst(left.item.status) - activeFirst(right.item.status)
    || Number(right.applicable) - Number(left.applicable)
    || right.item.updatedAt - left.item.updatedAt
    || compareAscii(left.item.id, right.item.id);
}

function scoredMemoryOrder(left: ScoredMemory, right: ScoredMemory): number {
  return right.score - left.score
    || activeFirst(left.item.status) - activeFirst(right.item.status)
    || right.item.updatedAt - left.item.updatedAt
    || compareAscii(left.item.id, right.item.id);
}

function matchText(
  query: string,
  queryTerms: readonly string[],
  body: string,
  key?: string,
): { matchKind: MatchKind; baseScore: number } | undefined {
  if (key && normalizeSearch(key) === query) return { matchKind: "exact-key", baseScore: 100 };
  const normalizedBody = normalizeSearch(body);
  if (normalizedBody.includes(query)) return { matchKind: "exact-phrase", baseScore: 80 };
  const bodyTerms = new Set(terms(normalizedBody));
  if (queryTerms.length > 0 && queryTerms.every((term) => bodyTerms.has(term))) {
    return { matchKind: "all-terms", baseScore: 60 };
  }
  if (queryTerms.some((term) => bodyTerms.has(term))) {
    return { matchKind: "partial-terms", baseScore: 30 };
  }
  return undefined;
}

function opaqueId(value: string): boolean {
  return SAFE_ITEM_ID.test(value);
}

type CanonicalCommitState = "not-invoked" | "invoking" | "committed" | "materialized";

class TrackedCanonicalAppender {
  state: CanonicalCommitState = "not-invoked";
  itemId?: string;
  mutationType?: "pin" | "memory";

  constructor(private readonly appendEntry: ContextPersistenceAppender) {}

  append = (customType: string, data: unknown): void => {
    if (this.state !== "not-invoked") throw new Error("context_persistence append invariant failed");
    if (customType !== PIN_CUSTOM_ENTRY_TYPE && customType !== MEMORY_CUSTOM_ENTRY_TYPE) {
      throw new Error("context_persistence append invariant failed");
    }
    this.mutationType = customType === PIN_CUSTOM_ENTRY_TYPE ? "pin" : "memory";
    if (data && typeof data === "object") {
      const mutation = data as Record<string, unknown>;
      const item = mutation.item && typeof mutation.item === "object"
        ? mutation.item as Record<string, unknown>
        : undefined;
      const candidate = item?.id ?? mutation.pinId ?? mutation.memoryId;
      if (typeof candidate === "string" && opaqueId(candidate)) this.itemId = candidate;
    }
    this.state = "invoking";
    this.appendEntry(customType, data);
    this.state = "committed";
  };

  materialized(): void {
    if (this.state === "committed") this.state = "materialized";
  }
}

class ContextPersistenceToolController {
  private readonly now: () => number;
  private readonly processSecret: Uint8Array;
  private readonly bytes: (size: number) => Uint8Array;
  private readonly appendEntry?: ContextPersistenceAppender;
  private readonly sourceByKey = new Map<string, SourceHandle>();
  private readonly sourceByRef = new Map<string, SourceHandle>();
  private readonly branchRevisions = new Map<string, BranchRevisionHandle>();
  private readonly targetRevisions = new Map<string, TargetRevisionHandle>();
  private readonly sourceRevisions = new Map<string, SourceRevisionHandle>();

  constructor(
    private readonly runtime: ContextPersistenceRuntimePort,
    dependencies: ContextPersistenceToolDependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now;
    this.processSecret = dependencies.processSecret ?? randomBytes(32);
    this.bytes = dependencies.randomBytes ?? randomBytes;
    this.appendEntry = dependencies.appendEntry;
  }

  definition(): ToolDefinition<typeof CONTEXT_PERSISTENCE_PARAMS, ContextPersistenceDetails> {
    return defineTool({
      name: CONTEXT_PERSISTENCE_TOOL_NAME,
      label: "DS4 Context Persistence",
      description: CONTEXT_PERSISTENCE_DESCRIPTION,
      promptSnippet: CONTEXT_PERSISTENCE_PROMPT_SNIPPET,
      promptGuidelines: [...CONTEXT_PERSISTENCE_PROMPT_GUIDELINES],
      parameters: CONTEXT_PERSISTENCE_PARAMS,
      executionMode: "sequential",
      execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
        try {
          const result = await this.execute(toolCallId, params, signal, ctx);
          this.recordOutcome(result.details);
          return result;
        } catch {
          try {
            this.runtime.contextPersistenceRecordOutcome({
              action: params.action,
              outcome: "unavailable",
              persistenceClass: isReadAction(params.action)
                ? "read-only"
                : this.persistenceClass(params.action),
              errorCode: "boundary-failure",
            });
          } catch {
            // Logging must not change the fail-closed boundary.
          }
          throw new Error("context_persistence failed safely");
        }
      },
    });
  }

  private async execute(
    toolCallId: string,
    params: ContextPersistenceParams,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<
    | ReturnType<typeof buildReadResult>
    | ReturnType<typeof buildFailureResult>
    | ReturnType<typeof buildMutationResult>
  > {
    const persistenceClass = isReadAction(params.action)
      ? "read-only"
      : this.persistenceClass(params.action);
    if (signal?.aborted) {
      return buildFailureResult(params.action, "cancelled", "aborted", persistenceClass);
    }
    const validated = validateContextPersistenceParams(params);
    if (!validated.ok) {
      return buildFailureResult(
        params.action,
        "rejected",
        validated.errorCode,
        persistenceClass,
      );
    }
    const state = this.runtime.contextPersistenceState(ctx);
    if (!state.available) {
      return buildFailureResult(
        params.action,
        "unavailable",
        state.errorCode ?? "runtime-unavailable",
        persistenceClass,
      );
    }
    if (signal?.aborted) {
      return buildFailureResult(params.action, "cancelled", "aborted", persistenceClass);
    }
    if (!isReadAction(params.action)) {
      return this.executeWrite(toolCallId, params, state, signal, ctx);
    }
    const maxResults = Math.min(params.maxResults ?? state.maxResults, state.maxResults, 100);
    const activeOnly = params.activeOnly ?? true;
    switch (params.action) {
      case "pins_list":
        return this.listPins(state, ctx, activeOnly, maxResults);
      case "memory_list":
        return this.listMemories(state, ctx, activeOnly, maxResults);
      case "pins_find":
        return this.findPins(state, ctx, params.query ?? "", activeOnly, maxResults, signal);
      case "memory_find":
        return this.findMemories(state, ctx, params.query ?? "", activeOnly, maxResults, signal);
      case "memory_sources":
        return this.listSources(state, maxResults);
    }
  }

  private async executeWrite(
    toolCallId: string,
    params: ContextPersistenceParams,
    state: ContextPersistenceRuntimeState,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<ReturnType<typeof buildFailureResult> | ReturnType<typeof buildMutationResult>> {
    const persistenceClass = this.persistenceClass(params.action);
    if (signal?.aborted) return buildFailureResult(params.action, "cancelled", "aborted", persistenceClass);
    if (!ctx.hasUI) {
      return buildFailureResult(params.action, "unavailable", "confirmation-required", persistenceClass);
    }
    if (params.action === "memory_source_exclude" || params.action === "memory_source_include") {
      return this.setSourcePolicy(params.action, params, state, signal, ctx);
    }
    if (!this.appendEntry) {
      return buildFailureResult(params.action, "unavailable", "action-unavailable", persistenceClass);
    }
    switch (params.action) {
      case "pin_add":
        return this.addPin(toolCallId, params, state, signal, ctx);
      case "pin_supersede":
        return this.supersedePin(toolCallId, params, state, signal, ctx);
      case "pin_unpin":
        return this.unpin(params, state, signal, ctx);
      case "memory_add":
        return this.addMemory(toolCallId, params, state, signal, ctx);
      case "memory_supersede":
        return this.supersedeMemory(toolCallId, params, state, signal, ctx);
      case "memory_invalidate":
        return this.setMemoryStatus("memory_invalidate", "invalid", params, state, signal, ctx);
      case "memory_expire":
        return this.setMemoryStatus("memory_expire", "expired", params, state, signal, ctx);
      default:
        return buildFailureResult(params.action, "unavailable", "action-unavailable", persistenceClass);
    }
  }

  private async addPin(
    toolCallId: string,
    params: ContextPersistenceParams,
    state: ContextPersistenceRuntimeState,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<ReturnType<typeof buildFailureResult> | ReturnType<typeof buildMutationResult>> {
    const content = params.content ?? "";
    const scope = params.scope ?? "session";
    if (content.length > state.maxPinChars || content.length > BODY_CEILING) {
      return buildFailureResult("pin_add", "rejected", "content-too-long", "canonical-jsonl");
    }
    if (scope === "project" && !state.projectTrusted) {
      return buildFailureResult("pin_add", "rejected", "project-untrusted", "canonical-jsonl");
    }
    const policy = this.runtime.contextPersistenceMutationPolicy(
      content,
      params.classification,
      undefined,
      state.provider,
    );
    if (!policy.allowed) {
      return buildFailureResult("pin_add", "rejected", "provider-policy-denied", "canonical-jsonl");
    }
    const provenance = this.runtime.contextPersistenceResolveProvenance(ctx, toolCallId);
    if (!provenance) {
      return buildFailureResult("pin_add", "rejected", "provenance-unavailable", "canonical-jsonl");
    }
    const confirmed = await this.confirm(
      ctx,
      "pin_add",
      [
        "Persistence: canonical Pi JSONL append",
        `Scope: ${scope}`,
        `Classification: ${policy.classification}`,
        "",
        content,
        "",
        "This appends history; it does not physically delete prior entries.",
      ].join("\n"),
    );
    if (!confirmed) return buildFailureResult("pin_add", "cancelled", undefined, "canonical-jsonl");
    if (signal?.aborted) return buildFailureResult("pin_add", "cancelled", "aborted", "canonical-jsonl");
    if (!this.runtime.contextPersistenceValidateProvenance(ctx, provenance)) {
      return buildFailureResult("pin_add", "rejected", "provenance-unavailable", "canonical-jsonl");
    }
    const refreshedState = this.runtime.contextPersistenceState(ctx);
    if (!refreshedState.available) {
      return buildFailureResult(
        "pin_add",
        "unavailable",
        refreshedState.errorCode ?? "runtime-unavailable",
        "canonical-jsonl",
      );
    }
    if (scope === "project" && !refreshedState.projectTrusted) {
      return buildFailureResult("pin_add", "rejected", "project-untrusted", "canonical-jsonl");
    }
    const refreshedPolicy = this.runtime.contextPersistenceMutationPolicy(
      content,
      params.classification,
      undefined,
      refreshedState.provider,
    );
    if (!refreshedPolicy.allowed) {
      return buildFailureResult("pin_add", "rejected", "provider-policy-denied", "canonical-jsonl");
    }
    return this.commitPin("pin_add", scope, ctx, (appendEntry) =>
      this.runtime.contextPersistenceCreatePin({
        content,
        scope,
        sourceEntryId: provenance.primarySourceEntryId,
        ...(refreshedPolicy.storedClassification
          ? { classification: refreshedPolicy.storedClassification }
          : {}),
      }, ctx, appendEntry));
  }

  private async supersedePin(
    toolCallId: string,
    params: ContextPersistenceParams,
    state: ContextPersistenceRuntimeState,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<ReturnType<typeof buildFailureResult> | ReturnType<typeof buildMutationResult>> {
    const id = params.id ?? "";
    const content = params.content ?? "";
    if (content.length > state.maxPinChars || content.length > BODY_CEILING) {
      return buildFailureResult("pin_supersede", "rejected", "content-too-long", "canonical-jsonl");
    }
    const target = this.runtime.contextPersistenceResolvePin(id, true);
    if (!target) {
      return buildFailureResult("pin_supersede", "rejected", "target-not-active", "canonical-jsonl");
    }
    if (!this.pinRevisionMatches(target, params.targetRevision, state, ctx)) {
      return buildFailureResult("pin_supersede", "rejected", "stale-target", "canonical-jsonl");
    }
    if (target.scope === "project" && !state.projectTrusted) {
      return buildFailureResult("pin_supersede", "rejected", "project-untrusted", "canonical-jsonl");
    }
    const inheritedClassification = classification(target.classification, state);
    if (classificationDowngrade(params.classification, inheritedClassification)) {
      return buildFailureResult("pin_supersede", "rejected", "invalid-classification", "canonical-jsonl");
    }
    const policy = this.runtime.contextPersistenceMutationPolicy(
      content,
      params.classification,
      inheritedClassification,
      state.provider,
    );
    if (!policy.allowed) {
      return buildFailureResult("pin_supersede", "rejected", "provider-policy-denied", "canonical-jsonl");
    }
    const provenance = this.runtime.contextPersistenceResolveProvenance(ctx, toolCallId);
    if (!provenance) {
      return buildFailureResult("pin_supersede", "rejected", "provenance-unavailable", "canonical-jsonl");
    }
    const confirmed = await this.confirm(
      ctx,
      "pin_supersede",
      [
        "Persistence: canonical Pi JSONL append",
        `Scope: ${target.scope}`,
        `Target: ${target.id}`,
        `Revision: ${(params.targetRevision ?? "").slice(0, 12)}…`,
        `Classification: ${policy.classification}`,
        "",
        content,
        "",
        "This appends a supersession; it does not physically delete prior entries.",
      ].join("\n"),
    );
    if (!confirmed) return buildFailureResult("pin_supersede", "cancelled", undefined, "canonical-jsonl");
    if (signal?.aborted) return buildFailureResult("pin_supersede", "cancelled", "aborted", "canonical-jsonl");
    if (!this.runtime.contextPersistenceValidateProvenance(ctx, provenance)) {
      return buildFailureResult("pin_supersede", "rejected", "provenance-unavailable", "canonical-jsonl");
    }
    const refreshed = this.runtime.contextPersistenceResolvePin(id, true);
    const refreshedState = this.runtime.contextPersistenceState(ctx);
    if (!refreshedState.available) {
      return buildFailureResult(
        "pin_supersede",
        "unavailable",
        refreshedState.errorCode ?? "runtime-unavailable",
        "canonical-jsonl",
      );
    }
    if (!refreshed || !this.pinRevisionMatches(refreshed, params.targetRevision, refreshedState, ctx)) {
      return buildFailureResult("pin_supersede", "rejected", "stale-target", "canonical-jsonl");
    }
    if (refreshed.scope === "project" && !refreshedState.projectTrusted) {
      return buildFailureResult("pin_supersede", "rejected", "project-untrusted", "canonical-jsonl");
    }
    const refreshedInherited = classification(refreshed.classification, refreshedState);
    const refreshedPolicy = this.runtime.contextPersistenceMutationPolicy(
      content,
      params.classification,
      refreshedInherited,
      refreshedState.provider,
    );
    if (!refreshedPolicy.allowed) {
      return buildFailureResult("pin_supersede", "rejected", "provider-policy-denied", "canonical-jsonl");
    }
    const storedClassification = replacementStoredClassification(
      params.classification,
      refreshed.classification,
      refreshedInherited,
      refreshedPolicy,
    );
    return this.commitPin("pin_supersede", refreshed.scope, ctx, (appendEntry) =>
      this.runtime.contextPersistenceCreatePin({
        content,
        scope: refreshed.scope,
        sourceEntryId: provenance.primarySourceEntryId,
        supersedes: refreshed.id,
        ...(storedClassification ? { classification: storedClassification } : {}),
      }, ctx, appendEntry));
  }

  private async unpin(
    params: ContextPersistenceParams,
    state: ContextPersistenceRuntimeState,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<ReturnType<typeof buildFailureResult> | ReturnType<typeof buildMutationResult>> {
    const id = params.id ?? "";
    const target = this.runtime.contextPersistenceResolvePin(id, true);
    if (!target) return buildFailureResult("pin_unpin", "rejected", "target-not-active", "canonical-jsonl");
    if (!this.pinRevisionMatches(target, params.targetRevision, state, ctx)) {
      return buildFailureResult("pin_unpin", "rejected", "stale-target", "canonical-jsonl");
    }
    if (target.scope === "project" && !state.projectTrusted) {
      return buildFailureResult("pin_unpin", "rejected", "project-untrusted", "canonical-jsonl");
    }
    const reason = params.reason;
    if (reason) {
      const reasonPolicy = this.runtime.contextPersistenceMutationPolicy(
        reason,
        undefined,
        classification(target.classification, state),
        state.provider,
      );
      if (reasonPolicy.secretDetected || reasonPolicy.markerDetected) {
        return buildFailureResult("pin_unpin", "rejected", "secret-in-reason", "canonical-jsonl");
      }
      if (!reasonPolicy.allowed) {
        return buildFailureResult("pin_unpin", "rejected", "provider-policy-denied", "canonical-jsonl");
      }
    }
    const localPreview = target.content.length <= BODY_CEILING
      ? Array.from(target.content).slice(0, 500).join("")
      : "[legacy body omitted; inspect with /context]";
    const confirmed = await this.confirm(
      ctx,
      "pin_unpin",
      [
        "Persistence: canonical Pi JSONL append",
        `Scope: ${target.scope}`,
        `Target: ${target.id}`,
        `Revision: ${(params.targetRevision ?? "").slice(0, 12)}…`,
        "",
        localPreview,
        ...(reason ? ["", `Reason: ${reason}`] : []),
        "",
        "This appends a deleted status; it does not physically delete prior entries.",
      ].join("\n"),
    );
    if (!confirmed) return buildFailureResult("pin_unpin", "cancelled", undefined, "canonical-jsonl");
    if (signal?.aborted) return buildFailureResult("pin_unpin", "cancelled", "aborted", "canonical-jsonl");
    const refreshed = this.runtime.contextPersistenceResolvePin(id, true);
    const refreshedState = this.runtime.contextPersistenceState(ctx);
    if (!refreshedState.available) {
      return buildFailureResult(
        "pin_unpin",
        "unavailable",
        refreshedState.errorCode ?? "runtime-unavailable",
        "canonical-jsonl",
      );
    }
    if (!refreshed || !this.pinRevisionMatches(refreshed, params.targetRevision, refreshedState, ctx)) {
      return buildFailureResult("pin_unpin", "rejected", "stale-target", "canonical-jsonl");
    }
    if (refreshed.scope === "project" && !refreshedState.projectTrusted) {
      return buildFailureResult("pin_unpin", "rejected", "project-untrusted", "canonical-jsonl");
    }
    if (reason) {
      const refreshedReasonPolicy = this.runtime.contextPersistenceMutationPolicy(
        reason,
        undefined,
        classification(refreshed.classification, refreshedState),
        refreshedState.provider,
      );
      if (refreshedReasonPolicy.secretDetected || refreshedReasonPolicy.markerDetected) {
        return buildFailureResult("pin_unpin", "rejected", "secret-in-reason", "canonical-jsonl");
      }
      if (!refreshedReasonPolicy.allowed) {
        return buildFailureResult("pin_unpin", "rejected", "provider-policy-denied", "canonical-jsonl");
      }
    }
    return this.commitPin("pin_unpin", refreshed.scope, ctx, (appendEntry) => ({
      pin: this.runtime.contextPersistenceUnpin(refreshed.id, reason, ctx, appendEntry),
      duplicate: false,
    }));
  }

  private async addMemory(
    toolCallId: string,
    params: ContextPersistenceParams,
    state: ContextPersistenceRuntimeState,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<ReturnType<typeof buildFailureResult> | ReturnType<typeof buildMutationResult>> {
    const content = params.content ?? "";
    const scope = params.scope ?? "session";
    if (scope === "branch") {
      return buildFailureResult("memory_add", "rejected", "invalid-scope", "canonical-jsonl");
    }
    if (content.length > state.maxClaimChars || content.length > BODY_CEILING) {
      return buildFailureResult("memory_add", "rejected", "claim-too-long", "canonical-jsonl");
    }
    if (scope === "project" && !state.projectTrusted) {
      return buildFailureResult("memory_add", "rejected", "project-untrusted", "canonical-jsonl");
    }
    const policyText = params.key ? `${content}\n${params.key}` : content;
    const policy = this.runtime.contextPersistenceMutationPolicy(
      policyText,
      params.classification,
      undefined,
      state.provider,
    );
    if (!policy.allowed) {
      return buildFailureResult("memory_add", "rejected", "provider-policy-denied", "canonical-jsonl");
    }
    const provenance = this.runtime.contextPersistenceResolveProvenance(ctx, toolCallId);
    if (!provenance) {
      return buildFailureResult("memory_add", "rejected", "provenance-unavailable", "canonical-jsonl");
    }
    const confirmed = await this.confirm(
      ctx,
      "memory_add",
      [
        "Persistence: canonical Pi JSONL append",
        `Scope: ${scope}`,
        ...(params.key ? [`Key: ${params.key}`] : []),
        `Classification: ${policy.classification}`,
        "",
        content,
        "",
        "This appends history; it does not physically delete prior entries.",
      ].join("\n"),
    );
    if (!confirmed) return buildFailureResult("memory_add", "cancelled", undefined, "canonical-jsonl");
    if (signal?.aborted) return buildFailureResult("memory_add", "cancelled", "aborted", "canonical-jsonl");
    if (!this.runtime.contextPersistenceValidateProvenance(ctx, provenance)) {
      return buildFailureResult("memory_add", "rejected", "provenance-unavailable", "canonical-jsonl");
    }
    const refreshedState = this.runtime.contextPersistenceState(ctx);
    if (!refreshedState.available) {
      return buildFailureResult(
        "memory_add",
        "unavailable",
        refreshedState.errorCode ?? "runtime-unavailable",
        "canonical-jsonl",
      );
    }
    if (scope === "project" && !refreshedState.projectTrusted) {
      return buildFailureResult("memory_add", "rejected", "project-untrusted", "canonical-jsonl");
    }
    const refreshedPolicy = this.runtime.contextPersistenceMutationPolicy(
      policyText,
      params.classification,
      undefined,
      refreshedState.provider,
    );
    if (!refreshedPolicy.allowed) {
      return buildFailureResult("memory_add", "rejected", "provider-policy-denied", "canonical-jsonl");
    }
    return this.commitMemory("memory_add", scope, ctx, (appendEntry) =>
      this.runtime.contextPersistenceCreateMemory({
        claim: content,
        scope,
        ...(params.key ? { key: params.key } : {}),
        ...(refreshedPolicy.storedClassification
          ? { classification: refreshedPolicy.storedClassification }
          : {}),
        sourceEntryIds: [provenance.primarySourceEntryId],
      }, ctx, appendEntry));
  }

  private async supersedeMemory(
    toolCallId: string,
    params: ContextPersistenceParams,
    state: ContextPersistenceRuntimeState,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<ReturnType<typeof buildFailureResult> | ReturnType<typeof buildMutationResult>> {
    const id = params.id ?? "";
    const content = params.content ?? "";
    if (content.length > state.maxClaimChars || content.length > BODY_CEILING) {
      return buildFailureResult("memory_supersede", "rejected", "claim-too-long", "canonical-jsonl");
    }
    const target = this.runtime.contextPersistenceResolveMemory(id, true);
    if (!target) {
      return buildFailureResult("memory_supersede", "rejected", "target-not-active", "canonical-jsonl");
    }
    if (!this.memoryRevisionMatches(target, params.targetRevision, state, ctx)) {
      return buildFailureResult("memory_supersede", "rejected", "stale-target", "canonical-jsonl");
    }
    if (target.scope === "project" && !state.projectTrusted) {
      return buildFailureResult("memory_supersede", "rejected", "project-untrusted", "canonical-jsonl");
    }
    const inheritedClassification = classification(target.classification, state);
    if (classificationDowngrade(params.classification, inheritedClassification)) {
      return buildFailureResult("memory_supersede", "rejected", "invalid-classification", "canonical-jsonl");
    }
    const policy = this.runtime.contextPersistenceMutationPolicy(
      content,
      params.classification,
      inheritedClassification,
      state.provider,
    );
    if (!policy.allowed) {
      return buildFailureResult("memory_supersede", "rejected", "provider-policy-denied", "canonical-jsonl");
    }
    const provenance = this.runtime.contextPersistenceResolveProvenance(ctx, toolCallId);
    if (!provenance) {
      return buildFailureResult("memory_supersede", "rejected", "provenance-unavailable", "canonical-jsonl");
    }
    const confirmed = await this.confirm(
      ctx,
      "memory_supersede",
      [
        "Persistence: canonical Pi JSONL append",
        `Scope: ${target.scope}`,
        `Target: ${target.id}`,
        `Revision: ${(params.targetRevision ?? "").slice(0, 12)}…`,
        ...(target.key ? [`Key: ${target.key}`] : []),
        `Classification: ${policy.classification}`,
        "",
        content,
        "",
        "This appends a supersession; it does not physically delete prior entries.",
      ].join("\n"),
    );
    if (!confirmed) return buildFailureResult("memory_supersede", "cancelled", undefined, "canonical-jsonl");
    if (signal?.aborted) return buildFailureResult("memory_supersede", "cancelled", "aborted", "canonical-jsonl");
    if (!this.runtime.contextPersistenceValidateProvenance(ctx, provenance)) {
      return buildFailureResult("memory_supersede", "rejected", "provenance-unavailable", "canonical-jsonl");
    }
    const refreshed = this.runtime.contextPersistenceResolveMemory(id, true);
    const refreshedState = this.runtime.contextPersistenceState(ctx);
    if (!refreshedState.available) {
      return buildFailureResult(
        "memory_supersede",
        "unavailable",
        refreshedState.errorCode ?? "runtime-unavailable",
        "canonical-jsonl",
      );
    }
    if (!refreshed || !this.memoryRevisionMatches(refreshed, params.targetRevision, refreshedState, ctx)) {
      return buildFailureResult("memory_supersede", "rejected", "stale-target", "canonical-jsonl");
    }
    if (refreshed.scope === "project" && !refreshedState.projectTrusted) {
      return buildFailureResult("memory_supersede", "rejected", "project-untrusted", "canonical-jsonl");
    }
    const refreshedInherited = classification(refreshed.classification, refreshedState);
    const refreshedPolicy = this.runtime.contextPersistenceMutationPolicy(
      content,
      params.classification,
      refreshedInherited,
      refreshedState.provider,
    );
    if (!refreshedPolicy.allowed) {
      return buildFailureResult("memory_supersede", "rejected", "provider-policy-denied", "canonical-jsonl");
    }
    const storedClassification = replacementStoredClassification(
      params.classification,
      refreshed.classification,
      refreshedInherited,
      refreshedPolicy,
    );
    return this.commitMemory("memory_supersede", refreshed.scope, ctx, (appendEntry) => ({
      memory: this.runtime.contextPersistenceSupersedeMemory(
        refreshed.id,
        content,
        [provenance.primarySourceEntryId],
        storedClassification,
        ctx,
        appendEntry,
      ),
      duplicate: false,
    }));
  }

  private async setMemoryStatus(
    action: "memory_invalidate" | "memory_expire",
    status: "invalid" | "expired",
    params: ContextPersistenceParams,
    state: ContextPersistenceRuntimeState,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<ReturnType<typeof buildFailureResult> | ReturnType<typeof buildMutationResult>> {
    const id = params.id ?? "";
    const target = this.runtime.contextPersistenceResolveMemory(id, true);
    if (!target) return buildFailureResult(action, "rejected", "target-not-active", "canonical-jsonl");
    if (!this.memoryRevisionMatches(target, params.targetRevision, state, ctx)) {
      return buildFailureResult(action, "rejected", "stale-target", "canonical-jsonl");
    }
    if (target.scope === "project" && !state.projectTrusted) {
      return buildFailureResult(action, "rejected", "project-untrusted", "canonical-jsonl");
    }
    const reason = params.reason;
    if (reason) {
      const reasonPolicy = this.runtime.contextPersistenceMutationPolicy(
        reason,
        undefined,
        classification(target.classification, state),
        state.provider,
      );
      if (reasonPolicy.secretDetected || reasonPolicy.markerDetected) {
        return buildFailureResult(action, "rejected", "secret-in-reason", "canonical-jsonl");
      }
      if (!reasonPolicy.allowed) {
        return buildFailureResult(action, "rejected", "provider-policy-denied", "canonical-jsonl");
      }
    }
    const localPreview = target.claim.length <= BODY_CEILING
      ? Array.from(target.claim).slice(0, 500).join("")
      : "[legacy body omitted; inspect with /context]";
    const confirmed = await this.confirm(
      ctx,
      action,
      [
        "Persistence: canonical Pi JSONL append",
        `Scope: ${target.scope}`,
        `Target: ${target.id}`,
        `Revision: ${(params.targetRevision ?? "").slice(0, 12)}…`,
        `Classification: ${classification(target.classification, state)}`,
        "",
        localPreview,
        ...(reason ? ["", `Reason: ${reason}`] : []),
        "",
        `This appends an ${status} status; it does not physically delete prior entries.`,
      ].join("\n"),
    );
    if (!confirmed) return buildFailureResult(action, "cancelled", undefined, "canonical-jsonl");
    if (signal?.aborted) return buildFailureResult(action, "cancelled", "aborted", "canonical-jsonl");
    const refreshed = this.runtime.contextPersistenceResolveMemory(id, true);
    const refreshedState = this.runtime.contextPersistenceState(ctx);
    if (!refreshedState.available) {
      return buildFailureResult(
        action,
        "unavailable",
        refreshedState.errorCode ?? "runtime-unavailable",
        "canonical-jsonl",
      );
    }
    if (!refreshed || !this.memoryRevisionMatches(refreshed, params.targetRevision, refreshedState, ctx)) {
      return buildFailureResult(action, "rejected", "stale-target", "canonical-jsonl");
    }
    if (refreshed.scope === "project" && !refreshedState.projectTrusted) {
      return buildFailureResult(action, "rejected", "project-untrusted", "canonical-jsonl");
    }
    if (reason) {
      const refreshedReasonPolicy = this.runtime.contextPersistenceMutationPolicy(
        reason,
        undefined,
        classification(refreshed.classification, refreshedState),
        refreshedState.provider,
      );
      if (refreshedReasonPolicy.secretDetected || refreshedReasonPolicy.markerDetected) {
        return buildFailureResult(action, "rejected", "secret-in-reason", "canonical-jsonl");
      }
      if (!refreshedReasonPolicy.allowed) {
        return buildFailureResult(action, "rejected", "provider-policy-denied", "canonical-jsonl");
      }
    }
    return this.commitMemory(action, refreshed.scope, ctx, (appendEntry) => ({
      memory: this.runtime.contextPersistenceSetMemoryStatus(
        refreshed.id,
        status,
        reason,
        ctx,
        appendEntry,
      ),
      duplicate: false,
    }));
  }

  private async setSourcePolicy(
    action: "memory_source_exclude" | "memory_source_include",
    params: ContextPersistenceParams,
    state: ContextPersistenceRuntimeState,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<ReturnType<typeof buildFailureResult> | ReturnType<typeof buildMutationResult>> {
    if (!state.projectTrusted) {
      return buildFailureResult(action, "unavailable", "project-untrusted", "derived-local-policy");
    }
    if (!state.crossSessionEnabled) {
      return buildFailureResult(action, "unavailable", "cross-session-disabled", "derived-local-policy");
    }
    if (!state.crossSessionReady) {
      return buildFailureResult(action, "unavailable", "memory-unavailable", "derived-local-policy");
    }
    const sourceRef = params.id ?? "";
    const handle = this.resolveSourceHandle(sourceRef, state);
    if (!handle) {
      return buildFailureResult(action, "rejected", "source-not-found", "derived-local-policy");
    }
    const source = this.runtime.contextPersistenceResolveProjectSource(handle.sessionId);
    if (!source || !this.sourceRevisionMatches(source, sourceRef, params.targetRevision, state)) {
      return buildFailureResult(action, "rejected", source ? "stale-target" : "source-not-found", "derived-local-policy");
    }
    const excluded = action === "memory_source_exclude";
    if (excluded && handle.sessionId === state.sessionId) {
      return buildFailureResult(action, "rejected", "source-not-excludable", "derived-local-policy");
    }
    if (params.reason) {
      const reasonPolicy = this.runtime.contextPersistenceMutationPolicy(
        params.reason,
        undefined,
        undefined,
        state.provider,
      );
      if (reasonPolicy.secretDetected || reasonPolicy.markerDetected) {
        return buildFailureResult(action, "rejected", "secret-in-reason", "derived-local-policy");
      }
      if (!reasonPolicy.allowed) {
        return buildFailureResult(action, "rejected", "provider-policy-denied", "derived-local-policy");
      }
    }
    const confirmed = await this.confirm(
      ctx,
      action,
      [
        "Persistence: derived local SQLite policy (disposable)",
        `Source: ${sourceRef}`,
        `Status: ${source.status}`,
        `Revision: ${(params.targetRevision ?? "").slice(0, 12)}…`,
        `Indexed mutations: ${source.indexedMutations}`,
        `Active project memories: ${source.activeProjectMemories}`,
        `Active project pins: ${source.activeProjectPins}`,
        "",
        "No Pi JSONL entry will be appended. Deleting the local database resets this policy.",
      ].join("\n"),
    );
    if (!confirmed) return buildFailureResult(action, "cancelled", undefined, "derived-local-policy");
    if (signal?.aborted) return buildFailureResult(action, "cancelled", "aborted", "derived-local-policy");
    const refreshedState = this.runtime.contextPersistenceState(ctx);
    if (!refreshedState.available) {
      return buildFailureResult(
        action,
        "unavailable",
        refreshedState.errorCode ?? "runtime-unavailable",
        "derived-local-policy",
      );
    }
    if (!refreshedState.projectTrusted) {
      return buildFailureResult(action, "unavailable", "project-untrusted", "derived-local-policy");
    }
    if (!refreshedState.crossSessionEnabled) {
      return buildFailureResult(action, "unavailable", "cross-session-disabled", "derived-local-policy");
    }
    if (!refreshedState.crossSessionReady) {
      return buildFailureResult(action, "unavailable", "memory-unavailable", "derived-local-policy");
    }
    if (params.reason) {
      const refreshedReasonPolicy = this.runtime.contextPersistenceMutationPolicy(
        params.reason,
        undefined,
        undefined,
        refreshedState.provider,
      );
      if (refreshedReasonPolicy.secretDetected || refreshedReasonPolicy.markerDetected) {
        return buildFailureResult(action, "rejected", "secret-in-reason", "derived-local-policy");
      }
      if (!refreshedReasonPolicy.allowed) {
        return buildFailureResult(action, "rejected", "provider-policy-denied", "derived-local-policy");
      }
    }
    const refreshedHandle = this.resolveSourceHandle(sourceRef, refreshedState);
    const refreshed = refreshedHandle
      ? this.runtime.contextPersistenceResolveProjectSource(refreshedHandle.sessionId)
      : undefined;
    if (!refreshedHandle || !refreshed
      || !this.sourceRevisionMatches(refreshed, sourceRef, params.targetRevision, refreshedState)) {
      return buildFailureResult(
        action,
        "rejected",
        refreshed ? "stale-target" : "source-not-found",
        "derived-local-policy",
      );
    }
    if ((refreshed.status === "excluded") === excluded) {
      return this.sourceMutationResult(action, "ok", sourceRef, refreshed, refreshedState);
    }
    try {
      const updated = this.runtime.contextPersistenceSetProjectSourceExcluded(
        refreshedHandle.sessionId,
        excluded,
        excluded ? params.reason : undefined,
      );
      if (!updated || (updated.status === "excluded") !== excluded) {
        return buildFailureResult(action, "unavailable", "runtime-unavailable", "derived-local-policy");
      }
      return this.sourceMutationResult(action, "committed", sourceRef, updated, refreshedState);
    } catch {
      try {
        const observed = this.runtime.contextPersistenceResolveProjectSource(refreshedHandle.sessionId);
        if (observed && (observed.status === "excluded") === excluded) {
          return this.sourceMutationResult(action, "committed", sourceRef, observed, refreshedState);
        }
      } catch {
        // The derived-policy outcome could not be observed safely.
      }
      return buildFailureResult(action, "unavailable", "runtime-unavailable", "derived-local-policy");
    }
  }

  private async confirm(ctx: ExtensionContext, action: ContextPersistenceAction, message: string): Promise<boolean> {
    try {
      return await ctx.ui.confirm("DS4 Context Persistence", `Action: ${action}\n${message}`);
    } catch {
      return false;
    }
  }

  private pinRevisionMatches(
    item: PinItem,
    targetRevision: string | undefined,
    state: ContextPersistenceRuntimeState,
    ctx: ExtensionContext,
  ): boolean {
    if (!targetRevision) return false;
    this.pruneRevisions();
    const handle = this.targetRevisions.get(targetRevision);
    if (!handle || handle.kind !== "pin" || handle.id !== item.id) return false;
    if (handle.sessionId !== state.sessionId || handle.projectIdentity !== state.projectIdentity) return false;
    const branch = this.branchRevisions.get(handle.branchRevision);
    if (!branch) return false;
    const currentEntryIds = ctx.sessionManager.getBranch().map((entry) => entry.id);
    if (currentEntryIds.length < branch.entryIds.length) return false;
    for (let index = 0; index < branch.entryIds.length; index++) {
      if (currentEntryIds[index] !== branch.entryIds[index]) return false;
    }
    const branchIds = new Set(currentEntryIds);
    const effectiveClassification = classification(item.classification, state);
    const fingerprint = this.revision({
      kind: "pin",
      id: item.id,
      scope: item.scope,
      status: item.status,
      updatedAt: item.updatedAt,
      classification: effectiveClassification,
      applicable: pinApplicable(item, branchIds),
      sessionId: state.sessionId,
      projectIdentity: state.projectIdentity,
    });
    return fingerprint === handle.fingerprint;
  }

  private memoryRevisionMatches(
    item: MemoryItem,
    targetRevision: string | undefined,
    state: ContextPersistenceRuntimeState,
    ctx: ExtensionContext,
  ): boolean {
    if (!targetRevision) return false;
    this.pruneRevisions();
    const handle = this.targetRevisions.get(targetRevision);
    if (!handle || handle.kind !== "memory" || handle.id !== item.id) return false;
    if (handle.sessionId !== state.sessionId || handle.projectIdentity !== state.projectIdentity) return false;
    const branch = this.branchRevisions.get(handle.branchRevision);
    if (!branch) return false;
    const currentEntryIds = ctx.sessionManager.getBranch().map((entry) => entry.id);
    if (currentEntryIds.length < branch.entryIds.length) return false;
    for (let index = 0; index < branch.entryIds.length; index++) {
      if (currentEntryIds[index] !== branch.entryIds[index]) return false;
    }
    const effectiveClassification = classification(item.classification, state);
    const fingerprint = this.revision({
      kind: "memory",
      id: item.id,
      scope: item.scope,
      status: item.status,
      updatedAt: item.updatedAt,
      classification: effectiveClassification,
      sessionId: state.sessionId,
      projectIdentity: state.projectIdentity,
    });
    return fingerprint === handle.fingerprint;
  }

  private commitPin(
    action: "pin_add" | "pin_supersede" | "pin_unpin",
    scope: "session" | "branch" | "project",
    ctx: ExtensionContext,
    mutation: (appendEntry: ContextPersistenceAppender) => { pin: PinItem; duplicate: boolean },
  ): ReturnType<typeof buildFailureResult> | ReturnType<typeof buildMutationResult> {
    const tracker = new TrackedCanonicalAppender(this.appendEntry as ContextPersistenceAppender);
    try {
      const result = mutation(tracker.append);
      if (!opaqueId(result.pin.id)) throw new Error("context_persistence materialization invariant failed");
      tracker.materialized();
      const state = this.runtime.contextPersistenceState(ctx);
      const branchIds = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
      const dto = this.pinDto(
        result.pin,
        state,
        this.branchRevision(ctx),
        pinApplicable(result.pin, branchIds),
      );
      return buildMutationResult({
        action,
        outcome: result.duplicate ? "ok" : "committed",
        persistenceClass: "canonical-jsonl",
        id: dto.id,
        kind: "pin",
        scope: dto.scope,
        status: dto.status,
        classification: dto.classification,
        targetRevision: dto.targetRevision,
        ...(result.duplicate ? { duplicate: true } : {}),
      });
    } catch {
      if (tracker.state === "invoking") {
        return buildMutationResult({
          action,
          outcome: "indeterminate",
          persistenceClass: "canonical-jsonl",
          ...(tracker.itemId ? { id: tracker.itemId } : {}),
          kind: "pin",
          errorCode: "append-indeterminate",
        });
      }
      if (tracker.state === "committed" || tracker.state === "materialized") {
        return buildMutationResult({
          action,
          outcome: "committed_projection_pending",
          persistenceClass: "canonical-jsonl",
          ...(tracker.itemId ? { id: tracker.itemId } : {}),
          kind: "pin",
          scope,
          errorCode: "committed-projection-pending",
        });
      }
      return buildFailureResult(action, "unavailable", "runtime-unavailable", "canonical-jsonl");
    }
  }

  private commitMemory(
    action: "memory_add" | "memory_supersede" | "memory_invalidate" | "memory_expire",
    scope: "session" | "project",
    ctx: ExtensionContext,
    mutation: (appendEntry: ContextPersistenceAppender) => { memory: MemoryItem; duplicate: boolean },
  ): ReturnType<typeof buildFailureResult> | ReturnType<typeof buildMutationResult> {
    const tracker = new TrackedCanonicalAppender(this.appendEntry as ContextPersistenceAppender);
    try {
      const result = mutation(tracker.append);
      if (!opaqueId(result.memory.id)) throw new Error("context_persistence materialization invariant failed");
      tracker.materialized();
      const state = this.runtime.contextPersistenceState(ctx);
      const dto = this.memoryDto(result.memory, state, this.branchRevision(ctx));
      return buildMutationResult({
        action,
        outcome: result.duplicate ? "ok" : "committed",
        persistenceClass: "canonical-jsonl",
        id: dto.id,
        kind: "memory",
        scope: dto.scope,
        status: dto.status,
        classification: dto.classification,
        targetRevision: dto.targetRevision,
        ...(result.duplicate ? { duplicate: true } : {}),
      });
    } catch (error) {
      if (tracker.state === "invoking") {
        return buildMutationResult({
          action,
          outcome: "indeterminate",
          persistenceClass: "canonical-jsonl",
          ...(tracker.itemId ? { id: tracker.itemId } : {}),
          kind: "memory",
          errorCode: "append-indeterminate",
        });
      }
      if (tracker.state === "committed" || tracker.state === "materialized") {
        return buildMutationResult({
          action,
          outcome: "committed_projection_pending",
          persistenceClass: "canonical-jsonl",
          ...(tracker.itemId ? { id: tracker.itemId } : {}),
          kind: "memory",
          scope,
          errorCode: "committed-projection-pending",
        });
      }
      if (error instanceof MemoryConflictError) {
        return buildFailureResult(action, "rejected", "duplicate-conflict", "canonical-jsonl");
      }
      return buildFailureResult(action, "unavailable", "runtime-unavailable", "canonical-jsonl");
    }
  }

  private recordOutcome(details: ContextPersistenceDetails): void {
    try {
      this.runtime.contextPersistenceRecordOutcome({
        action: details.action,
        outcome: details.outcome,
        persistenceClass: details.persistenceClass,
        ...(details.scope ? { scope: details.scope } : {}),
        ...(details.id ? { itemId: details.id } : {}),
        ...(details.classification ? { classification: details.classification } : {}),
        ...(details.count !== undefined ? { resultCount: details.count } : {}),
        ...(details.duplicate !== undefined ? { duplicate: details.duplicate } : {}),
        ...(details.errorCode ? { errorCode: details.errorCode } : {}),
      });
    } catch {
      // Outcome logging is best-effort and must not affect persistence semantics.
    }
  }

  private persistenceClass(action: ContextPersistenceAction): "canonical-jsonl" | "derived-local-policy" {
    return action === "memory_source_exclude" || action === "memory_source_include"
      ? "derived-local-policy"
      : "canonical-jsonl";
  }

  private revision(input: unknown): string {
    return `rev_${createHmac("sha256", this.processSecret)
      .update(stableStringify({ version: 1, input }))
      .digest("base64url")
      .slice(0, 22)}`;
  }

  private rememberTargetRevision(token: string, handle: TargetRevisionHandle): void {
    this.targetRevisions.set(token, handle);
    this.pruneRevisions();
  }

  private pruneRevisions(): void {
    const now = this.now();
    for (const [token, handle] of this.targetRevisions) {
      if (now - handle.emittedAt > REVISION_TTL_MS) this.targetRevisions.delete(token);
    }
    for (const [token, handle] of this.branchRevisions) {
      if (now - handle.emittedAt > REVISION_TTL_MS) this.branchRevisions.delete(token);
    }
    for (const [token, handle] of this.sourceRevisions) {
      if (now - handle.emittedAt > REVISION_TTL_MS) this.sourceRevisions.delete(token);
    }
    if (this.targetRevisions.size > REVISION_CAP) {
      const oldest = [...this.targetRevisions]
        .sort((left, right) => left[1].emittedAt - right[1].emittedAt || compareAscii(left[0], right[0]));
      for (const [token] of oldest.slice(0, this.targetRevisions.size - REVISION_CAP)) {
        this.targetRevisions.delete(token);
      }
    }
    if (this.branchRevisions.size > REVISION_CAP) {
      const oldest = [...this.branchRevisions]
        .sort((left, right) => left[1].emittedAt - right[1].emittedAt || compareAscii(left[0], right[0]));
      for (const [token] of oldest.slice(0, this.branchRevisions.size - REVISION_CAP)) {
        this.branchRevisions.delete(token);
      }
    }
    if (this.sourceRevisions.size > REVISION_CAP) {
      const oldest = [...this.sourceRevisions]
        .sort((left, right) => left[1].emittedAt - right[1].emittedAt || compareAscii(left[0], right[0]));
      for (const [token] of oldest.slice(0, this.sourceRevisions.size - REVISION_CAP)) {
        this.sourceRevisions.delete(token);
      }
    }
  }

  private branchRevision(ctx: ExtensionContext): string {
    const entryIds = ctx.sessionManager.getBranch().map((entry) => entry.id);
    const revision = this.revision({
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId(),
      branch: entryIds,
    });
    this.branchRevisions.set(revision, { entryIds, emittedAt: this.now() });
    this.pruneRevisions();
    return revision;
  }

  private pinDto(
    item: PinItem,
    state: ContextPersistenceRuntimeState,
    branchRevision: string,
    applicable: boolean,
  ): PinReadItem {
    const effectiveClassification = classification(item.classification, state);
    const fingerprint = this.revision({
      kind: "pin",
      id: item.id,
      scope: item.scope,
      status: item.status,
      updatedAt: item.updatedAt,
      classification: effectiveClassification,
      applicable,
      sessionId: state.sessionId,
      projectIdentity: state.projectIdentity,
    });
    const targetRevision = this.revision({
      fingerprint,
      branchRevision,
    });
    this.rememberTargetRevision(targetRevision, {
      kind: "pin",
      id: item.id,
      sessionId: state.sessionId,
      projectIdentity: state.projectIdentity,
      branchRevision,
      fingerprint,
      emittedAt: this.now(),
    });
    return {
      id: item.id,
      kind: "pin",
      scope: item.scope,
      status: item.status,
      classification: effectiveClassification,
      applicableToActiveBranch: applicable,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      targetRevision,
    };
  }

  private memoryDto(
    item: MemoryItem,
    state: ContextPersistenceRuntimeState,
    branchRevision: string,
  ): MemoryReadItem {
    const effectiveClassification = classification(item.classification, state);
    const fingerprint = this.revision({
      kind: "memory",
      id: item.id,
      scope: item.scope,
      status: item.status,
      updatedAt: item.updatedAt,
      classification: effectiveClassification,
      sessionId: state.sessionId,
      projectIdentity: state.projectIdentity,
    });
    const targetRevision = this.revision({ fingerprint, branchRevision });
    this.rememberTargetRevision(targetRevision, {
      kind: "memory",
      id: item.id,
      sessionId: state.sessionId,
      projectIdentity: state.projectIdentity,
      branchRevision,
      fingerprint,
      emittedAt: this.now(),
    });
    return {
      id: item.id,
      kind: "memory",
      scope: item.scope,
      status: item.status,
      classification: effectiveClassification,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      targetRevision,
    };
  }

  private listPins(
    state: ContextPersistenceRuntimeState,
    ctx: ExtensionContext,
    activeOnly: boolean,
    maxResults: number,
  ): ReturnType<typeof buildReadResult> {
    const branchIds = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
    const branchRevision = this.branchRevision(ctx);
    const page = this.runtime.contextPersistenceListPinsPage(ctx, activeOnly, maxResults);
    const items = page.items
      .filter((item) => opaqueId(item.id))
      .map((item) => this.pinDto(item, state, branchRevision, pinApplicable(item, branchIds)));
    return buildReadResult({
      action: "pins_list",
      items,
      truncated: page.hasMore,
      incomplete: false,
    });
  }

  private listMemories(
    state: ContextPersistenceRuntimeState,
    ctx: ExtensionContext,
    activeOnly: boolean,
    maxResults: number,
  ): ReturnType<typeof buildReadResult> {
    const branchRevision = this.branchRevision(ctx);
    const page = this.runtime.contextPersistenceListMemoriesPage(activeOnly, maxResults);
    const items = page.items
      .filter((item) => opaqueId(item.id))
      .map((item) => this.memoryDto(item, state, branchRevision));
    return buildReadResult({
      action: "memory_list",
      items,
      truncated: page.hasMore,
      incomplete: false,
    });
  }

  private findPins(
    state: ContextPersistenceRuntimeState,
    ctx: ExtensionContext,
    rawQuery: string,
    activeOnly: boolean,
    maxResults: number,
    signal: AbortSignal | undefined,
  ): ReturnType<typeof buildReadResult> {
    const branchIds = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
    const branchRevision = this.branchRevision(ctx);
    const query = normalizeSearch(rawQuery);
    const queryTerms = terms(query);
    const exactId = rawQuery.trim();
    const exact = opaqueId(exactId)
      ? this.runtime.contextPersistenceResolvePin(exactId, activeOnly)
      : undefined;
    const bounded = exact
      ? { items: [exact], incomplete: false, aborted: false }
      : this.runtime.contextPersistenceScanPins(
          activeOnly,
          FIND_PAGE_SIZE,
          FIND_SCAN_CAP,
          signal,
        );
    if (bounded.aborted) {
      return buildFailureResult("pins_find", "cancelled", "aborted") as ReturnType<typeof buildReadResult>;
    }
    let incomplete = bounded.incomplete;
    const scored: ScoredPin[] = [];
    const scan = bounded.items.filter((item) => opaqueId(item.id));
    for (let offset = 0; offset < scan.length; offset += FIND_PAGE_SIZE) {
      if (signal?.aborted) return buildFailureResult("pins_find", "cancelled", "aborted") as ReturnType<typeof buildReadResult>;
      for (const item of scan.slice(offset, offset + FIND_PAGE_SIZE)) {
        const applicable = pinApplicable(item, branchIds);
        let match: { matchKind: MatchKind; baseScore: number } | undefined;
        if (item === exact) match = { matchKind: "metadata-only", baseScore: 120 };
        else if (item.content.length > BODY_CEILING) {
          incomplete = true;
          continue;
        } else match = matchText(query, queryTerms, item.content);
        if (!match) continue;
        let preview: string | undefined;
        if (item !== exact) {
          const effectiveClassification = classification(item.classification, state);
          const sanitized = this.runtime.contextPersistenceSanitizeText(
            item.content,
            effectiveClassification,
            state.provider,
          );
          if (sanitized.allowed) {
            preview = Array.from(sanitized.value).slice(0, PREVIEW_SCALARS).join("") || undefined;
          }
        }
        scored.push({
          item,
          applicable,
          matchKind: match.matchKind,
          score: match.baseScore + (item.status === "active" ? 10 : 0),
          ...(preview ? { preview } : {}),
          previewStatus: preview ? "included" : "omitted-by-policy",
        });
      }
    }
    scored.sort(scoredPinOrder);
    const page = scored.slice(0, maxResults + 1);
    const previews = new Map<string, string>();
    const items: ContextPersistenceReadItem[] = page.slice(0, maxResults).map((candidate) => {
      if (candidate.preview) previews.set(candidate.item.id, candidate.preview);
      return {
        ...this.pinDto(candidate.item, state, branchRevision, candidate.applicable),
        matchKind: candidate.matchKind,
        score: candidate.score,
        previewStatus: candidate.previewStatus,
      };
    });
    return buildReadResult({
      action: "pins_find",
      items,
      truncated: page.length > maxResults,
      incomplete,
      previews,
    });
  }

  private findMemories(
    state: ContextPersistenceRuntimeState,
    ctx: ExtensionContext,
    rawQuery: string,
    activeOnly: boolean,
    maxResults: number,
    signal: AbortSignal | undefined,
  ): ReturnType<typeof buildReadResult> {
    const branchRevision = this.branchRevision(ctx);
    const query = normalizeSearch(rawQuery);
    const queryTerms = terms(query);
    const exactId = rawQuery.trim();
    const exact = opaqueId(exactId)
      ? this.runtime.contextPersistenceResolveMemory(exactId, activeOnly)
      : undefined;
    const bounded = exact
      ? { items: [exact], incomplete: false, aborted: false }
      : this.runtime.contextPersistenceScanMemories(
          activeOnly,
          FIND_PAGE_SIZE,
          FIND_SCAN_CAP,
          signal,
        );
    if (bounded.aborted) {
      return buildFailureResult("memory_find", "cancelled", "aborted") as ReturnType<typeof buildReadResult>;
    }
    let incomplete = bounded.incomplete;
    const scored: ScoredMemory[] = [];
    const scan = bounded.items.filter((item) => opaqueId(item.id));
    for (let offset = 0; offset < scan.length; offset += FIND_PAGE_SIZE) {
      if (signal?.aborted) return buildFailureResult("memory_find", "cancelled", "aborted") as ReturnType<typeof buildReadResult>;
      for (const item of scan.slice(offset, offset + FIND_PAGE_SIZE)) {
        let match: { matchKind: MatchKind; baseScore: number } | undefined;
        if (item === exact) match = { matchKind: "metadata-only", baseScore: 120 };
        else if (item.claim.length > BODY_CEILING) {
          if (item.key && normalizeSearch(item.key) === query) match = { matchKind: "exact-key", baseScore: 100 };
          incomplete = true;
        } else match = matchText(query, queryTerms, item.claim, item.key);
        if (!match) continue;
        let preview: string | undefined;
        if (item !== exact && item.claim.length <= BODY_CEILING) {
          const effectiveClassification = classification(item.classification, state);
          const sanitized = this.runtime.contextPersistenceSanitizeText(
            item.claim,
            effectiveClassification,
            state.provider,
          );
          if (sanitized.allowed) {
            preview = Array.from(sanitized.value).slice(0, PREVIEW_SCALARS).join("") || undefined;
          }
        }
        scored.push({
          item,
          matchKind: match.matchKind,
          score: match.baseScore + (item.status === "active" ? 10 : 0),
          ...(preview ? { preview } : {}),
          previewStatus: preview ? "included" : "omitted-by-policy",
        });
      }
    }
    scored.sort(scoredMemoryOrder);
    const page = scored.slice(0, maxResults + 1);
    const previews = new Map<string, string>();
    const items: ContextPersistenceReadItem[] = page.slice(0, maxResults).map((candidate) => {
      if (candidate.preview) previews.set(candidate.item.id, candidate.preview);
      return {
        ...this.memoryDto(candidate.item, state, branchRevision),
        matchKind: candidate.matchKind,
        score: candidate.score,
        previewStatus: candidate.previewStatus,
      };
    });
    return buildReadResult({
      action: "memory_find",
      items,
      truncated: page.length > maxResults,
      incomplete,
      previews,
    });
  }

  private listSources(
    state: ContextPersistenceRuntimeState,
    maxResults: number,
  ): ReturnType<typeof buildReadResult> | ReturnType<typeof buildFailureResult> {
    if (!state.projectTrusted) return buildFailureResult("memory_sources", "unavailable", "project-untrusted");
    if (!state.crossSessionEnabled) return buildFailureResult("memory_sources", "unavailable", "cross-session-disabled");
    if (!state.crossSessionReady) return buildFailureResult("memory_sources", "unavailable", "memory-unavailable");
    const page = this.runtime.contextPersistenceProjectSourcesPage(maxResults);
    const items: SourceReadItem[] = page.items.map((source) => {
      const sourceRef = this.sourceRef(state.projectIdentity, source.sessionId);
      const errorCode = source.status === "missing"
        ? "source-missing"
        : source.status === "corrupt"
          ? "source-corrupt"
          : source.malformedLines > 0
            ? "source-malformed"
            : undefined;
      const targetRevision = this.sourceFingerprint(source, state);
      this.sourceRevisions.set(targetRevision, {
        sourceRef,
        sourceSessionId: source.sessionId,
        sessionId: state.sessionId,
        projectIdentity: state.projectIdentity,
        fingerprint: targetRevision,
        emittedAt: this.now(),
      });
      this.pruneRevisions();
      return {
        sourceRef,
        kind: "project-memory-source",
        status: source.status,
        indexedMutations: source.indexedMutations,
        activeProjectMemories: source.activeProjectMemories,
        activeProjectPins: source.activeProjectPins,
        hasMalformedLines: source.malformedLines > 0,
        targetRevision,
        ...(errorCode ? { errorCode } : {}),
      };
    });
    return buildReadResult({
      action: "memory_sources",
      items,
      truncated: page.hasMore,
      incomplete: false,
    });
  }

  private sourceFingerprint(
    source: ProjectMemorySource,
    state: ContextPersistenceRuntimeState,
  ): string {
    return this.revision({
      kind: "project-memory-source",
      projectIdentity: state.projectIdentity,
      sessionId: source.sessionId,
      indexedAt: source.indexedAt,
      status: source.status,
      indexedMutations: source.indexedMutations,
      activeProjectMemories: source.activeProjectMemories,
      activeProjectPins: source.activeProjectPins,
      malformedLines: source.malformedLines,
    });
  }

  private resolveSourceHandle(
    sourceRef: string,
    state: ContextPersistenceRuntimeState,
  ): SourceHandle | undefined {
    const now = this.now();
    this.pruneSourceRefs(now);
    const handle = this.sourceByRef.get(sourceRef);
    if (!handle || handle.projectIdentity !== state.projectIdentity) return undefined;
    handle.lastAccessAt = now;
    return handle;
  }

  private sourceRevisionMatches(
    source: ProjectMemorySource,
    sourceRef: string,
    targetRevision: string | undefined,
    state: ContextPersistenceRuntimeState,
  ): boolean {
    if (!targetRevision) return false;
    this.pruneRevisions();
    const revision = this.sourceRevisions.get(targetRevision);
    if (!revision
      || revision.sourceRef !== sourceRef
      || revision.sourceSessionId !== source.sessionId
      || revision.sessionId !== state.sessionId
      || revision.projectIdentity !== state.projectIdentity) return false;
    return revision.fingerprint === this.sourceFingerprint(source, state);
  }

  private sourceMutationResult(
    action: "memory_source_exclude" | "memory_source_include",
    outcome: "ok" | "committed",
    sourceRef: string,
    source: ProjectMemorySource,
    state: ContextPersistenceRuntimeState,
  ): ReturnType<typeof buildMutationResult> {
    const targetRevision = this.sourceFingerprint(source, state);
    this.sourceRevisions.set(targetRevision, {
      sourceRef,
      sourceSessionId: source.sessionId,
      sessionId: state.sessionId,
      projectIdentity: state.projectIdentity,
      fingerprint: targetRevision,
      emittedAt: this.now(),
    });
    this.pruneRevisions();
    return buildMutationResult({
      action,
      outcome,
      persistenceClass: "derived-local-policy",
      sourceRef,
      kind: "project-memory-source",
      status: source.status,
      targetRevision,
    });
  }

  private sourceRef(projectIdentity: string, sessionId: string): string {
    const now = this.now();
    this.pruneSourceRefs(now);
    const key = `${projectIdentity}\0${sessionId}`;
    const existing = this.sourceByKey.get(key);
    if (existing && now - existing.emittedAt <= SOURCE_REF_TTL_MS) {
      existing.emittedAt = now;
      existing.lastAccessAt = now;
      return existing.sourceRef;
    }
    if (existing) this.deleteSourceHandle(existing);
    let sourceRef: string;
    do sourceRef = `source_${Buffer.from(this.bytes(16)).toString("base64url")}`;
    while (this.sourceByRef.has(sourceRef));
    const handle = { sourceRef, projectIdentity, sessionId, emittedAt: now, lastAccessAt: now };
    this.sourceByKey.set(key, handle);
    this.sourceByRef.set(sourceRef, handle);
    this.pruneSourceRefs(now);
    return sourceRef;
  }

  private pruneSourceRefs(now: number): void {
    for (const handle of this.sourceByRef.values()) {
      if (now - handle.emittedAt > SOURCE_REF_TTL_MS) this.deleteSourceHandle(handle);
    }
    if (this.sourceByRef.size <= SOURCE_REF_CAP) return;
    const oldest = [...this.sourceByRef.values()]
      .sort((left, right) => left.lastAccessAt - right.lastAccessAt || compareAscii(left.sourceRef, right.sourceRef));
    for (const handle of oldest.slice(0, this.sourceByRef.size - SOURCE_REF_CAP)) this.deleteSourceHandle(handle);
  }

  private deleteSourceHandle(handle: SourceHandle): void {
    this.sourceByRef.delete(handle.sourceRef);
    this.sourceByKey.delete(`${handle.projectIdentity}\0${handle.sessionId}`);
  }
}

export function createContextPersistenceTool(
  runtime: ContextPersistenceRuntimePort,
  dependencies: ContextPersistenceToolDependencies = {},
): ToolDefinition<typeof CONTEXT_PERSISTENCE_PARAMS, ContextPersistenceDetails> {
  return new ContextPersistenceToolController(runtime, dependencies).definition();
}

export function registerContextPersistenceTool(
  pi: ExtensionAPI,
  runtime: ContextPersistenceRuntimePort,
  dependencies: ContextPersistenceToolDependencies = {},
): void {
  pi.registerTool(createContextPersistenceTool(runtime, {
    ...dependencies,
    appendEntry: (customType, data) => pi.appendEntry(customType, data),
  }));
}
