export interface CompactionAtomicGroup {
  messageIndices: number[];
  startIndex: number;
  endIndex: number;
  containsToolExchange: boolean;
}

interface ToolRelation {
  callIndex: number;
  resultIndices: number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolRelations(messages: readonly unknown[]): ToolRelation[] {
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

  return [...calls].flatMap(([id, callIndex]) => {
    const resultIndices = results.get(id);
    return resultIndices && resultIndices.length > 0 ? [{ callIndex, resultIndices }] : [];
  });
}

/**
 * Build the smallest contiguous message groups that cannot be separated without
 * splitting a tool call from one or more matching results. Conversation turns
 * remain soft boundaries: an exceptionally large turn may be divided between
 * complete tool exchanges, while every individual message remains indivisible.
 */
export function buildCompactionAtomicGroups(messages: readonly unknown[]): CompactionAtomicGroup[] {
  if (messages.length === 0) return [];

  const relationRanges = toolRelations(messages)
    .map((relation) => ({
      startIndex: Math.min(relation.callIndex, ...relation.resultIndices),
      endIndex: Math.max(relation.callIndex, ...relation.resultIndices),
    }))
    .sort((left, right) => left.startIndex - right.startIndex || left.endIndex - right.endIndex);

  const mergedRanges: Array<{ startIndex: number; endIndex: number }> = [];
  for (const range of relationRanges) {
    const previous = mergedRanges.at(-1);
    if (previous && range.startIndex <= previous.endIndex) {
      previous.endIndex = Math.max(previous.endIndex, range.endIndex);
    } else {
      mergedRanges.push({ ...range });
    }
  }

  const groups: CompactionAtomicGroup[] = [];
  let rangeIndex = 0;
  let messageIndex = 0;
  while (messageIndex < messages.length) {
    const range = mergedRanges[rangeIndex];
    if (range && messageIndex === range.startIndex) {
      const messageIndices = Array.from(
        { length: range.endIndex - range.startIndex + 1 },
        (_, offset) => range.startIndex + offset,
      );
      groups.push({
        messageIndices,
        startIndex: range.startIndex,
        endIndex: range.endIndex,
        containsToolExchange: true,
      });
      messageIndex = range.endIndex + 1;
      rangeIndex++;
      continue;
    }

    groups.push({
      messageIndices: [messageIndex],
      startIndex: messageIndex,
      endIndex: messageIndex,
      containsToolExchange: false,
    });
    messageIndex++;
  }

  return groups;
}
