import {
  convertToLlm,
  serializeConversation,
  sessionEntryToContextMessages,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  parseDs4CompactionDetails,
  type EmbeddedSummaryNode,
} from "ds4-context-core/compaction/compaction-record";
import { computeSummarySourceHash } from "ds4-context-core/compaction/summary-contract";
import { sha256 } from "ds4-context-core/shared/hash";
import { stableStringify } from "ds4-context-core/shared/stable-json";

interface SourceCandidate {
  entryId: string;
  fingerprint: string;
  used: boolean;
}

type CompactionMessage = SessionBeforeCompactEvent["preparation"]["messagesToSummarize"][number];

export interface PreparedCompactionSourceSlice {
  messages: CompactionMessage[];
  conversationText: string;
  sourceText: string;
  sourceEntryIds: string[];
  sourceHash: string;
  segmentReadFiles: string[];
  segmentModifiedFiles: string[];
  isSplitTurn: boolean;
}

export interface PreparedCompactionSource extends PreparedCompactionSourceSlice {
  messageEntryIds: string[];
  turnPrefixStartIndex: number;
  readFiles: string[];
  modifiedFiles: string[];
  previousSummary?: string;
  previousNode?: EmbeddedSummaryNode;
}

function fingerprint(message: unknown): string {
  return sha256(stableStringify(message));
}

function candidates(entries: readonly SessionEntry[]): SourceCandidate[] {
  return entries.flatMap((entry) => sessionEntryToContextMessages(entry).map((message) => ({
    entryId: entry.id,
    fingerprint: fingerprint(message),
    used: false,
  })));
}

function mapSourceEntryIds(messages: readonly unknown[], entries: readonly SessionEntry[]): string[] {
  const available = candidates(entries);
  const ids: string[] = [];

  for (const message of messages) {
    const match = available.find((candidate) => !candidate.used && candidate.fingerprint === fingerprint(message));
    if (!match) throw new Error("Compaction source message has no exact canonical Pi session entry");
    match.used = true;
    ids.push(match.entryId);
  }

  return ids;
}

function previousFiles(entries: readonly SessionEntry[]): { read: string[]; modified: string[] } {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "compaction") continue;
    const details = parseDs4CompactionDetails(entry.details);
    if (details) return { read: details.readFiles, modified: details.modifiedFiles };
  }
  return { read: [], modified: [] };
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

function sortedUnique(values: Iterable<string>): string[] {
  return unique(values).sort((left, right) => left.localeCompare(right));
}

function segmentFiles(messages: readonly CompactionMessage[]): { readFiles: string[]; modifiedFiles: string[] } {
  const read = new Set<string>();
  const modified = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== "toolCall" || !block.arguments || typeof block.arguments !== "object") continue;
      const path = "path" in block.arguments && typeof block.arguments.path === "string"
        ? block.arguments.path
        : undefined;
      if (!path) continue;
      if (block.name === "read") read.add(path);
      if (block.name === "write" || block.name === "edit") modified.add(path);
    }
  }
  return {
    readFiles: sortedUnique([...read].filter((path) => !modified.has(path))),
    modifiedFiles: sortedUnique(modified),
  };
}

function createSourceSlice(input: {
  messages: CompactionMessage[];
  sourceEntryIds: string[];
  segmentReadFiles: string[];
  segmentModifiedFiles: string[];
  isSplitTurn: boolean;
}): PreparedCompactionSourceSlice {
  const conversationText = serializeConversation(convertToLlm(input.messages));
  const canonicalSourceText = stableStringify(input.messages);
  const sourceEntryIds = unique(input.sourceEntryIds);
  const sourceText = [
    canonicalSourceText,
    conversationText,
    input.segmentReadFiles.join("\n"),
    input.segmentModifiedFiles.join("\n"),
  ].filter(Boolean).join("\n\n");
  return {
    messages: input.messages,
    conversationText,
    sourceText,
    sourceEntryIds,
    sourceHash: computeSummarySourceHash({
      conversationText: canonicalSourceText,
      sourceEntryIds,
      readFiles: input.segmentReadFiles,
      modifiedFiles: input.segmentModifiedFiles,
    }),
    segmentReadFiles: input.segmentReadFiles,
    segmentModifiedFiles: input.segmentModifiedFiles,
    isSplitTurn: input.isSplitTurn,
  };
}

