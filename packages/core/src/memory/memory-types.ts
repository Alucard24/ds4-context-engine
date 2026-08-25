import { isPrivacyClassification, type PrivacyClassification } from "../privacy/privacy-policy.ts";

export const MEMORY_CUSTOM_ENTRY_TYPE = "ds4-context-memory-v1";
export const PIN_CUSTOM_ENTRY_TYPE = "ds4-context-pin-v1";
export const MEMORY_MUTATION_SCHEMA_VERSION = 1;

export type MemoryScope = "session" | "project";
export type MemoryStatus = "active" | "superseded" | "invalid" | "expired";
export type PinScope = "session" | "branch" | "project";
export type PinStatus = "active" | "superseded" | "deleted";

export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  sessionId?: string;
  projectPath?: string;
  key?: string;
  classification?: PrivacyClassification;
  claim: string;
  status: MemoryStatus;
  createdAt: number;
  updatedAt: number;
  originSessionId: string;
  supersededBy?: string;
  statusReason?: string;
  sourceEntryIds: string[];
}

export interface PinItem {
  id: string;
  scope: PinScope;
  sessionId?: string;
  projectPath?: string;
  branchLeafId?: string;
  classification?: PrivacyClassification;
  content: string;
  status: PinStatus;
  createdAt: number;
  updatedAt: number;
  supersededBy?: string;
  statusReason?: string;
  sourceEntryId?: string;
  sourceFile?: string;
}

export interface NewMemoryItem {
  id: string;
  scope: MemoryScope;
  projectPath?: string;
  key?: string;
  classification?: PrivacyClassification;
  claim: string;
  createdAt: number;
  sourceEntryIds: string[];
}

export interface NewPinItem {
  id: string;
  scope: PinScope;
  projectPath?: string;
  branchLeafId?: string;
  classification?: PrivacyClassification;
  content: string;
  createdAt: number;
  sourceEntryId?: string;
  sourceFile?: string;
}

interface MutationBase {
  schemaVersion: 1;
  mutationId: string;
  createdAt: number;
}

export type MemoryMutation =
  | (MutationBase & { operation: "add"; item: NewMemoryItem })
  | (MutationBase & { operation: "supersede"; previousId: string; item: NewMemoryItem })
  | (MutationBase & {
      operation: "status";
      memoryId: string;
      status: "invalid" | "expired";
      reason?: string;
    });

export type PinMutation =
  | (MutationBase & { operation: "add"; item: NewPinItem })
  | (MutationBase & { operation: "supersede"; previousId: string; item: NewPinItem })
  | (MutationBase & {
      operation: "status";
      pinId: string;
      status: "deleted";
      reason?: string;
    });

export interface StoredMemoryMutation {
  mutationKey: string;
  mutationId: string;
  sessionId: string;
  createdAt: number;
  entryOrder: number;
  payload: MemoryMutation;
}

export interface StoredPinMutation {
  mutationKey: string;
  mutationId: string;
  sessionId: string;
  createdAt: number;
  entryOrder: number;
  payload: PinMutation;
}

/** Runtime-neutral projection of canonical memory and pin mutations. */
export interface SessionMutationProjection {
  memoryMutations: StoredMemoryMutation[];
  pinMutations: StoredPinMutation[];
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validBase(value: Record<string, unknown>): boolean {
  return value.schemaVersion === MEMORY_MUTATION_SCHEMA_VERSION
    && typeof value.mutationId === "string"
    && value.mutationId.length > 0
    && typeof value.createdAt === "number"
    && Number.isFinite(value.createdAt);
}

function validNewMemory(value: unknown): value is NewMemoryItem {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && (value.scope === "session" || value.scope === "project")
    && typeof value.claim === "string"
    && typeof value.createdAt === "number"
    && Array.isArray(value.sourceEntryIds)
    && value.sourceEntryIds.every((entryId) => typeof entryId === "string")
    && (value.projectPath === undefined || typeof value.projectPath === "string")
    && (value.key === undefined || typeof value.key === "string")
    && (value.classification === undefined || isPrivacyClassification(value.classification));
}

function validNewPin(value: unknown): value is NewPinItem {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && (value.scope === "session" || value.scope === "branch" || value.scope === "project")
    && typeof value.content === "string"
    && typeof value.createdAt === "number"
    && (value.projectPath === undefined || typeof value.projectPath === "string")
    && (value.branchLeafId === undefined || typeof value.branchLeafId === "string")
    && (value.classification === undefined || isPrivacyClassification(value.classification))
    && (value.sourceEntryId === undefined || typeof value.sourceEntryId === "string")
    && (value.sourceFile === undefined || typeof value.sourceFile === "string");
}

export function parseMemoryMutation(value: unknown): MemoryMutation | undefined {
  if (!isRecord(value) || !validBase(value)) return undefined;
  if (value.operation === "add" && validNewMemory(value.item)) return value as unknown as MemoryMutation;
  if (value.operation === "supersede" && typeof value.previousId === "string" && validNewMemory(value.item)) {
    return value as unknown as MemoryMutation;
  }
  if (value.operation === "status"
    && typeof value.memoryId === "string"
    && (value.status === "invalid" || value.status === "expired")
    && (value.reason === undefined || typeof value.reason === "string")) {
    return value as unknown as MemoryMutation;
  }
  return undefined;
}

export function parsePinMutation(value: unknown): PinMutation | undefined {
  if (!isRecord(value) || !validBase(value)) return undefined;
  if (value.operation === "add" && validNewPin(value.item)) return value as unknown as PinMutation;
  if (value.operation === "supersede" && typeof value.previousId === "string" && validNewPin(value.item)) {
    return value as unknown as PinMutation;
  }
  if (value.operation === "status"
    && typeof value.pinId === "string"
    && value.status === "deleted"
    && (value.reason === undefined || typeof value.reason === "string")) {
    return value as unknown as PinMutation;
  }
  return undefined;
}

export interface MemoryMaterializationResult {
  memories: number;
  pins: number;
  memoryMutations: number;
  pinMutations: number;
  ignoredMutations: number;
  warnings: string[];
}
