import type { MemoryItem, PinItem } from "../memory/memory-types.ts";
import type { PrivacyClassification } from "../privacy/privacy-policy.ts";

export const REBASE_CHECKPOINT_TYPE = "ds4-rebase-checkpoint-v1";
export const REBASE_LINK_TYPE = "ds4-rebase-link-v1";
export interface RebaseCheckpoint {
  schemaVersion: 1;
  id: string;
  sourceSessionId: string;
  sourceLeafId: string;
  sourceSize: number;
  sourceHash: string;
  sourceCompactionCount: number;
  createdAt: number;
  classification: PrivacyClassification;
  handoff: string;
  pins: PinItem[];
  memories: MemoryItem[];
  verificationState: "unknown";
  limitations: string[];
}
export interface RebaseLink {
  schemaVersion: 1;
  operationId: string;
  checkpointId: string;
  checkpointHash: string;
  sourceSessionId: string;
  sourceSessionFile: string;
  sourceLeafId: string;
  sourceSize: number;
  sourceHash: string;
  projectPath: string;
  targetSessionId: string;
}
export type RebasePhase = "Prepared" | "ArchiveVerified" | "CheckpointReady" | "TargetCreated" | "Activated" | "Verified" | "Recoverable" | "Failed";
export interface RebaseOperation {
  schemaVersion: 1;
  id: string;
  phase: RebasePhase;
  projectPath: string;
  sourceSessionId: string;
  sourceSessionFile: string;
  sourceLeafId: string;
  sourceSize: number;
  sourceHash: string;
  targetSessionId: string;
  targetSessionFile: string;
  targetHash?: string;
  targetSize?: number;
  createdAt: number;
  updatedAt: number;
  errorCode?: string;
}
export interface RebaseResult {
  status: "preview" | "verified" | "recoverable" | "unavailable";
  operationId?: string;
  checkpointId?: string;
  sourceEntries?: number;
  sourceBytes?: number;
  checkpointTokens?: number;
  preservedPins?: number;
  preservedMemories?: number;
  phase?: RebasePhase;
  sessionReplaced?: boolean;
  warnings: string[];
}
