import type { ContextConfig } from "../config/config.ts";
import type { ContextBudget } from "../core/budget-manager.ts";
import { estimateMessagesTokens } from "../core/token-estimator.ts";
import type {
  ContextManifestItemKind,
  ContextManifestPlanning,
  ProjectSnippetRef,
} from "../manifest/context-manifest.ts";
import {
  buildAtomicGroups,
  messageRole,
  validateAtomicSelection,
  type AtomicMessageGroup,
} from "./atomic-groups.ts";

export interface PlannedMessageMetadata {
  originalIndex: number;
  groupId: string;
  kind: ContextManifestItemKind;
  tokens: number;
  score: number;
  reason: string;
  sourceId?: string;
  retrievedEventIds?: string[];
  projectSnippet?: ProjectSnippetRef;
}

export interface ManagedContextPlan<T> {
  mode: "managed" | "fallback";
  originalMessages: T[];
  messages: T[];
  selected: PlannedMessageMetadata[];
  excluded: PlannedMessageMetadata[];
  planning: ContextManifestPlanning;
}

export interface SupplementalContextMessage<T> {
  id: string;
  message: T;
  kind: "pin" | "memory" | "retrieval" | "project";
  sourceIds: string[];
  score: number;
  reason: string;
  projectSnippet?: ProjectSnippetRef;
}

export interface PlanContextInput<T> {
  messages: readonly T[];
  fixedTokens: number;
  budget: ContextBudget;
  config: ContextConfig;
  pinnedMessageIndices?: readonly number[];
  supplementalMessages?: readonly SupplementalContextMessage<T>[];
}

interface GroupClassification {
  group: AtomicMessageGroup;
  kind: ContextManifestItemKind;
  score: number;
  reason: string;
  sourceId?: string;
  retrievedEventIds?: string[];
  projectSnippet?: ProjectSnippetRef;
}

export function adaptiveRecentTailLimit(contextWindow: number, configuredLimit: number): number {
  const modelLimit = contextWindow <= 40_000
    ? 12_000
    : contextWindow <= 131_072
      ? 24_000
      : contextWindow <= 262_144
        ? 32_000
        : 64_000;
  return Math.max(0, Math.min(configuredLimit, modelLimit));
}

function score(group: AtomicMessageGroup, priority: number, messageCount: number): number {
  const value = priority + ((group.endIndex + 1) / Math.max(1, messageCount + 1));
  return Math.round(value * 1_000_000) / 1_000_000;
}

function metadata(
  messages: readonly unknown[],
  classification: GroupClassification,
): PlannedMessageMetadata[] {
  return classification.group.messageIndices.map((originalIndex) => ({
    originalIndex,
    groupId: classification.group.id,
    kind: classification.kind,
    tokens: estimateMessagesTokens([messages[originalIndex]]),
    score: classification.score,
    reason: `${classification.reason}; ${classification.group.reason}`,
    ...(classification.sourceId ? { sourceId: classification.sourceId } : {}),
    ...(classification.retrievedEventIds ? { retrievedEventIds: [...classification.retrievedEventIds] } : {}),
    ...(classification.projectSnippet ? { projectSnippet: { ...classification.projectSnippet } } : {}),
  }));
}

function selectedMessages<T>(messages: readonly T[], selected: readonly PlannedMessageMetadata[]): T[] {
  return selected.map((item) => messages[item.originalIndex]).filter((message): message is T => message !== undefined);
}

