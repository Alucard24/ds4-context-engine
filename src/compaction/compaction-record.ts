import type { SummaryValidationStatus } from "./summary-contract.ts";

export type CompactionTrigger = "manual" | "threshold" | "overflow" | "proactive";
export type SummaryLifecycleStatus = "prepared" | "committed" | "failed";

export interface Ds4CompactionMetadata {
  schemaVersion: 1;
  contractVersion: 1;
  summaryId: string;
  sourceHash: string;
  sourceEntryIds: string[];
  validationStatus: SummaryValidationStatus;
  validationIssueCodes: string[];
  firstKeptEntryId: string;
  tokensBefore: number;
  reason: CompactionTrigger;
  isSplitTurn: boolean;
  messageCount: number;
  generatedAt: number;
  provider: string;
  model: string;
}

export interface Ds4CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
  ds4ContextEngine: Ds4CompactionMetadata;
}

export interface SummaryRecord {
  id: string;
  sessionId: string;
  kind: "segment";
  content: string;
  sourceHash: string;
  sourceEntryIds: string[];
  createdAt: number;
  validationStatus: SummaryValidationStatus;
  provider?: string;
  model?: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  reason: CompactionTrigger;
  lifecycleStatus: SummaryLifecycleStatus;
  piCompactionEntryId?: string;
  metadata: Ds4CompactionMetadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function parseDs4CompactionDetails(value: unknown): Ds4CompactionDetails | undefined {
  if (!isRecord(value) || !isRecord(value.ds4ContextEngine)) return undefined;
  const metadata = value.ds4ContextEngine;
  if (
    metadata.schemaVersion !== 1
    || metadata.contractVersion !== 1
    || typeof metadata.summaryId !== "string"
    || typeof metadata.sourceHash !== "string"
    || !stringArray(metadata.sourceEntryIds)
    || !["valid", "warning", "invalid"].includes(String(metadata.validationStatus))
    || !stringArray(metadata.validationIssueCodes)
    || typeof metadata.firstKeptEntryId !== "string"
    || typeof metadata.tokensBefore !== "number"
    || !["manual", "threshold", "overflow", "proactive"].includes(String(metadata.reason))
    || typeof metadata.isSplitTurn !== "boolean"
    || typeof metadata.messageCount !== "number"
    || typeof metadata.generatedAt !== "number"
    || typeof metadata.provider !== "string"
    || typeof metadata.model !== "string"
  ) {
    return undefined;
  }

  return {
    readFiles: stringArray(value.readFiles) ? [...value.readFiles] : [],
    modifiedFiles: stringArray(value.modifiedFiles) ? [...value.modifiedFiles] : [],
    ds4ContextEngine: {
      schemaVersion: 1,
      contractVersion: 1,
      summaryId: metadata.summaryId,
      sourceHash: metadata.sourceHash,
      sourceEntryIds: [...metadata.sourceEntryIds],
      validationStatus: metadata.validationStatus as SummaryValidationStatus,
      validationIssueCodes: [...metadata.validationIssueCodes],
      firstKeptEntryId: metadata.firstKeptEntryId,
      tokensBefore: metadata.tokensBefore,
      reason: metadata.reason as CompactionTrigger,
      isSplitTurn: metadata.isSplitTurn,
      messageCount: metadata.messageCount,
      generatedAt: metadata.generatedAt,
      provider: metadata.provider,
      model: metadata.model,
    },
  };
}
