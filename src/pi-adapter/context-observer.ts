import {
  sessionEntryToContextMessages,
  type ContextEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ContextConfig } from "ds4-context-core/config/config";
import { calculateContextBudget, type ContextBudget } from "ds4-context-core/core/budget-manager";
import { createModelProfile, type ModelProfile } from "ds4-context-core/core/model-profile";
import { estimateMessageTokens } from "ds4-context-core/core/token-estimator";
import type {
  ArtifactManifestRef,
  ContextManifest,
  MemoryManifestRef,
  ModelAwarenessManifest,
  PinManifestRef,
  PrivacyManifest,
  ContextManifestItemKind,
  ProjectRevision,
} from "ds4-context-core/manifest/context-manifest";
import {
  buildObserverManifest,
  type ExcludedContextSource,
  type ObservedMessageSource,
  type ObservedTool,
} from "ds4-context-core/manifest/observer";
import type { PrivacyClassification } from "ds4-context-core/privacy/privacy-policy";
import type { ManagedContextPlan, PlannedMessageMetadata } from "ds4-context-core/planner/context-planner";
import { sha256 } from "ds4-context-core/shared/hash";
import { stableStringify } from "ds4-context-core/shared/stable-json";
import { snapshotModel, snapshotSession } from "./session-reader.ts";

interface SourceCandidate {
  entry: SessionEntry;
  message: unknown;
  fingerprint: string;
  role?: string;
  tokens: number;
  used: boolean;
}

type PiAgentMessage = ContextEvent["messages"][number];

export interface BuildPiObserverManifestOptions {
  pi: ExtensionAPI;
  event: ContextEvent;
  ctx: ExtensionContext;
  contextConfig: ContextConfig;
  manifestId: string;
  createdAt: number;
  policyVersion: string;
  plannerVersion: string;
  profile?: ModelProfile;
  budget?: ContextBudget;
  modelAwareness?: ModelAwarenessManifest;
  plan?: ManagedContextPlan<PiAgentMessage>;
  projectRevision?: ProjectRevision;
  pins?: readonly PinManifestRef[];
  memories?: readonly MemoryManifestRef[];
  artifacts?: readonly ArtifactManifestRef[];
  artifactSources?: readonly ArtifactManifestRef[];
  systemPrompt?: string;
  systemClassification?: PrivacyClassification;
  systemPrivacyReason?: string;
  tools?: readonly ObservedTool[];
  messageClassifications?: readonly PrivacyClassification[];
  messagePrivacyReasons?: readonly (string | undefined)[];
  privacyExcludedSources?: readonly ExcludedContextSource[];
  privacy?: PrivacyManifest;
}

function roleOf(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || !("role" in message)) return undefined;
  return typeof message.role === "string" ? message.role : undefined;
}

function toolCallIdOf(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || !("toolCallId" in message)) return undefined;
  return typeof message.toolCallId === "string" ? message.toolCallId : undefined;
}

function sourceKind(entry: SessionEntry, role?: string): ContextManifestItemKind {
  if (entry.type === "compaction" || entry.type === "branch_summary" || role === "compactionSummary" || role === "branchSummary") {
    return "summary";
  }
  return "history";
}

function fingerprint(message: unknown): string {
  return sha256(stableStringify(message));
}

function sourceCandidates(entries: readonly SessionEntry[]): SourceCandidate[] {
  const candidates: SourceCandidate[] = [];
  for (const entry of entries) {
    for (const message of sessionEntryToContextMessages(entry)) {
      candidates.push({
        entry,
        message,
        fingerprint: fingerprint(message),
        ...(roleOf(message) ? { role: roleOf(message) } : {}),
        tokens: estimateMessageTokens(message),
        used: false,
      });
    }
  }
  return candidates;
}

function mapMessageSources(
  messages: readonly unknown[],
  candidates: SourceCandidate[],
  syntheticIndices: ReadonlySet<number> = new Set(),
): ObservedMessageSource[] {
  const queues = new Map<string, SourceCandidate[]>();
  for (const candidate of candidates) {
    const queue = queues.get(candidate.fingerprint) ?? [];
    queue.push(candidate);
    queues.set(candidate.fingerprint, queue);
  }

  return messages.map((message, index) => {
    if (syntheticIndices.has(index)) {
      const role = roleOf(message);
      return {
        ...(role ? { role } : {}),
        mappingReason: "Synthetic DS4 evidence with explicit source provenance",
      };
    }
    const exact = queues.get(fingerprint(message))?.find((candidate) => !candidate.used);
    if (exact) {
      exact.used = true;
      return {
        sourceId: exact.entry.id,
        ...(exact.role ? { role: exact.role } : {}),
        mappingReason: "Exact fingerprint match to Pi session entry",
      };
    }

    const role = roleOf(message);
    const fallback = candidates.find((candidate) => !candidate.used && candidate.role === role);
    if (fallback) {
      fallback.used = true;
      return {
        sourceId: fallback.entry.id,
        ...(role ? { role } : {}),
        mappingReason: "Role/order match after an earlier context extension transformed the message",
      };
    }

    return {
      ...(role ? { role } : {}),
      mappingReason: "Transient or extension-injected message without a Pi session entry",
    };
  });
}

