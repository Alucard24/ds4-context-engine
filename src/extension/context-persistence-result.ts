import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { PrivacyClassification } from "ds4-context-core/privacy/privacy-policy";
import {
  CONTEXT_PERSISTENCE_ACTIONS,
  CONTEXT_PERSISTENCE_EGRESS_SENTINEL,
  CONTEXT_PERSISTENCE_RESULT_CONTRACT,
  type ContextPersistenceAction,
  type ContextPersistenceReadAction,
} from "./context-persistence-contract.ts";

export type ContextPersistenceOutcome =
  | "ok"
  | "rejected"
  | "cancelled"
  | "unavailable"
  | "committed"
  | "committed_projection_pending"
  | "indeterminate";

export type ContextPersistenceClass = "read-only" | "canonical-jsonl" | "derived-local-policy";
export type ContextPersistenceKind = "pin" | "memory" | "project-memory-source";
export type PreviewStatus = "included" | "omitted-by-policy";
export type MatchKind = "exact-key" | "exact-phrase" | "all-terms" | "partial-terms" | "metadata-only";

interface ItemBase {
  kind: ContextPersistenceKind;
  targetRevision: string;
}

export interface PinReadItem extends ItemBase {
  id: string;
  kind: "pin";
  scope: "session" | "branch" | "project";
  status: "active" | "superseded" | "deleted";
  classification: PrivacyClassification;
  applicableToActiveBranch: boolean;
  createdAt: number;
  updatedAt: number;
  matchKind?: MatchKind;
  score?: number;
  previewStatus?: PreviewStatus;
}

export interface MemoryReadItem extends ItemBase {
  id: string;
  kind: "memory";
  scope: "session" | "project";
  status: "active" | "superseded" | "invalid" | "expired";
  classification: PrivacyClassification;
  createdAt: number;
  updatedAt: number;
  matchKind?: MatchKind;
  score?: number;
  previewStatus?: PreviewStatus;
}

export interface SourceReadItem extends ItemBase {
  sourceRef: string;
  kind: "project-memory-source";
  status: "ready" | "missing" | "corrupt" | "excluded";
  indexedMutations: number;
  activeProjectMemories: number;
  activeProjectPins: number;
  hasMalformedLines: boolean;
  errorCode?: "source-missing" | "source-corrupt" | "source-malformed";
}

export type ContextPersistenceReadItem = PinReadItem | MemoryReadItem | SourceReadItem;

export interface ContextPersistenceDetails {
  schema: typeof CONTEXT_PERSISTENCE_RESULT_CONTRACT;
  action: ContextPersistenceAction;
  outcome: ContextPersistenceOutcome;
  persistenceClass: ContextPersistenceClass;
  count?: number;
  truncated?: boolean;
  incomplete?: boolean;
  items?: ContextPersistenceReadItem[];
  id?: string;
  sourceRef?: string;
  kind?: ContextPersistenceKind;
  scope?: "session" | "branch" | "project";
  status?: string;
  classification?: PrivacyClassification;
  targetRevision?: string;
  duplicate?: boolean;
  errorCode?: string;
}

export interface ReadResultInput {
  action: ContextPersistenceReadAction;
  items: ContextPersistenceReadItem[];
  truncated: boolean;
  incomplete: boolean;
  previews?: ReadonlyMap<string, string>;
}

