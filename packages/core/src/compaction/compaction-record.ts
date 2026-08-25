import type { SummaryValidationStatus } from "./summary-contract.ts";

export type CompactionTrigger = "manual" | "threshold" | "overflow" | "proactive";
export type SummaryLifecycleStatus = "prepared" | "committed" | "failed";
export type SummaryKind = "segment" | "aggregate" | "task-state" | "branch";

export interface EmbeddedSummaryNode {
  id: string;
  kind: SummaryKind;
  content: string;
  sourceHash: string;
  sourceEntryIds: string[];
  childSummaryIds: string[];
  graphLevel: number;
  createdAt: number;
  validationStatus: SummaryValidationStatus;
  validationIssueCodes: string[];
  provider?: string;
  model?: string;
}

/**
 * Canonical metadata stored in Pi's CompactionEntry.details.
 *
 * Schema v1 records from M4 are normalized as level-zero segment nodes.
 * Schema v2 adds graph topology plus any nodes created alongside the active
 * summary. The active node content remains CompactionEntry.summary.
 */
export interface Ds4CompactionMetadata {
  schemaVersion: 1 | 2;
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
  summaryKind: SummaryKind;
  childSummaryIds: string[];
  graphLevel: number;
  segmentSummaryId: string;
  embeddedNodes: EmbeddedSummaryNode[];
}

export interface Ds4CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
  ds4ContextEngine: Ds4CompactionMetadata;
}

export interface SummaryRecord {
  id: string;
  sessionId: string;
  kind: SummaryKind;
  content: string;
  sourceHash: string;
  sourceEntryIds: string[];
  childSummaryIds: string[];
  graphLevel: number;
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

function summaryKind(value: unknown): value is SummaryKind {
  return ["segment", "aggregate", "task-state", "branch"].includes(String(value));
}

function validationStatus(value: unknown): value is SummaryValidationStatus {
  return ["valid", "warning", "invalid"].includes(String(value));
}

function parseEmbeddedNode(value: unknown): EmbeddedSummaryNode | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string"
    || !summaryKind(value.kind)
    || typeof value.content !== "string"
    || typeof value.sourceHash !== "string"
    || !stringArray(value.sourceEntryIds)
    || !stringArray(value.childSummaryIds)
    || typeof value.graphLevel !== "number"
    || !Number.isInteger(value.graphLevel)
    || value.graphLevel < 0
    || typeof value.createdAt !== "number"
    || !validationStatus(value.validationStatus)
    || !stringArray(value.validationIssueCodes)
    || (value.provider !== undefined && typeof value.provider !== "string")
    || (value.model !== undefined && typeof value.model !== "string")
  ) {
    return undefined;
  }
  return {
    id: value.id,
    kind: value.kind,
    content: value.content,
    sourceHash: value.sourceHash,
    sourceEntryIds: [...value.sourceEntryIds],
    childSummaryIds: [...value.childSummaryIds],
    graphLevel: value.graphLevel,
    createdAt: value.createdAt,
    validationStatus: value.validationStatus,
    validationIssueCodes: [...value.validationIssueCodes],
    ...(value.provider ? { provider: value.provider } : {}),
    ...(value.model ? { model: value.model } : {}),
  };
}

export function parseDs4CompactionDetails(value: unknown): Ds4CompactionDetails | undefined {
  if (!isRecord(value) || !isRecord(value.ds4ContextEngine)) return undefined;
  const metadata = value.ds4ContextEngine;
  const schemaVersion = metadata.schemaVersion;
  if (
    (schemaVersion !== 1 && schemaVersion !== 2)
    || metadata.contractVersion !== 1
    || typeof metadata.summaryId !== "string"
    || typeof metadata.sourceHash !== "string"
    || !stringArray(metadata.sourceEntryIds)
    || !validationStatus(metadata.validationStatus)
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

  const kind = schemaVersion === 2 ? metadata.summaryKind : "segment";
  const children = schemaVersion === 2 ? metadata.childSummaryIds : [];
  const level = schemaVersion === 2 ? metadata.graphLevel : 0;
  const segmentSummaryId = schemaVersion === 2 ? metadata.segmentSummaryId : metadata.summaryId;
  const rawEmbedded = schemaVersion === 2 ? metadata.embeddedNodes : [];
  if (
    !summaryKind(kind)
    || !stringArray(children)
    || typeof level !== "number"
    || !Number.isInteger(level)
    || level < 0
    || typeof segmentSummaryId !== "string"
    || !Array.isArray(rawEmbedded)
  ) {
    return undefined;
  }
  const embeddedNodes = rawEmbedded.map(parseEmbeddedNode);
  if (embeddedNodes.some((node) => !node)) return undefined;

  return {
    readFiles: stringArray(value.readFiles) ? [...value.readFiles] : [],
    modifiedFiles: stringArray(value.modifiedFiles) ? [...value.modifiedFiles] : [],
    ds4ContextEngine: {
      schemaVersion,
      contractVersion: 1,
      summaryId: metadata.summaryId,
      sourceHash: metadata.sourceHash,
      sourceEntryIds: [...metadata.sourceEntryIds],
      validationStatus: metadata.validationStatus,
      validationIssueCodes: [...metadata.validationIssueCodes],
      firstKeptEntryId: metadata.firstKeptEntryId,
      tokensBefore: metadata.tokensBefore,
      reason: metadata.reason as CompactionTrigger,
      isSplitTurn: metadata.isSplitTurn,
      messageCount: metadata.messageCount,
      generatedAt: metadata.generatedAt,
      provider: metadata.provider,
      model: metadata.model,
      summaryKind: kind,
      childSummaryIds: [...children],
      graphLevel: level,
      segmentSummaryId,
      embeddedNodes: embeddedNodes as EmbeddedSummaryNode[],
    },
  };
}