function fallbackPlan<T>(
  input: PlanContextInput<T>,
  recentTailTokenLimit: number,
  reason: string,
): ManagedContextPlan<T> {
  const groups = buildAtomicGroups(input.messages);
  const pinnedIndices = new Set(
    (input.pinnedMessageIndices ?? []).filter((index) => Number.isInteger(index) && index >= 0 && index < input.messages.length),
  );
  const lastUserIndex = input.messages.findLastIndex((message) => messageRole(message) === "user");
  const currentGroupIds = new Set(
    (lastUserIndex >= 0
      ? groups.filter((group) => group.messageIndices.some((index) => index >= lastUserIndex))
      : groups.slice(-1))
      .map((group) => group.id),
  );
  const pinnedGroupIds = new Set(
    groups
      .filter((group) => group.messageIndices.some((index) => pinnedIndices.has(index)))
      .map((group) => group.id),
  );
  const selected = groups.flatMap((group) => {
    const isCurrent = currentGroupIds.has(group.id);
    const isPinned = pinnedGroupIds.has(group.id);
    const kind: ContextManifestItemKind = isCurrent
      ? "current"
      : isPinned
        ? "pin"
        : group.kind === "summary"
          ? "summary"
          : group.kind === "turn"
            ? "recent"
            : "history";
    const priority = isCurrent ? 1000 : isPinned ? 900 : group.kind === "turn" ? 100 : group.kind === "summary" ? 75 : 40;
    return metadata(input.messages, {
      group,
      kind,
      score: score(group, priority, input.messages.length),
      reason: `Pi context retained by fail-open: ${reason}`,
    });
  }).sort((left, right) => left.originalIndex - right.originalIndex);

  return {
    mode: "fallback",
    originalMessages: [...input.messages],
    messages: [...input.messages],
    selected,
    excluded: [],
    planning: {
      mode: "fallback",
      originalMessageTokens: estimateMessagesTokens(input.messages),
      originalMessageCount: input.messages.length,
      fixedTokens: input.fixedTokens,
      messageTargetTokens: Math.max(0, input.budget.activeInputBudget - input.fixedTokens),
      messageHardLimitTokens: Math.max(0, input.budget.hardInputLimit - input.fixedTokens),
      recentTailTokenLimit,
      selectedGroupCount: groups.length,
      excludedGroupCount: 0,
      fallbackReason: reason,
    },
  };
}

