import { estimateTextTokens } from "ds4-context-core/core/token-estimator";
import { canonicalMessageSearchText, toCanonicalMessage } from "./message-converter.ts";
import type { JsonlRecord } from "./session-jsonl.ts";

export interface PiSessionEntryRecord extends Record<string, unknown> {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface IndexedSessionEntry {
  entryKey: string;
  entryId: string;
  sessionId: string;
  parentId: string | null;
  entryType: string;
  role?: string;
  createdAt?: number;
  contentHash: string;
  searchableText: string;
  tokenEstimate: number;
  indexedAt: number;
  sourceLocation: { startOffset: number; endOffset: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function isPiSessionEntryRecord(value: Record<string, unknown>): value is PiSessionEntryRecord {
  return value.type !== "session" &&
    typeof value.type === "string" &&
    typeof value.id === "string" &&
    (typeof value.parentId === "string" || value.parentId === null) &&
    typeof value.timestamp === "string";
}

function searchableText(sessionId: string, entry: PiSessionEntryRecord): { role?: string; value: string; tokens?: number } {
  if (entry.type === "message") {
    let message = entry.message;
    // Recall must not recursively re-index its own quoted output or queries.
    if (isRecord(message) && message.role === "toolResult"
      && typeof message.toolName === "string" && message.toolName.startsWith("context_history_")) {
      return { role: "toolResult", value: "" };
    }
    if (isRecord(message) && message.role === "assistant" && Array.isArray(message.content)
      && message.content.some((block) => isRecord(block) && block.type === "toolCall"
        && typeof block.name === "string" && block.name.startsWith("context_history_"))) {
      message = { ...message, content: message.content.filter((block) => !(isRecord(block)
        && block.type === "toolCall" && typeof block.name === "string" && block.name.startsWith("context_history_"))) };
    }
    const canonical = toCanonicalMessage({
      sessionId,
      entryId: entry.id,
      entryTimestamp: entry.timestamp,
      message,
    });
    const originalRole = isRecord(message) ? text(message.role) : "";
    return {
      ...(originalRole ? { role: originalRole } : {}),
      value: canonicalMessageSearchText(canonical),
      tokens: canonical.tokenEstimate,
    };
  }

  if (entry.type === "custom_message") {
    if (entry.customType === "ds4-rebase-handoff-v1") return { role: "custom", value: "" };
    const canonical = toCanonicalMessage({
      sessionId,
      entryId: entry.id,
      entryTimestamp: entry.timestamp,
      message: { role: "custom", content: entry.content },
    });
    return { role: "custom", value: canonicalMessageSearchText(canonical), tokens: canonical.tokenEstimate };
  }

  switch (entry.type) {
    case "compaction":
      return { role: "summary", value: text(entry.summary) };
    case "branch_summary":
      return { role: "summary", value: [text(entry.fromId), text(entry.summary)].filter(Boolean).join("\n") };
    case "model_change":
      return { value: [text(entry.provider), text(entry.modelId)].filter(Boolean).join("\n") };
    case "thinking_level_change":
      return { value: text(entry.thinkingLevel) };
    case "label":
      return { value: [text(entry.targetId), text(entry.label)].filter(Boolean).join("\n") };
    case "session_info":
      return { value: text(entry.name) };
    // Extension state is intentionally not indexed: it does not participate in
    // model context and may contain private implementation details.
    case "custom":
    default:
      return { value: "" };
  }
}

export function toIndexedSessionEntry(
  sessionId: string,
  record: JsonlRecord,
  indexedAt: number,
): IndexedSessionEntry {
  if (!isPiSessionEntryRecord(record.value)) {
    throw new Error(`Invalid Pi session entry at byte ${record.startOffset}`);
  }

  const extracted = searchableText(sessionId, record.value);
  const parsedTimestamp = Date.parse(record.value.timestamp);
  const createdAt = Number.isNaN(parsedTimestamp) ? undefined : parsedTimestamp;

  return {
    entryKey: `${sessionId}:${record.value.id}`,
    entryId: record.value.id,
    sessionId,
    parentId: record.value.parentId,
    entryType: record.value.type,
    ...(extracted.role ? { role: extracted.role } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    contentHash: record.rawHash,
    searchableText: extracted.value,
    tokenEstimate: extracted.tokens ?? estimateTextTokens(extracted.value),
    indexedAt,
    sourceLocation: { startOffset: record.startOffset, endOffset: record.endOffset },
  };
}
