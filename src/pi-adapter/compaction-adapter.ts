import {
  convertToLlm,
  serializeConversation,
  sessionEntryToContextMessages,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { parseDs4CompactionDetails } from "../compaction/compaction-record.ts";
import { computeSummarySourceHash } from "../compaction/summary-contract.ts";
import { sha256 } from "../shared/hash.ts";
import { stableStringify } from "../shared/stable-json.ts";

interface SourceCandidate {
  entryId: string;
  fingerprint: string;
  used: boolean;
}

export interface PreparedCompactionSource {
  messages: SessionBeforeCompactEvent["preparation"]["messagesToSummarize"];
  conversationText: string;
  sourceText: string;
  sourceEntryIds: string[];
  sourceHash: string;
  readFiles: string[];
  modifiedFiles: string[];
  previousSummary?: string;
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
    if (!ids.includes(match.entryId)) ids.push(match.entryId);
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

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function prepareCompactionSource(event: SessionBeforeCompactEvent): PreparedCompactionSource {
  const messages = [
    ...event.preparation.messagesToSummarize,
    ...event.preparation.turnPrefixMessages,
  ];
  if (messages.length === 0) throw new Error("Pi compaction preparation contains no source messages");

  const sourceEntryIds = mapSourceEntryIds(messages, event.branchEntries);
  const priorFiles = previousFiles(event.branchEntries);
  const readFiles = sortedUnique([
    ...priorFiles.read,
    ...event.preparation.fileOps.read,
  ]);
  const modifiedFiles = sortedUnique([
    ...priorFiles.modified,
    ...event.preparation.fileOps.written,
    ...event.preparation.fileOps.edited,
  ]);
  const conversationText = serializeConversation(convertToLlm(messages));
  const canonicalSourceText = stableStringify(messages);
  const previousSummary = event.preparation.previousSummary;
  const sourceText = [
    previousSummary ?? "",
    canonicalSourceText,
    conversationText,
    readFiles.join("\n"),
    modifiedFiles.join("\n"),
  ].filter(Boolean).join("\n\n");

  return {
    messages,
    conversationText,
    sourceText,
    sourceEntryIds,
    sourceHash: computeSummarySourceHash({
      conversationText: canonicalSourceText,
      ...(previousSummary ? { previousSummary } : {}),
      sourceEntryIds,
      readFiles,
      modifiedFiles,
    }),
    readFiles,
    modifiedFiles,
    ...(previousSummary ? { previousSummary } : {}),
  };
}