const MAX_CONTENT_BYTES = 96 * 1024;
const MAX_DETAILS_BYTES = 64 * 1024;
const MAX_ITEMS = 100;
const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const REVISION = /^rev_[A-Za-z0-9_-]{1,60}$/u;
const SOURCE_REF = /^source_[A-Za-z0-9_-]{22,57}$/u;
const CLASSIFICATIONS = new Set(["normal", "internal", "sensitive", "local-only"]);
const OUTCOMES = new Set<ContextPersistenceOutcome>([
  "ok", "rejected", "cancelled", "unavailable", "committed",
  "committed_projection_pending", "indeterminate",
]);
const PERSISTENCE_CLASSES = new Set<ContextPersistenceClass>([
  "read-only", "canonical-jsonl", "derived-local-policy",
]);
const ACTIONS = new Set<string>(CONTEXT_PERSISTENCE_ACTIONS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function metadataLine(item: ContextPersistenceReadItem): string {
  if (item.kind === "pin") {
    return [
      `pin ${item.id}`,
      `scope=${item.scope}`,
      `status=${item.status}`,
      `classification=${item.classification}`,
      `applicable=${item.applicableToActiveBranch}`,
      `createdAt=${item.createdAt}`,
      `updatedAt=${item.updatedAt}`,
      `revision=${item.targetRevision}`,
      ...(item.matchKind ? [`match=${item.matchKind}`, `score=${item.score ?? 0}`] : []),
    ].join("; ");
  }
  if (item.kind === "memory") {
    return [
      `memory ${item.id}`,
      `scope=${item.scope}`,
      `status=${item.status}`,
      `classification=${item.classification}`,
      `createdAt=${item.createdAt}`,
      `updatedAt=${item.updatedAt}`,
      `revision=${item.targetRevision}`,
      ...(item.matchKind ? [`match=${item.matchKind}`, `score=${item.score ?? 0}`] : []),
    ].join("; ");
  }
  return [
    `project-memory-source ${item.sourceRef}`,
    `status=${item.status}`,
    `indexedMutations=${item.indexedMutations}`,
    `activeProjectMemories=${item.activeProjectMemories}`,
    `activeProjectPins=${item.activeProjectPins}`,
    `hasMalformedLines=${item.hasMalformedLines}`,
    `revision=${item.targetRevision}`,
    ...(item.errorCode ? [`error=${item.errorCode}`] : []),
  ].join("; ");
}

export function renderReadContent(input: ReadResultInput): string {
  const find = input.action === "pins_find" || input.action === "memory_find";
  const noun = find ? "match(es)" : "item(s)";
  const lines = [
    `${input.action}: ${input.items.length} ${noun}; truncated=${input.truncated}; incomplete=${input.incomplete}.`,
  ];
  for (const item of input.items) {
    lines.push(metadataLine(item));
    if (find && item.kind !== "project-memory-source") {
      const preview = input.previews?.get(item.id);
      lines.push(`${item.kind} ${item.id}: ${preview ?? "preview omitted by policy"}`);
    }
  }
  if (input.incomplete) lines.push("Search incomplete; refine the query or use an exact opaque ID.");
  return lines.join("\n");
}

function budgetFailure(
  action: ContextPersistenceAction,
  persistenceClass: ContextPersistenceClass,
): AgentToolResult<ContextPersistenceDetails> {
  const details: ContextPersistenceDetails = {
    schema: CONTEXT_PERSISTENCE_RESULT_CONTRACT,
    action,
    outcome: "unavailable",
    persistenceClass,
    errorCode: "result-budget-exceeded",
  };
  return {
    content: [{ type: "text", text: `${action} unavailable: result-budget-exceeded.` }],
    details,
  };
}

function withinBudget(text: string, details: ContextPersistenceDetails): boolean {
  return Buffer.byteLength(text, "utf8") <= MAX_CONTENT_BYTES
    && Buffer.byteLength(JSON.stringify(details), "utf8") <= MAX_DETAILS_BYTES
    && (details.items?.length ?? 0) <= MAX_ITEMS;
}

export function buildReadResult(input: ReadResultInput): AgentToolResult<ContextPersistenceDetails> {
  const details: ContextPersistenceDetails = {
    schema: CONTEXT_PERSISTENCE_RESULT_CONTRACT,
    action: input.action,
    outcome: "ok",
    persistenceClass: "read-only",
    count: input.items.length,
    truncated: input.truncated,
    incomplete: input.incomplete,
    items: input.items,
  };
  const text = renderReadContent(input);
  if (!withinBudget(text, details)) return budgetFailure(input.action, "read-only");
  return { content: [{ type: "text", text }], details };
}

export interface MutationResultInput {
  action: ContextPersistenceAction;
  outcome: "ok" | "committed" | "committed_projection_pending" | "indeterminate";
  persistenceClass: Exclude<ContextPersistenceClass, "read-only">;
  id?: string;
  sourceRef?: string;
  kind?: ContextPersistenceKind;
  scope?: "session" | "branch" | "project";
  status?: string;
  classification?: PrivacyClassification;
  targetRevision?: string;
  duplicate?: boolean;
  errorCode?: "committed-projection-pending" | "append-indeterminate";
}

function renderMutationContent(details: ContextPersistenceDetails): string {
  if (details.outcome === "committed_projection_pending") {
    return "Canonical mutation committed; projection pending. Do not retry automatically.";
  }
  if (details.outcome === "indeterminate") {
    return "Append outcome indeterminate. Inspect state before retrying.";
  }
  if (details.outcome === "ok" && details.duplicate && details.kind && details.id) {
    return `Existing ${details.kind} ${details.id}; no mutation appended.`;
  }
  if (details.outcome === "committed" && details.persistenceClass === "derived-local-policy" && details.sourceRef) {
    return `Updated derived local policy for ${details.sourceRef}.`;
  }
  if (details.outcome === "committed" && details.kind && details.id) {
    return `Committed ${details.kind} ${details.id}.`;
  }
  return `${details.action} ${details.outcome}${details.errorCode ? `: ${details.errorCode}` : ""}.`;
}

export function buildMutationResult(
  input: MutationResultInput,
): AgentToolResult<ContextPersistenceDetails> {
  const details: ContextPersistenceDetails = {
    schema: CONTEXT_PERSISTENCE_RESULT_CONTRACT,
    action: input.action,
    outcome: input.outcome,
    persistenceClass: input.persistenceClass,
    ...(input.id ? { id: input.id } : {}),
    ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.classification ? { classification: input.classification } : {}),
    ...(input.targetRevision ? { targetRevision: input.targetRevision } : {}),
    ...(input.duplicate !== undefined ? { duplicate: input.duplicate } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  };
  const text = renderMutationContent(details);
  if (!withinBudget(text, details)) return budgetFailure(input.action, input.persistenceClass);
  return { content: [{ type: "text", text }], details };
}

export function buildFailureResult(
  action: ContextPersistenceAction,
  outcome: "rejected" | "cancelled" | "unavailable",
  errorCode?: string,
  persistenceClass: ContextPersistenceClass = "read-only",
): AgentToolResult<ContextPersistenceDetails> {
  const details: ContextPersistenceDetails = {
    schema: CONTEXT_PERSISTENCE_RESULT_CONTRACT,
    action,
    outcome,
    persistenceClass,
    ...(errorCode ? { errorCode } : {}),
  };
  const text = outcome === "cancelled" && !errorCode
    ? `${action} cancelled.`
    : `${action} ${outcome}${errorCode ? `: ${errorCode}` : ""}.`;
  return { content: [{ type: "text", text }], details };
}

function sanitizePinItem(value: unknown): PinReadItem | undefined {
  if (!isRecord(value)
    || value.kind !== "pin"
    || typeof value.id !== "string" || !OPAQUE_ID.test(value.id)
    || (value.scope !== "session" && value.scope !== "branch" && value.scope !== "project")
    || (value.status !== "active" && value.status !== "superseded" && value.status !== "deleted")
    || typeof value.classification !== "string" || !CLASSIFICATIONS.has(value.classification)
    || typeof value.applicableToActiveBranch !== "boolean"
    || !integer(value.createdAt) || !integer(value.updatedAt)
    || typeof value.targetRevision !== "string" || !REVISION.test(value.targetRevision)) return undefined;
  const item: PinReadItem = {
    id: value.id,
    kind: "pin",
    scope: value.scope,
    status: value.status,
    classification: value.classification as PrivacyClassification,
    applicableToActiveBranch: value.applicableToActiveBranch,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    targetRevision: value.targetRevision,
  };
  return copyMatchFields(value, item);
}

function sanitizeMemoryItem(value: unknown): MemoryReadItem | undefined {
  if (!isRecord(value)
    || value.kind !== "memory"
    || typeof value.id !== "string" || !OPAQUE_ID.test(value.id)
    || (value.scope !== "session" && value.scope !== "project")
    || (value.status !== "active" && value.status !== "superseded" && value.status !== "invalid" && value.status !== "expired")
    || typeof value.classification !== "string" || !CLASSIFICATIONS.has(value.classification)
    || !integer(value.createdAt) || !integer(value.updatedAt)
    || typeof value.targetRevision !== "string" || !REVISION.test(value.targetRevision)) return undefined;
  const item: MemoryReadItem = {
    id: value.id,
    kind: "memory",
    scope: value.scope,
    status: value.status,
    classification: value.classification as PrivacyClassification,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    targetRevision: value.targetRevision,
  };
  return copyMatchFields(value, item);
}

function copyMatchFields<T extends PinReadItem | MemoryReadItem>(
  source: Record<string, unknown>,
  item: T,
): T {
  const matchKinds = new Set(["exact-key", "exact-phrase", "all-terms", "partial-terms", "metadata-only"]);
  if (typeof source.matchKind === "string" && matchKinds.has(source.matchKind)
    && integer(source.score) && source.score <= 130
    && (source.previewStatus === "included" || source.previewStatus === "omitted-by-policy")) {
    item.matchKind = source.matchKind as MatchKind;
    item.score = source.score;
    item.previewStatus = source.previewStatus;
  }
  return item;
}

function sanitizeSourceItem(value: unknown): SourceReadItem | undefined {
  if (!isRecord(value)
    || value.kind !== "project-memory-source"
    || typeof value.sourceRef !== "string" || !SOURCE_REF.test(value.sourceRef)
    || (value.status !== "ready" && value.status !== "missing" && value.status !== "corrupt" && value.status !== "excluded")
    || !integer(value.indexedMutations) || !integer(value.activeProjectMemories) || !integer(value.activeProjectPins)
    || typeof value.hasMalformedLines !== "boolean"
    || typeof value.targetRevision !== "string" || !REVISION.test(value.targetRevision)) return undefined;
  const errorCode = value.errorCode === "source-missing"
    || value.errorCode === "source-corrupt"
    || value.errorCode === "source-malformed"
    ? value.errorCode
    : undefined;
  return {
    sourceRef: value.sourceRef,
    kind: "project-memory-source",
    status: value.status,
    indexedMutations: value.indexedMutations,
    activeProjectMemories: value.activeProjectMemories,
    activeProjectPins: value.activeProjectPins,
    hasMalformedLines: value.hasMalformedLines,
    targetRevision: value.targetRevision,
    ...(errorCode ? { errorCode } : {}),
  };
}

/** Reduces historical details to the V1 metadata allowlist. */
export function sanitizeHistoricalContextPersistenceDetails(
  value: unknown,
): ContextPersistenceDetails | undefined {
  if (!isRecord(value)
    || value.schema !== CONTEXT_PERSISTENCE_RESULT_CONTRACT
    || typeof value.action !== "string" || !ACTIONS.has(value.action)
    || typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome as ContextPersistenceOutcome)
    || typeof value.persistenceClass !== "string"
    || !PERSISTENCE_CLASSES.has(value.persistenceClass as ContextPersistenceClass)) return undefined;
  const details: ContextPersistenceDetails = {
    schema: CONTEXT_PERSISTENCE_RESULT_CONTRACT,
    action: value.action as ContextPersistenceAction,
    outcome: value.outcome as ContextPersistenceOutcome,
    persistenceClass: value.persistenceClass as ContextPersistenceClass,
  };
  if (Array.isArray(value.items) && value.items.length <= MAX_ITEMS) {
    details.items = value.items.flatMap((candidate) => {
      const record = isRecord(candidate) ? candidate : undefined;
      const item = record?.kind === "pin"
        ? sanitizePinItem(candidate)
        : record?.kind === "memory"
          ? sanitizeMemoryItem(candidate)
          : sanitizeSourceItem(candidate);
      return item ? [item] : [];
    });
    details.count = details.items.length;
    details.truncated = value.truncated === true;
    details.incomplete = value.incomplete === true;
  }
  if (typeof value.id === "string" && OPAQUE_ID.test(value.id)) details.id = value.id;
  if (typeof value.sourceRef === "string" && SOURCE_REF.test(value.sourceRef)) {
    details.sourceRef = value.sourceRef;
  }
  if (value.kind === "pin" || value.kind === "memory" || value.kind === "project-memory-source") {
    details.kind = value.kind;
  }
  if (value.scope === "session" || value.scope === "branch" || value.scope === "project") {
    details.scope = value.scope;
  }
  if (typeof value.status === "string"
    && /^(?:active|superseded|deleted|invalid|expired|ready|missing|corrupt|excluded)$/u.test(value.status)) {
    details.status = value.status;
  }
  if (typeof value.classification === "string" && CLASSIFICATIONS.has(value.classification)) {
    details.classification = value.classification as PrivacyClassification;
  }
  if (typeof value.targetRevision === "string" && REVISION.test(value.targetRevision)) {
    details.targetRevision = value.targetRevision;
  }
  if (typeof value.errorCode === "string" && /^[a-z0-9-]{1,64}$/u.test(value.errorCode)) {
    details.errorCode = value.errorCode;
  }
  if (typeof value.duplicate === "boolean") details.duplicate = value.duplicate;
  return details;
}

/** Historical provider replay never includes previews, even when the original result did. */
export function renderHistoricalContextPersistenceResult(details: ContextPersistenceDetails | undefined): string {
  if (!details) return CONTEXT_PERSISTENCE_EGRESS_SENTINEL;
  if (details.items && typeof details.count === "number") {
    return renderReadContent({
      action: details.action as ContextPersistenceReadAction,
      items: details.items.map((item) => item.kind === "project-memory-source"
        ? item
        : { ...item, previewStatus: "omitted-by-policy" }),
      truncated: details.truncated === true,
      incomplete: details.incomplete === true,
    });
  }
  if (details.outcome === "cancelled" && !details.errorCode) return `${details.action} cancelled.`;
  return renderMutationContent(details);
}