export function planManagedContext<T>(nativeInput: PlanContextInput<T>): ManagedContextPlan<T> {
  const nativeLastUserIndex = nativeInput.messages.findLastIndex((message) => messageRole(message) === "user");
  const supplements = nativeLastUserIndex >= 0
    ? [...(nativeInput.supplementalMessages ?? [])].filter((supplement) => supplement.sourceIds.length > 0)
    : [];
  const insertionIndex = nativeLastUserIndex >= 0 ? nativeLastUserIndex : nativeInput.messages.length;
  const messages = [
    ...nativeInput.messages.slice(0, insertionIndex),
    ...supplements.map((supplement) => supplement.message),
    ...nativeInput.messages.slice(insertionIndex),
  ];
  const supplementalByIndex = new Map(
    supplements.map((supplement, offset) => [insertionIndex + offset, supplement] as const),
  );
  const shiftedPinnedIndices = (nativeInput.pinnedMessageIndices ?? []).map((index) =>
    index >= insertionIndex ? index + supplements.length : index
  );
  const input: PlanContextInput<T> = {
    ...nativeInput,
    messages,
    pinnedMessageIndices: shiftedPinnedIndices,
    supplementalMessages: [],
  };
  const groups = buildAtomicGroups(input.messages);
  const originalMessageTokens = estimateMessagesTokens(nativeInput.messages);
  const recentTailTokenLimit = adaptiveRecentTailLimit(
    input.budget.contextWindow,
    input.config.recentTailTokens,
  );
  const messageTargetTokens = Math.max(0, input.budget.activeInputBudget - input.fixedTokens);
  const messageHardLimitTokens = Math.max(0, input.budget.hardInputLimit - input.fixedTokens);
  const pinnedIndices = new Set(
    (input.pinnedMessageIndices ?? []).filter((index) => Number.isInteger(index) && index >= 0 && index < input.messages.length),
  );
  const lastUserIndex = input.messages.findLastIndex((message) => messageRole(message) === "user");
  const currentGroups = lastUserIndex >= 0
    ? groups.filter((group) => group.messageIndices.some((index) => index >= lastUserIndex))
    : groups.slice(-1);
  const currentGroupIds = new Set(currentGroups.map((group) => group.id));
  const pinnedGroups = groups.filter((group) => group.messageIndices.some((index) => pinnedIndices.has(index)));
  const pinnedGroupIds = new Set(pinnedGroups.map((group) => group.id));
  const supplementalForGroup = (group: AtomicMessageGroup) => {
    for (const index of group.messageIndices) {
      const supplement = supplementalByIndex.get(index);
      if (supplement) return supplement;
    }
    return undefined;
  };
  const supplementalGroupIds = new Set(
    groups.filter((group) => supplementalForGroup(group)).map((group) => group.id),
  );

  if (input.fixedTokens > input.budget.hardInputLimit) {
    return fallbackPlan(
      nativeInput,
      recentTailTokenLimit,
      "mandatory system prompt and tool definitions exceed the hard input limit",
    );
  }

  const selectedGroups = new Map<string, GroupClassification>();
  for (const group of groups) {
    const isCurrent = currentGroupIds.has(group.id);
    const isPinned = pinnedGroupIds.has(group.id);
    const supplement = supplementalForGroup(group);
    const isPersistentPin = supplement?.kind === "pin";
    if (!isCurrent && !isPinned && !isPersistentPin) continue;
    selectedGroups.set(group.id, {
      group,
      kind: isCurrent ? "current" : "pin",
      score: isPersistentPin ? supplement.score : score(group, isCurrent ? 1000 : 900, input.messages.length),
      reason: isCurrent
        ? "Mandatory current request turn"
        : isPersistentPin
          ? supplement.reason
          : "Mandatory explicit ds4:pin group",
      ...(isPersistentPin ? { sourceId: supplement.sourceIds[0] } : {}),
    });
  }

  const selectedPinTokens = [...selectedGroups.values()]
    .filter((item) => item.kind === "pin")
    .reduce((total, item) => total + item.group.estimatedTokens, 0);
  if (selectedPinTokens > input.config.maxPinnedTokens) {
    return fallbackPlan(
      nativeInput,
      recentTailTokenLimit,
      "mandatory pinned context exceeds context.maxPinnedTokens",
    );
  }

  let selectedTokens = [...selectedGroups.values()].reduce(
    (total, item) => total + item.group.estimatedTokens,
    0,
  );
  if (selectedTokens > messageHardLimitTokens) {
    return fallbackPlan(
      nativeInput,
      recentTailTokenLimit,
      "mandatory current and pinned groups exceed the hard message budget",
    );
  }

  let recentTokens = currentGroups.reduce((total, group) => total + group.estimatedTokens, 0);
  let recentTailClosed = false;
  const recentCandidates = groups
    .filter((group) => group.kind === "turn" && !selectedGroups.has(group.id) && !supplementalGroupIds.has(group.id))
    .sort((left, right) => right.endIndex - left.endIndex);

  for (const group of recentCandidates) {
    if (recentTailClosed) continue;
    const fitsRecentTail = recentTokens + group.estimatedTokens <= recentTailTokenLimit;
    const fitsTarget = selectedTokens + group.estimatedTokens <= messageTargetTokens;
    const fitsHardLimit = selectedTokens + group.estimatedTokens <= messageHardLimitTokens;
    if (!fitsRecentTail || !fitsTarget || !fitsHardLimit) {
      recentTailClosed = true;
      continue;
    }
    selectedGroups.set(group.id, {
      group,
      kind: "recent",
      score: score(group, 100, input.messages.length),
      reason: "Selected by deterministic recent-turn ranking",
    });
    selectedTokens += group.estimatedTokens;
    recentTokens += group.estimatedTokens;
  }

  let memoryTokens = 0;
  const memoryCandidates = groups
    .flatMap((group) => {
      const supplement = supplementalForGroup(group);
      return supplement?.kind === "memory" && !selectedGroups.has(group.id) ? [{ group, supplement }] : [];
    })
    .sort((left, right) =>
      right.supplement.score - left.supplement.score
      || right.group.endIndex - left.group.endIndex
      || left.supplement.id.localeCompare(right.supplement.id)
    );
  for (const { group, supplement } of memoryCandidates) {
    const fitsMemoryBudget = memoryTokens + group.estimatedTokens <= input.config.maxMemoryTokens;
    const fitsTarget = selectedTokens + group.estimatedTokens <= messageTargetTokens;
    const fitsHardLimit = selectedTokens + group.estimatedTokens <= messageHardLimitTokens;
    if (!fitsMemoryBudget || !fitsTarget || !fitsHardLimit) continue;
    selectedGroups.set(group.id, {
      group,
      kind: "memory",
      score: supplement.score,
      reason: supplement.reason,
      sourceId: supplement.sourceIds[0],
    });
    selectedTokens += group.estimatedTokens;
    memoryTokens += group.estimatedTokens;
  }

  let retrievalTokens = 0;
  const retrievalCandidates = groups
    .flatMap((group) => {
      const supplement = supplementalForGroup(group);
      return supplement?.kind === "retrieval" && !selectedGroups.has(group.id) ? [{ group, supplement }] : [];
    })
    .sort((left, right) =>
      right.supplement.score - left.supplement.score
      || right.group.endIndex - left.group.endIndex
      || left.supplement.id.localeCompare(right.supplement.id)
    );
  for (const { group, supplement } of retrievalCandidates) {
    const fitsRetrievalBudget = retrievalTokens + group.estimatedTokens <= input.config.maxRetrievedHistoryTokens;
    const fitsTarget = selectedTokens + group.estimatedTokens <= messageTargetTokens;
    const fitsHardLimit = selectedTokens + group.estimatedTokens <= messageHardLimitTokens;
    if (!fitsRetrievalBudget || !fitsTarget || !fitsHardLimit) continue;
    selectedGroups.set(group.id, {
      group,
      kind: "retrieval",
      score: supplement.score,
      reason: supplement.reason,
      sourceId: supplement.sourceIds[0],
      retrievedEventIds: [...supplement.sourceIds],
    });
    selectedTokens += group.estimatedTokens;
    retrievalTokens += group.estimatedTokens;
  }

  let projectTokens = 0;
  const projectCandidates = groups
    .flatMap((group) => {
      const supplement = supplementalForGroup(group);
      return supplement?.kind === "project" && !selectedGroups.has(group.id) ? [{ group, supplement }] : [];
    })
    .sort((left, right) =>
      right.supplement.score - left.supplement.score
      || right.group.endIndex - left.group.endIndex
      || left.supplement.id.localeCompare(right.supplement.id)
    );
  for (const { group, supplement } of projectCandidates) {
    const fitsProjectBudget = projectTokens + group.estimatedTokens <= input.config.maxProjectTokens;
    const fitsTarget = selectedTokens + group.estimatedTokens <= messageTargetTokens;
    const fitsHardLimit = selectedTokens + group.estimatedTokens <= messageHardLimitTokens;
    if (!fitsProjectBudget || !fitsTarget || !fitsHardLimit) continue;
    selectedGroups.set(group.id, {
      group,
      kind: "project",
      score: supplement.score,
      reason: supplement.reason,
      sourceId: supplement.sourceIds[0],
      ...(supplement.projectSnippet ? { projectSnippet: { ...supplement.projectSnippet } } : {}),
    });
    selectedTokens += group.estimatedTokens;
    projectTokens += group.estimatedTokens;
  }

  let summaryTokens = 0;
  const summaryCandidates = groups
    .filter((group) => group.kind === "summary" && !selectedGroups.has(group.id))
    .sort((left, right) => right.endIndex - left.endIndex);
  for (const group of summaryCandidates) {
    const fitsSummaryBudget = summaryTokens + group.estimatedTokens <= input.config.maxSummaryTokens;
    const fitsTarget = selectedTokens + group.estimatedTokens <= messageTargetTokens;
    const fitsHardLimit = selectedTokens + group.estimatedTokens <= messageHardLimitTokens;
    if (!fitsSummaryBudget || !fitsTarget || !fitsHardLimit) continue;
    selectedGroups.set(group.id, {
      group,
      kind: "summary",
      score: score(group, 75, input.messages.length),
      reason: "Selected active Pi summary within the summary and input budgets",
    });
    selectedTokens += group.estimatedTokens;
    summaryTokens += group.estimatedTokens;
  }

  const selected = [...selectedGroups.values()]
    .flatMap((classification) => metadata(input.messages, classification))
    .sort((left, right) => left.originalIndex - right.originalIndex);
  const selectedIndices = new Set(selected.map((item) => item.originalIndex));
  const atomicErrors = validateAtomicSelection(input.messages, selectedIndices);
  if (atomicErrors.length > 0) {
    return fallbackPlan(
      nativeInput,
      recentTailTokenLimit,
      atomicErrors.join("; "),
    );
  }
  if (lastUserIndex >= 0 && !selectedIndices.has(lastUserIndex)) {
    return fallbackPlan(
      nativeInput,
      recentTailTokenLimit,
      "current user message was not selected",
    );
  }
  if (input.fixedTokens + selectedTokens > input.budget.hardInputLimit) {
    return fallbackPlan(
      nativeInput,
      recentTailTokenLimit,
      "final estimated input exceeds the hard input limit",
    );
  }

  const excluded = groups
    .filter((group) => !selectedGroups.has(group.id))
    .flatMap((group) => {
      const supplement = supplementalForGroup(group);
      if (supplement) {
        return metadata(input.messages, {
          group,
          kind: supplement.kind,
          score: supplement.score,
          reason: supplement.kind === "pin"
            ? "Excluded because mandatory pinned context exceeded its safety budget"
            : supplement.kind === "memory"
              ? "Excluded by durable-memory or active input budget"
              : supplement.kind === "retrieval"
                ? "Excluded by retrieved-history or active input budget"
                : "Excluded by project-snippet or active input budget",
          sourceId: supplement.sourceIds[0],
          ...(supplement.kind === "retrieval" ? { retrievedEventIds: [...supplement.sourceIds] } : {}),
          ...(supplement.projectSnippet ? { projectSnippet: { ...supplement.projectSnippet } } : {}),
        });
      }
      const kind: ContextManifestItemKind = group.kind === "summary"
        ? "summary"
        : group.kind === "turn"
          ? "recent"
          : "history";
      const priority = group.kind === "turn" ? 100 : group.kind === "summary" ? 75 : 40;
      const reason = group.kind === "turn"
        ? "Excluded outside the contiguous recent-tail or input budget"
        : group.kind === "summary"
          ? "Excluded by summary or input budget"
          : "Excluded because managed planner does not select older background without retrieval evidence";
      return metadata(input.messages, {
        group,
        kind,
        score: score(group, priority, input.messages.length),
        reason,
      });
    })
    .sort((left, right) => left.originalIndex - right.originalIndex);

  return {
    mode: "managed",
    originalMessages: [...input.messages],
    messages: selectedMessages(input.messages, selected),
    selected,
    excluded,
    planning: {
      mode: "managed",
      originalMessageTokens,
      originalMessageCount: nativeInput.messages.length,
      fixedTokens: input.fixedTokens,
      messageTargetTokens,
      messageHardLimitTokens,
      recentTailTokenLimit,
      selectedGroupCount: selectedGroups.size,
      excludedGroupCount: groups.length - selectedGroups.size,
    },
  };
}