function excludedSources(
  branchEntries: readonly SessionEntry[],
  contextEntries: readonly SessionEntry[],
  candidates: readonly SourceCandidate[],
): ExcludedContextSource[] {
  const activeIds = new Set(contextEntries.map((entry) => entry.id));
  const excluded: ExcludedContextSource[] = [];

  for (const entry of branchEntries) {
    if (!activeIds.has(entry.id)) {
      const messages = sessionEntryToContextMessages(entry);
      excluded.push({
        sourceId: entry.id,
        ...(roleOf(messages[0]) ? { role: roleOf(messages[0]) } : {}),
        tokens: messages.reduce((total, message) => total + estimateMessageTokens(message), 0),
        kind: sourceKind(entry, roleOf(messages[0])),
        reason: "Excluded by Pi branch/compaction context reconstruction",
      });
      continue;
    }

    if (sessionEntryToContextMessages(entry).length === 0) {
      excluded.push({
        sourceId: entry.id,
        tokens: 0,
        kind: sourceKind(entry),
        reason: "Pi session metadata entry does not participate in model context",
      });
    }
  }

  for (const candidate of candidates) {
    if (candidate.used) continue;
    excluded.push({
      sourceId: candidate.entry.id,
      ...(candidate.role ? { role: candidate.role } : {}),
      tokens: candidate.tokens,
      kind: sourceKind(candidate.entry, candidate.role),
      reason: "Message was removed by an earlier Pi context extension",
    });
  }

  return excluded;
}

export function activeTools(pi: ExtensionAPI): ObservedTool[] {
  const allTools = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
  return pi.getActiveTools().flatMap((name) => {
    const tool = allTools.get(name);
    if (!tool) return [];
    return [{
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      source: tool.sourceInfo.source,
    }];
  });
}

function pinnedSourceIds(entries: readonly SessionEntry[]): Set<string> {
  const labels = new Map<string, string | undefined>();
  for (const entry of entries) {
    if (entry.type === "label") labels.set(entry.targetId, entry.label);
  }
  return new Set(
    [...labels]
      .filter(([, label]) => label !== undefined && /^ds4:pin(?:\s|$)/iu.test(label.trim()))
      .map(([targetId]) => targetId),
  );
}

export function findExactPiMessageSourceIds(
  messages: readonly unknown[],
  ctx: Pick<ExtensionContext, "sessionManager">,
): Array<string | undefined> {
  const candidates = sourceCandidates(ctx.sessionManager.buildContextEntries());
  const queues = new Map<string, SourceCandidate[]>();
  for (const candidate of candidates) {
    const queue = queues.get(candidate.fingerprint) ?? [];
    queue.push(candidate);
    queues.set(candidate.fingerprint, queue);
  }
  return messages.map((message) => {
    const candidate = queues.get(fingerprint(message))?.shift();
    return candidate?.entry.id;
  });
}

export function findPiPinnedMessageIndices(event: ContextEvent, ctx: ExtensionContext): number[] {
  const candidates = sourceCandidates(ctx.sessionManager.buildContextEntries());
  const sources = mapMessageSources(event.messages, candidates);
  const pinned = pinnedSourceIds(ctx.sessionManager.getBranch());
  return sources.flatMap((source, index) => source.sourceId && pinned.has(source.sourceId) ? [index] : []);
}

function applySelection(
  metadata: PlannedMessageMetadata,
  source: ObservedMessageSource | undefined,
): ObservedMessageSource {
  return {
    ...(source ?? { mappingReason: "Transient or extension-injected message without a Pi session entry" }),
    ...(metadata.sourceId ? { sourceId: metadata.sourceId } : {}),
    groupId: metadata.groupId,
    kind: metadata.kind,
    score: metadata.score,
    ...(metadata.classification ? { classification: metadata.classification } : {}),
    ...(metadata.privacyReason ? { privacyReason: metadata.privacyReason } : {}),
    selectionReason: metadata.reason,
  };
}

function plannedExclusions(
  plan: ManagedContextPlan<PiAgentMessage>,
  originalSources: readonly ObservedMessageSource[],
): ExcludedContextSource[] {
  return plan.excluded.map((metadata) => {
    const source = originalSources[metadata.originalIndex];
    const role = roleOf(plan.originalMessages[metadata.originalIndex]) ?? source?.role;
    return {
      ...(metadata.sourceId
        ? { sourceId: metadata.sourceId }
        : source?.sourceId
          ? { sourceId: source.sourceId }
          : {}),
      ...(role ? { role } : {}),
      groupId: metadata.groupId,
      tokens: metadata.tokens,
      kind: metadata.kind,
      score: metadata.score,
      ...(metadata.classification ? { classification: metadata.classification } : {}),
      reason: [
        `${metadata.reason}; provenance: ${source?.mappingReason ?? "transient message"}`,
        metadata.privacyReason,
      ].filter(Boolean).join("; "),
    };
  });
}

