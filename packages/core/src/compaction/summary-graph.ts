import { sha256 } from "../shared/hash.ts";
import type {
  CompactionTrigger,
  Ds4CompactionDetails,
  Ds4CompactionMetadata,
  EmbeddedSummaryNode,
  SummaryLifecycleStatus,
  SummaryRecord,
} from "./compaction-record.ts";

export interface CompactionEntryProjection {
  id: string;
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export interface SummaryBoundary {
  firstKeptEntryId: string;
  tokensBefore: number;
  reason: CompactionTrigger;
  isSplitTurn: boolean;
  messageCount: number;
  provider: string;
  model: string;
}

export type SummaryNodeInput = EmbeddedSummaryNode;

export interface CreateSummaryRecordInput {
  sessionId: string;
  node: SummaryNodeInput;
  boundary: SummaryBoundary;
  segmentSummaryId: string;
  lifecycleStatus: SummaryLifecycleStatus;
  embeddedNodes?: readonly EmbeddedSummaryNode[];
  piCompactionEntryId?: string;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function createSummaryMetadata(input: {
  node: SummaryNodeInput;
  boundary: SummaryBoundary;
  segmentSummaryId: string;
  embeddedNodes?: readonly EmbeddedSummaryNode[];
}): Ds4CompactionMetadata {
  return {
    schemaVersion: 2,
    contractVersion: 1,
    summaryId: input.node.id,
    sourceHash: input.node.sourceHash,
    sourceEntryIds: unique(input.node.sourceEntryIds),
    validationStatus: input.node.validationStatus,
    validationIssueCodes: unique(input.node.validationIssueCodes),
    firstKeptEntryId: input.boundary.firstKeptEntryId,
    tokensBefore: input.boundary.tokensBefore,
    reason: input.boundary.reason,
    isSplitTurn: input.boundary.isSplitTurn,
    messageCount: input.boundary.messageCount,
    generatedAt: input.node.createdAt,
    provider: input.node.provider ?? input.boundary.provider,
    model: input.node.model ?? input.boundary.model,
    summaryKind: input.node.kind,
    childSummaryIds: unique(input.node.childSummaryIds),
    graphLevel: input.node.graphLevel,
    segmentSummaryId: input.segmentSummaryId,
    embeddedNodes: (input.embeddedNodes ?? []).map((node) => ({
      ...node,
      sourceEntryIds: unique(node.sourceEntryIds),
      childSummaryIds: unique(node.childSummaryIds),
      validationIssueCodes: unique(node.validationIssueCodes),
    })),
  };
}

export function createSummaryRecord(input: CreateSummaryRecordInput): SummaryRecord {
  const metadata = createSummaryMetadata({
    node: input.node,
    boundary: input.boundary,
    segmentSummaryId: input.segmentSummaryId,
    ...(input.embeddedNodes ? { embeddedNodes: input.embeddedNodes } : {}),
  });
  return {
    id: input.node.id,
    sessionId: input.sessionId,
    kind: input.node.kind,
    content: input.node.content,
    sourceHash: input.node.sourceHash,
    sourceEntryIds: unique(input.node.sourceEntryIds),
    childSummaryIds: unique(input.node.childSummaryIds),
    graphLevel: input.node.graphLevel,
    createdAt: input.node.createdAt,
    validationStatus: input.node.validationStatus,
    ...(input.node.provider ? { provider: input.node.provider } : {}),
    ...(input.node.model ? { model: input.node.model } : {}),
    firstKeptEntryId: input.boundary.firstKeptEntryId,
    tokensBefore: input.boundary.tokensBefore,
    reason: input.boundary.reason,
    lifecycleStatus: input.lifecycleStatus,
    ...(input.piCompactionEntryId ? { piCompactionEntryId: input.piCompactionEntryId } : {}),
    metadata,
  };
}

export function importUntrackedPreviousSummary(input: {
  id: string;
  content: string;
  createdAt: number;
  provider: string;
  model: string;
}): EmbeddedSummaryNode {
  return {
    id: input.id,
    kind: "branch",
    content: input.content,
    sourceHash: sha256(input.content),
    sourceEntryIds: [],
    childSummaryIds: [],
    graphLevel: 0,
    createdAt: input.createdAt,
    validationStatus: "warning",
    validationIssueCodes: ["imported-pi-summary-unverified"],
    provider: input.provider,
    model: input.model,
  };
}

export function recordsFromCompactionEntry(input: {
  sessionId: string;
  entry: CompactionEntryProjection;
  details: Ds4CompactionDetails;
  lifecycleStatus: SummaryLifecycleStatus;
}): SummaryRecord[] {
  const metadata = input.details.ds4ContextEngine;
  const boundary: SummaryBoundary = {
    firstKeptEntryId: input.entry.firstKeptEntryId,
    tokensBefore: input.entry.tokensBefore,
    reason: metadata.reason,
    isSplitTurn: metadata.isSplitTurn,
    messageCount: metadata.messageCount,
    provider: metadata.provider,
    model: metadata.model,
  };
  const embedded = metadata.embeddedNodes.map((node) => createSummaryRecord({
    sessionId: input.sessionId,
    node,
    boundary,
    segmentSummaryId: node.kind === "segment" ? node.id : metadata.segmentSummaryId,
    lifecycleStatus: input.lifecycleStatus,
  }));
  const activeNode: EmbeddedSummaryNode = {
    id: metadata.summaryId,
    kind: metadata.summaryKind,
    content: input.entry.summary,
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
  return [
    ...embedded,
    createSummaryRecord({
      sessionId: input.sessionId,
      node: activeNode,
      boundary,
      segmentSummaryId: metadata.segmentSummaryId,
      lifecycleStatus: input.lifecycleStatus,
      ...(input.lifecycleStatus === "committed" ? { piCompactionEntryId: input.entry.id } : {}),
      embeddedNodes: metadata.embeddedNodes,
    }),
  ];
}
