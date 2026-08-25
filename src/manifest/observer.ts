import type { ContextBudget } from "../core/budget-manager.ts";
import type { ModelProfile } from "../core/model-profile.ts";
import { estimateMessageTokens, estimateTextTokens } from "../core/token-estimator.ts";
import { sha256 } from "../shared/hash.ts";
import { stableStringify } from "../shared/stable-json.ts";
import type {
  ArtifactManifestRef,
  ContextManifest,
  ContextManifestItem,
  ContextManifestItemKind,
  ContextManifestPlanning,
  MemoryManifestRef,
  PinManifestRef,
  PrivacyManifest,
  ProjectRevision,
  ProjectSnippetRef,
} from "./context-manifest.ts";

export interface ObservedTool {
  name: string;
  description: string;
  parameters: unknown;
  source?: string;
  classification?: ContextManifestItem["classification"];
  privacyReason?: string;
}

export interface ObservedMessageSource {
  sourceId?: string;
  role?: string;
  groupId?: string;
  kind?: ContextManifestItemKind;
  score?: number;
  classification?: ContextManifestItem["classification"];
  privacyReason?: string;
  mappingReason: string;
  selectionReason?: string;
}

export interface ExcludedContextSource {
  sourceId?: string;
  role?: string;
  groupId?: string;
  tokens: number;
  kind: ContextManifestItemKind;
  score?: number;
  classification?: ContextManifestItem["classification"];
  reason: string;
}

export interface ObserverManifestInput {
  id: string;
  sessionId: string;
  branchLeafId?: string;
  profile: ModelProfile;
  budget: ContextBudget;
  systemPrompt: string;
  systemClassification?: ContextManifestItem["classification"];
  systemPrivacyReason?: string;
  tools: readonly ObservedTool[];
  messages: readonly unknown[];
  messageSources: readonly ObservedMessageSource[];
  excludedSources: readonly ExcludedContextSource[];
  summaryIds: readonly string[];
  retrievedEventIds?: readonly string[];
  projectSnippets?: readonly ProjectSnippetRef[];
  projectRevision?: ProjectRevision;
  pins?: readonly PinManifestRef[];
  memories?: readonly MemoryManifestRef[];
  artifacts?: readonly ArtifactManifestRef[];
  privacy?: PrivacyManifest;
  planning?: ContextManifestPlanning;
  piReportedContextTokens?: number;
  policyVersion: string;
  plannerVersion: string;
  createdAt: number;
}

function messageRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || !("role" in message)) return undefined;
  return typeof message.role === "string" ? message.role : undefined;
}

function messageKind(role: string | undefined, isCurrentUser: boolean): ContextManifestItemKind {
  if (isCurrentUser) return "current";
  if (role === "compactionSummary" || role === "branchSummary") return "summary";
  return "recent";
}

export function estimateObservedToolTokens(tool: ObservedTool): number {
  return estimateTextTokens(stableStringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  })) + 12;
}

export function buildObserverManifest(input: ObserverManifestInput): ContextManifest {
  const included: ContextManifestItem[] = [];
  const systemTokens = estimateTextTokens(input.systemPrompt) + (input.systemPrompt ? 8 : 0);
  if (input.systemPrompt) {
    included.push({
      kind: "system",
      sourceId: "pi:system-prompt",
      tokens: systemTokens,
      ...(input.systemClassification ? { classification: input.systemClassification } : {}),
      reason: input.systemPrivacyReason
        ? `Pi effective system prompt; ${input.systemPrivacyReason}`
        : "Pi effective system prompt",
    });
  }

  let toolsTotal = 0;
  for (const tool of input.tools) {
    const tokens = estimateObservedToolTokens(tool);
    toolsTotal += tokens;
    included.push({
      kind: "tool",
      sourceId: `tool:${tool.name}`,
      tokens,
      ...(tool.classification ? { classification: tool.classification } : {}),
      reason: [
        tool.source ? `Active Pi tool from ${tool.source}` : "Active Pi tool definition",
        tool.privacyReason,
      ].filter(Boolean).join("; "),
    });
  }

  let lastUserIndex = -1;
  for (let index = 0; index < input.messages.length; index++) {
    if (messageRole(input.messages[index]) === "user") lastUserIndex = index;
  }

  let messageTokens = 0;
  for (let index = 0; index < input.messages.length; index++) {
    const message = input.messages[index];
    const source = input.messageSources[index];
    const role = messageRole(message) ?? source?.role;
    const tokens = estimateMessageTokens(message);
    messageTokens += tokens;
    included.push({
      kind: source?.kind ?? messageKind(role, index === lastUserIndex),
      ...(source?.sourceId ? { sourceId: source.sourceId } : {}),
      ...(role ? { role } : {}),
      ...(source?.groupId ? { groupId: source.groupId } : {}),
      tokens,
      ...(source?.score !== undefined ? { score: source.score } : {}),
      ...(source?.classification ? { classification: source.classification } : {}),
      reason: [source?.selectionReason
        ? `${source.selectionReason}; provenance: ${source.mappingReason}`
        : source?.mappingReason ?? "Transient Pi context message without a session source",
        source?.privacyReason,
      ].filter(Boolean).join("; "),
    });
  }

  const promptHash = sha256(stableStringify({
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    messages: input.messages,
  }));
  const estimatedInputTokens = systemTokens + toolsTotal + messageTokens;

  return {
    schemaVersion: 1,
    id: input.id,
    sessionId: input.sessionId,
    ...(input.branchLeafId ? { branchLeafId: input.branchLeafId } : {}),
    provider: input.profile.provider,
    model: input.profile.modelId,
    contextWindow: input.profile.contextWindow,
    outputReserve: input.budget.outputReserve,
    hardInputLimit: input.budget.hardInputLimit,
    targetInputTokens: input.budget.activeInputBudget,
    estimatedInputTokens,
    ...(input.piReportedContextTokens !== undefined
      ? { piReportedContextTokens: input.piReportedContextTokens }
      : {}),
    included,
    excluded: input.excludedSources.map((source) => ({ ...source })),
    summaryIds: [...input.summaryIds],
    retrievedEventIds: [...new Set(input.retrievedEventIds ?? [])],
    projectSnippets: (input.projectSnippets ?? []).map((snippet) => ({ ...snippet })),
    ...(input.projectRevision ? {
      projectRevision: {
        ...input.projectRevision,
        changedFiles: [...input.projectRevision.changedFiles],
      },
    } : {}),
    pins: (input.pins ?? []).map((pin) => ({ ...pin })),
    memories: (input.memories ?? []).map((memory) => ({
      ...memory,
      sourceEntryIds: [...memory.sourceEntryIds],
    })),
    artifacts: (input.artifacts ?? []).map((artifact) => ({ ...artifact })),
    ...(input.privacy ? {
      privacy: {
        ...input.privacy,
        allowedClassifications: [...input.privacy.allowedClassifications],
        selectedClassifications: { ...input.privacy.selectedClassifications },
      },
    } : {}),
    composition: {
      systemTokens,
      toolTokens: toolsTotal,
      messageTokens,
      messageCount: input.messages.length,
      toolCount: input.tools.length,
    },
    ...(input.planning ? { planning: { ...input.planning } } : {}),
    policyVersion: input.policyVersion,
    plannerVersion: input.plannerVersion,
    promptHash,
    createdAt: input.createdAt,
  };
}