export function sliceCompactionSource(
  source: PreparedCompactionSource,
  messageIndices: readonly number[],
): PreparedCompactionSourceSlice {
  const indices = [...new Set(messageIndices)].sort((left, right) => left - right);
  if (indices.length === 0) throw new Error("Compaction segment contains no source messages");
  for (let offset = 0; offset < indices.length; offset++) {
    const index = indices[offset];
    if (index === undefined || !source.messages[index] || !source.messageEntryIds[index]) {
      throw new Error("Compaction segment references an unavailable source message");
    }
    if (offset > 0 && index !== (indices[offset - 1] ?? -1) + 1) {
      throw new Error("Compaction segment source messages must be contiguous");
    }
  }
  const messages = indices.map((index) => source.messages[index] as CompactionMessage);
  const files = segmentFiles(messages);
  return createSourceSlice({
    messages,
    sourceEntryIds: indices.map((index) => source.messageEntryIds[index] as string),
    segmentReadFiles: files.readFiles,
    segmentModifiedFiles: files.modifiedFiles,
    isSplitTurn: source.isSplitTurn
      && indices.some((index) => index >= source.turnPrefixStartIndex),
  });
}

export function findActiveBranchSummary(
  entries: readonly SessionEntry[],
  previousSummary?: string,
): EmbeddedSummaryNode | undefined {
  if (!previousSummary) return undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "compaction" || entry.summary !== previousSummary) continue;
    const details = parseDs4CompactionDetails(entry.details);
    if (!details) return undefined;
    const metadata = details.ds4ContextEngine;
    return {
      id: metadata.summaryId,
      kind: metadata.summaryKind,
      content: entry.summary,
      sourceHash: metadata.sourceHash,
      sourceEntryIds: [...metadata.sourceEntryIds],
      childSummaryIds: [...metadata.childSummaryIds],
      graphLevel: metadata.graphLevel,
      createdAt: metadata.generatedAt,
      validationStatus: metadata.validationStatus,
      validationIssueCodes: [...metadata.validationIssueCodes],
      provider: metadata.provider,
      model: metadata.model,
    };
  }
  return undefined;
}

export function prepareCompactionSource(event: SessionBeforeCompactEvent): PreparedCompactionSource {
  const messages = [
    ...event.preparation.messagesToSummarize,
    ...event.preparation.turnPrefixMessages,
  ];
  if (messages.length === 0) throw new Error("Pi compaction preparation contains no source messages");

  const messageEntryIds = mapSourceEntryIds(messages, event.branchEntries);
  const sourceEntryIds = unique(messageEntryIds);
  const priorFiles = previousFiles(event.branchEntries);
  const segmentReadFiles = sortedUnique(event.preparation.fileOps.read);
  const segmentModifiedFiles = sortedUnique([
    ...event.preparation.fileOps.written,
    ...event.preparation.fileOps.edited,
  ]);
  const readFiles = sortedUnique([...priorFiles.read, ...segmentReadFiles]);
  const modifiedFiles = sortedUnique([...priorFiles.modified, ...segmentModifiedFiles]);
  const previousSummary = event.preparation.previousSummary;
  const previousNode = findActiveBranchSummary(event.branchEntries, previousSummary);
  const prepared = createSourceSlice({
    messages,
    sourceEntryIds,
    segmentReadFiles,
    segmentModifiedFiles,
    isSplitTurn: event.preparation.isSplitTurn,
  });

  return {
    ...prepared,
    messageEntryIds,
    turnPrefixStartIndex: event.preparation.messagesToSummarize.length,
    readFiles,
    modifiedFiles,
    ...(previousSummary ? { previousSummary } : {}),
    ...(previousNode ? { previousNode } : {}),
  };
}
