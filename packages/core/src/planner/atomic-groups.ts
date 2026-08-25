import { estimateMessageTokens } from "../core/token-estimator.ts";

export type AtomicGroupKind = "turn" | "summary" | "prefix";

export interface AtomicMessageGroup {
  id: string;
  kind: AtomicGroupKind;
  messageIndices: number[];
  startIndex: number;
  endIndex: number;
  estimatedTokens: number;
  containsToolExchange: boolean;
  reason: string;
}

interface DraftGroup {
  kind: AtomicGroupKind;
  messageIndices: number[];
}

interface ToolRelations {
  calls: Map<string, number>;
  results: Map<string, number[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function messageRole(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  return typeof message.role === "string" ? message.role : undefined;
}

function isSummaryMessage(message: unknown): boolean {
  const role = messageRole(message);
  return role === "compactionSummary" || role === "branchSummary";
}

function toolRelations(messages: readonly unknown[]): ToolRelations {
  const calls = new Map<string, number>();
  const results = new Map<string, number[]>();

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!isRecord(message)) continue;

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isRecord(block) || block.type !== "toolCall" || typeof block.id !== "string") continue;
        calls.set(block.id, index);
      }
    }

    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const indices = results.get(message.toolCallId) ?? [];
      indices.push(index);
      results.set(message.toolCallId, indices);
    }
  }

  return { calls, results };
}

function initialGroups(messages: readonly unknown[]): DraftGroup[] {
  const groups: DraftGroup[] = [];
  let activeTurn: DraftGroup | undefined;
  let activePrefix: DraftGroup | undefined;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (isSummaryMessage(message)) {
      groups.push({ kind: "summary", messageIndices: [index] });
      activeTurn = undefined;
      activePrefix = undefined;
      continue;
    }

    if (messageRole(message) === "user") {
      activeTurn = { kind: "turn", messageIndices: [index] };
      groups.push(activeTurn);
      activePrefix = undefined;
      continue;
    }

    if (activeTurn) {
      activeTurn.messageIndices.push(index);
      continue;
    }

    if (!activePrefix) {
      activePrefix = { kind: "prefix", messageIndices: [] };
      groups.push(activePrefix);
    }
    activePrefix.messageIndices.push(index);
  }

  return groups;
}

function mergedKind(groups: readonly DraftGroup[], members: readonly number[]): AtomicGroupKind {
  if (members.some((index) => groups[index]?.kind === "turn")) return "turn";
  if (members.every((index) => groups[index]?.kind === "summary")) return "summary";
  return "prefix";
}

export function buildAtomicGroups(messages: readonly unknown[]): AtomicMessageGroup[] {
  const drafts = initialGroups(messages);
  if (drafts.length === 0) return [];

  const parents = drafts.map((_, index) => index);
  const messageGroups = new Map<number, number>();
  drafts.forEach((group, groupIndex) => {
    for (const messageIndex of group.messageIndices) messageGroups.set(messageIndex, groupIndex);
  });

  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root] ?? root;
    while (parents[index] !== index) {
      const parent = parents[index] ?? index;
      parents[index] = root;
      index = parent;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };

  const relations = toolRelations(messages);
  for (const [toolCallId, resultIndices] of relations.results) {
    const callIndex = relations.calls.get(toolCallId);
    if (callIndex === undefined) continue;
    const callGroup = messageGroups.get(callIndex);
    if (callGroup === undefined) continue;
    for (const resultIndex of resultIndices) {
      const resultGroup = messageGroups.get(resultIndex);
      if (resultGroup !== undefined) union(callGroup, resultGroup);
    }
  }

  const merged = new Map<number, { draftIndices: number[]; messageIndices: number[] }>();
  drafts.forEach((group, groupIndex) => {
    const root = find(groupIndex);
    const aggregate = merged.get(root) ?? { draftIndices: [], messageIndices: [] };
    aggregate.draftIndices.push(groupIndex);
    aggregate.messageIndices.push(...group.messageIndices);
    merged.set(root, aggregate);
  });

  return [...merged.values()]
    .map((aggregate) => {
      const messageIndices = [...aggregate.messageIndices].sort((left, right) => left - right);
      const startIndex = messageIndices[0] ?? 0;
      const endIndex = messageIndices.at(-1) ?? startIndex;
      const selected = new Set(messageIndices);
      const containsToolExchange = [...relations.results].some(([id, resultIndices]) => {
        const callIndex = relations.calls.get(id);
        return callIndex !== undefined && selected.has(callIndex) && resultIndices.some((index) => selected.has(index));
      });
      const kind = mergedKind(drafts, aggregate.draftIndices);
      return {
        id: `group:${startIndex}-${endIndex}`,
        kind,
        messageIndices,
        startIndex,
        endIndex,
        estimatedTokens: messageIndices.reduce(
          (total, index) => total + estimateMessageTokens(messages[index]),
          0,
        ),
        containsToolExchange,
        reason: containsToolExchange
          ? "Atomic conversation turn containing a complete tool call/result batch"
          : kind === "turn"
            ? "Conversation turn boundary"
            : kind === "summary"
              ? "Active Pi summary message"
              : "Messages preceding the first user turn",
      } satisfies AtomicMessageGroup;
    })
    .sort((left, right) => left.startIndex - right.startIndex);
}

export function validateAtomicSelection(
  messages: readonly unknown[],
  selectedIndices: ReadonlySet<number>,
): string[] {
  const relations = toolRelations(messages);
  const errors: string[] = [];

  for (const [toolCallId, callIndex] of relations.calls) {
    if (!selectedIndices.has(callIndex)) continue;
    const resultIndices = relations.results.get(toolCallId) ?? [];
    if (resultIndices.length === 0) {
      errors.push(`selected tool call ${toolCallId} has no result`);
      continue;
    }
    if (resultIndices.some((index) => !selectedIndices.has(index))) {
      errors.push(`selected tool call ${toolCallId} is missing one or more results`);
    }
  }

  for (const [toolCallId, resultIndices] of relations.results) {
    if (!resultIndices.some((index) => selectedIndices.has(index))) continue;
    const callIndex = relations.calls.get(toolCallId);
    if (callIndex === undefined || !selectedIndices.has(callIndex)) {
      errors.push(`selected tool result ${toolCallId} has no selected call`);
    }
  }

  return [...new Set(errors)];
}
