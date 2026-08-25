import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { readJsonlRecords } from "./session-jsonl.ts";
import {
  MEMORY_CUSTOM_ENTRY_TYPE,
  PIN_CUSTOM_ENTRY_TYPE,
  parseMemoryMutation,
  parsePinMutation,
  type MemoryMutation,
  type PinMutation,
  type SessionMutationProjection,
  type StoredMemoryMutation,
  type StoredPinMutation,
} from "ds4-context-core/memory/memory-types";

export type { SessionMutationProjection } from "ds4-context-core/memory/memory-types";

function normalizedTimestamp(entry: SessionEntry, fallback: number): number {
  const parsed = Date.parse(entry.timestamp);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function normalizeMemoryTimestamp(mutation: MemoryMutation, createdAt: number): MemoryMutation {
  if (mutation.operation === "add" || mutation.operation === "supersede") {
    return { ...mutation, createdAt, item: { ...mutation.item, createdAt } };
  }
  return { ...mutation, createdAt };
}

function normalizePinTimestamp(mutation: PinMutation, createdAt: number): PinMutation {
  if (mutation.operation === "add" || mutation.operation === "supersede") {
    return { ...mutation, createdAt, item: { ...mutation.item, createdAt } };
  }
  return { ...mutation, createdAt };
}

export function projectSessionFileMutations(
  sessionFile: string,
  sessionId: string,
): SessionMutationProjection {
  const entries = readJsonlRecords(sessionFile).records.flatMap((record) => {
    const value = record.value;
    if (value.type !== "custom"
      || typeof value.id !== "string"
      || (typeof value.parentId !== "string" && value.parentId !== null)
      || typeof value.timestamp !== "string"
      || typeof value.customType !== "string") {
      return [];
    }
    return [value as unknown as SessionEntry];
  });
  return projectSessionMutations(entries, sessionId);
}

export function projectSessionMutations(
  entries: readonly SessionEntry[],
  sessionId: string,
): SessionMutationProjection {
  const memoryMutations: StoredMemoryMutation[] = [];
  const pinMutations: StoredPinMutation[] = [];
  const warnings: string[] = [];
  const memoryMutationIds = new Set<string>();
  const pinMutationIds = new Set<string>();

  for (let entryOrder = 0; entryOrder < entries.length; entryOrder++) {
    const entry = entries[entryOrder];
    if (!entry || entry.type !== "custom") continue;
    if (entry.customType === MEMORY_CUSTOM_ENTRY_TYPE) {
      const parsed = parseMemoryMutation(entry.data);
      if (!parsed) {
        warnings.push(`Ignored malformed memory custom entry ${entry.id}`);
        continue;
      }
      if (memoryMutationIds.has(parsed.mutationId)) {
        warnings.push(`Ignored duplicate memory mutation ${parsed.mutationId} at ${entry.id}`);
        continue;
      }
      memoryMutationIds.add(parsed.mutationId);
      const createdAt = normalizedTimestamp(entry, parsed.createdAt);
      memoryMutations.push({
        mutationKey: `${sessionId}:${entry.id}`,
        mutationId: parsed.mutationId,
        sessionId,
        createdAt,
        entryOrder,
        payload: normalizeMemoryTimestamp(parsed, createdAt),
      });
      continue;
    }
    if (entry.customType === PIN_CUSTOM_ENTRY_TYPE) {
      const parsed = parsePinMutation(entry.data);
      if (!parsed) {
        warnings.push(`Ignored malformed pin custom entry ${entry.id}`);
        continue;
      }
      if (pinMutationIds.has(parsed.mutationId)) {
        warnings.push(`Ignored duplicate pin mutation ${parsed.mutationId} at ${entry.id}`);
        continue;
      }
      pinMutationIds.add(parsed.mutationId);
      const createdAt = normalizedTimestamp(entry, parsed.createdAt);
      pinMutations.push({
        mutationKey: `${sessionId}:${entry.id}`,
        mutationId: parsed.mutationId,
        sessionId,
        createdAt,
        entryOrder,
        payload: normalizePinTimestamp(parsed, createdAt),
      });
    }
  }

  return { memoryMutations, pinMutations, warnings };
}