export function buildPiObserverManifest(options: BuildPiObserverManifestOptions): ContextManifest {
  const session = snapshotSession(options.ctx);
  const model = snapshotModel(options.ctx);
  if (!model) throw new Error("Cannot build a Context Manifest without an active Pi model");

  const profile = options.profile ?? createModelProfile(model);
  const budget = options.budget ?? calculateContextBudget(profile, options.contextConfig);
  const contextEntries = options.ctx.sessionManager.buildContextEntries();
  const candidates = sourceCandidates(contextEntries);
  const originalMessages = options.plan?.originalMessages ?? options.event.messages;
  const syntheticIndices = new Set(
    options.plan
      ? [...options.plan.selected, ...options.plan.excluded]
          .filter((metadata) =>
            (metadata.retrievedEventIds?.length ?? 0) > 0
            || metadata.projectSnippet !== undefined
            || metadata.kind === "pin"
            || metadata.kind === "memory"
          )
          .map((metadata) => metadata.originalIndex)
      : [],
  );
  const originalSources = mapMessageSources(originalMessages, candidates, syntheticIndices);
  originalSources.forEach((source, index) => {
    const classification = options.messageClassifications?.[index];
    const privacyReason = options.messagePrivacyReasons?.[index];
    if (classification) source.classification = classification;
    if (privacyReason) source.privacyReason = privacyReason;
  });
  const artifactByToolCall = new Map(
    (options.artifactSources ?? options.artifacts ?? []).map((artifact) => [artifact.toolCallId, artifact]),
  );
  originalMessages.forEach((message, index) => {
    const artifact = artifactByToolCall.get(toolCallIdOf(message) ?? "");
    if (!artifact) return;
    originalSources[index] = {
      sourceId: artifact.sourceEntryId,
      ...(roleOf(message) ? { role: roleOf(message) } : {}),
      ...(originalSources[index]?.classification
        ? { classification: originalSources[index]?.classification }
        : {}),
      ...(originalSources[index]?.privacyReason
        ? { privacyReason: originalSources[index]?.privacyReason }
        : {}),
      mappingReason: "Exact canonical source recorded by DS4 artifact offload",
    };
    const candidate = candidates.find((item) => item.entry.id === artifact.sourceEntryId);
    if (candidate) candidate.used = true;
  });
  const messageSources = options.plan
    ? options.plan.selected.map((metadata) => applySelection(metadata, originalSources[metadata.originalIndex]))
    : originalSources;
  const baseExcluded = excludedSources(
    options.ctx.sessionManager.getBranch(),
    contextEntries,
    candidates,
  );
  const plannerExcluded = options.plan ? plannedExclusions(options.plan, originalSources) : [];
  const privacyExcluded = [...(options.privacyExcludedSources ?? [])];
  const usage = options.ctx.getContextUsage();
  const summarySourceIds = new Set(
    contextEntries
      .filter((entry) => entry.type === "compaction" || entry.type === "branch_summary")
      .map((entry) => entry.id),
  );
  const selectedSummaryIds = new Set(
    messageSources.flatMap((source) => source.sourceId && summarySourceIds.has(source.sourceId) ? [source.sourceId] : []),
  );

  return buildObserverManifest({
    id: options.manifestId,
    sessionId: session.sessionId,
    ...(session.leafId ? { branchLeafId: session.leafId } : {}),
    profile,
    budget,
    systemPrompt: options.systemPrompt ?? options.ctx.getSystemPrompt(),
    ...(options.systemClassification ? { systemClassification: options.systemClassification } : {}),
    ...(options.systemPrivacyReason ? { systemPrivacyReason: options.systemPrivacyReason } : {}),
    tools: options.tools ?? activeTools(options.pi),
    messages: options.event.messages,
    messageSources,
    excludedSources: [...baseExcluded, ...plannerExcluded, ...privacyExcluded],
    summaryIds: [...selectedSummaryIds],
    retrievedEventIds: options.plan
      ? options.plan.selected.flatMap((metadata) => metadata.retrievedEventIds ?? [])
      : [],
    projectSnippets: options.plan
      ? options.plan.selected.flatMap((metadata) => metadata.projectSnippet ? [{ ...metadata.projectSnippet }] : [])
      : [],
    ...(options.projectRevision ? { projectRevision: options.projectRevision } : {}),
    pins: options.pins ?? [],
    memories: options.memories ?? [],
    artifacts: options.artifacts ?? [],
    ...(options.privacy ? { privacy: options.privacy } : {}),
    ...(options.modelAwareness ? { modelAwareness: options.modelAwareness } : {}),
    ...(options.plan ? { planning: options.plan.planning } : {}),
    ...(usage?.tokens !== null && usage?.tokens !== undefined
      ? { piReportedContextTokens: usage.tokens }
      : {}),
    policyVersion: options.policyVersion,
    plannerVersion: options.plannerVersion,
    createdAt: options.createdAt,
  });
}
