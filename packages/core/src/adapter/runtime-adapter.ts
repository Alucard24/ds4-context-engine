import type { CanonicalMessage } from "../core/canonical-message.ts";
import type { ModelDescriptor } from "../core/model-profile.ts";
import type { EmbeddingPort } from "../retrieval/embedding.ts";
import { sha256 } from "../shared/hash.ts";

export const RUNTIME_ADAPTER_CONTRACT_VERSION = "runtime-adapter-v1" as const;
export const RUNTIME_HISTORY_SCHEMA_VERSION = "runtime-history-v1" as const;

export const RUNTIME_CAPABILITY_IDS = [
  "compaction",
  "provider-continuation",
  "embeddings",
  "local-kv-reuse",
] as const;

export type RuntimeCapabilityId = typeof RUNTIME_CAPABILITY_IDS[number];
export type RuntimeDiagnosticSeverity = "info" | "warning" | "error";

export interface RuntimeAdapterIdentity {
  runtimeId: string;
  adapterName: string;
  adapterVersion: string;
  contractVersion: typeof RUNTIME_ADAPTER_CONTRACT_VERSION;
}

export interface RuntimeCapabilityDeclaration {
  id: RuntimeCapabilityId;
  supported: boolean;
  version?: string;
  reason?: string;
}

export interface RuntimeCapabilityRequest {
  id: RuntimeCapabilityId;
  required?: boolean;
}

export interface RuntimeCapabilityStatus extends RuntimeCapabilityDeclaration {
  requested: boolean;
  required: boolean;
  enabled: boolean;
}

export interface RuntimeAdapterDiagnostic {
  code: string;
  severity: RuntimeDiagnosticSeverity;
  message: string;
  capability?: RuntimeCapabilityId;
}

export interface RuntimeCapabilityNegotiation {
  contractVersion: typeof RUNTIME_ADAPTER_CONTRACT_VERSION;
  statuses: RuntimeCapabilityStatus[];
  enabled: RuntimeCapabilityId[];
  disabled: RuntimeCapabilityId[];
  diagnostics: RuntimeAdapterDiagnostic[];
}

export interface RuntimeToolAtomicGroup {
  id: string;
  messageIds: string[];
  toolCallIds: string[];
  complete: boolean;
}

export interface RuntimeHistorySnapshot {
  schemaVersion: typeof RUNTIME_HISTORY_SCHEMA_VERSION;
  runtimeId: string;
  sessionId: string;
  revision: string;
  projectRoot: string;
  messages: CanonicalMessage[];
  toolAtomicGroups: RuntimeToolAtomicGroup[];
}

export interface RuntimeHistoryValidationIssue {
  code: string;
  message: string;
  messageId?: string;
  toolCallId?: string;
}

export interface RuntimePrivacyRequest<T = unknown> {
  provider: string;
  payload: T;
}

export interface RuntimePrivacyResult<T = unknown> {
  provider: string;
  destination: "local" | "remote";
  payload: T;
  changed: boolean;
  blockedBlocks: number;
  secretRedactions: number;
}

export interface RuntimeCompletionRequest<T = unknown> {
  provider: string;
  model: string;
  payload: T;
}

export interface RuntimeCompletionTransportRequest<T = unknown> {
  provider: string;
  model: string;
  destination: "local" | "remote";
  payload: T;
}

export type RuntimeCompletionTransport = (
  request: RuntimeCompletionTransportRequest,
) => Promise<unknown>;

export type RuntimeCompletionResult =
  | {
    status: "completed";
    output: unknown;
    privacy: Omit<RuntimePrivacyResult, "payload">;
  }
  | {
    status: "fallback";
    code: "adapter-closed" | "invalid-request" | "privacy-enforcement-failed" | "transport-failed";
    reason: string;
    retryable: boolean;
  };

/**
 * Runtime-facing DS4 boundary. Implementations own native history conversion,
 * completion transport and lifecycle integration; core owns only this neutral contract.
 */
export interface RuntimeAdapter {
  readonly identity: RuntimeAdapterIdentity;
  readonly embeddingPort?: EmbeddingPort;

  capabilityDeclarations(): readonly RuntimeCapabilityDeclaration[];
  negotiateCapabilities(requested: readonly RuntimeCapabilityRequest[]): RuntimeCapabilityNegotiation;
  snapshotHistory(): Promise<RuntimeHistorySnapshot>;
  rebuildDerivedState(): Promise<RuntimeHistorySnapshot>;
  currentModel(): Promise<ModelDescriptor | undefined>;
  trustedProjectRoot(): Promise<string>;
  enforcePrivacy<T>(request: RuntimePrivacyRequest<T>): Promise<RuntimePrivacyResult<T>>;
  complete<T>(request: RuntimeCompletionRequest<T>): Promise<RuntimeCompletionResult>;
  diagnostics(): readonly RuntimeAdapterDiagnostic[];
  shutdown(): Promise<void>;
}

function capabilityVersion(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && /^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(normalized) ? normalized : undefined;
}

function capabilityReason(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, 240) : undefined;
}

export function negotiateRuntimeCapabilities(
  declarations: readonly RuntimeCapabilityDeclaration[],
  requested: readonly RuntimeCapabilityRequest[],
): RuntimeCapabilityNegotiation {
  const diagnostics: RuntimeAdapterDiagnostic[] = [];
  const declarationMap = new Map<RuntimeCapabilityId, RuntimeCapabilityDeclaration>();
  const duplicateDeclarations = new Set<RuntimeCapabilityId>();
  for (const declaration of declarations) {
    if (declarationMap.has(declaration.id)) duplicateDeclarations.add(declaration.id);
    else declarationMap.set(declaration.id, declaration);
  }

  const requestMap = new Map<RuntimeCapabilityId, RuntimeCapabilityRequest>();
  for (const request of requested) {
    const previous = requestMap.get(request.id);
    requestMap.set(request.id, {
      id: request.id,
      required: previous?.required === true || request.required === true,
    });
  }

  const statuses = RUNTIME_CAPABILITY_IDS.map((id): RuntimeCapabilityStatus => {
    const request = requestMap.get(id);
    const declared = declarationMap.get(id);
    const version = capabilityVersion(declared?.version);
    const declaredReason = capabilityReason(declared?.reason);
    const duplicate = duplicateDeclarations.has(id);
    const invalidSupportedDeclaration = declared?.supported === true && !version;
    const invalidUnsupportedDeclaration = declared?.supported === false && !declaredReason;
    const malformed = duplicate || invalidSupportedDeclaration || invalidUnsupportedDeclaration;
    const supported = declared?.supported === true && !malformed;
    const isRequested = request !== undefined;
    const required = request?.required === true;
    const enabled = isRequested && supported;
    const reason = duplicate
      ? "runtime adapter declared this capability more than once"
      : invalidSupportedDeclaration
        ? "supported capability has a missing or invalid version"
        : invalidUnsupportedDeclaration
          ? "unsupported capability is missing a reason"
          : declaredReason ?? "runtime adapter did not declare this capability";

    if (isRequested && !supported) {
      diagnostics.push({
        code: malformed ? "capability-declaration-invalid" : "capability-unsupported",
        severity: required ? "warning" : "info",
        capability: id,
        message: required
          ? `Required runtime capability ${id} is disabled: ${reason}`
          : `Optional runtime capability ${id} is disabled: ${reason}`,
      });
    }

    return {
      id,
      supported,
      requested: isRequested,
      required,
      enabled,
      ...(version ? { version } : {}),
      ...(!supported ? { reason } : declaredReason ? { reason: declaredReason } : {}),
    };
  });

  return {
    contractVersion: RUNTIME_ADAPTER_CONTRACT_VERSION,
    statuses,
    enabled: statuses.filter((status) => status.enabled).map((status) => status.id),
    disabled: statuses.filter((status) => status.requested && !status.enabled).map((status) => status.id),
    diagnostics,
  };
}

interface ToolRelations {
  calls: Map<string, number[]>;
  results: Map<string, number[]>;
  toolMessageIndices: Set<number>;
}

function canonicalToolRelations(messages: readonly CanonicalMessage[]): ToolRelations {
  const calls = new Map<string, number[]>();
  const results = new Map<string, number[]>();
  const toolMessageIndices = new Set<number>();
  const append = (target: Map<string, number[]>, id: string, index: number): void => {
    const indices = target.get(id) ?? [];
    indices.push(index);
    target.set(id, indices);
  };

  messages.forEach((message, index) => {
    for (const block of message.blocks) {
      if (block.type === "toolCall") {
        append(calls, block.id, index);
        toolMessageIndices.add(index);
      } else if (block.type === "toolResult") {
        append(results, block.toolCallId, index);
        toolMessageIndices.add(index);
      }
    }
  });
  return { calls, results, toolMessageIndices };
}

export function buildCanonicalToolAtomicGroups(
  messages: readonly CanonicalMessage[],
): RuntimeToolAtomicGroup[] {
  const relations = canonicalToolRelations(messages);
  if (relations.toolMessageIndices.size === 0) return [];
  const parents = messages.map((_, index) => index);
  const find = (value: number): number => {
    let root = value;
    while (parents[root] !== root) root = parents[root] ?? root;
    while (parents[value] !== value) {
      const parent = parents[value] ?? value;
      parents[value] = root;
      value = parent;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };

  for (const [toolCallId, callIndices] of relations.calls) {
    const related = [...callIndices, ...(relations.results.get(toolCallId) ?? [])];
    const first = related[0];
    if (first === undefined) continue;
    for (const index of related.slice(1)) union(first, index);
  }

  const components = new Map<number, number[]>();
  for (const index of relations.toolMessageIndices) {
    const root = find(index);
    const indices = components.get(root) ?? [];
    indices.push(index);
    components.set(root, indices);
  }

  return [...components.values()]
    .map((indices): RuntimeToolAtomicGroup => {
      const sortedIndices = [...indices].sort((left, right) => left - right);
      const selected = new Set(sortedIndices);
      const toolCallIds = [...new Set([
        ...[...relations.calls].filter(([, values]) => values.some((index) => selected.has(index))).map(([id]) => id),
        ...[...relations.results].filter(([, values]) => values.some((index) => selected.has(index))).map(([id]) => id),
      ])].sort();
      const complete = toolCallIds.every((id) => {
        const calls = relations.calls.get(id) ?? [];
        const results = relations.results.get(id) ?? [];
        return calls.length === 1
          && results.length > 0
          && calls.every((index) => selected.has(index))
          && results.every((index) => selected.has(index));
      });
      const messageIds = sortedIndices.map((index) => messages[index]?.id ?? "");
      return {
        id: `runtime-tool-group:${sha256(messageIds.join("\0")).slice(0, 16)}`,
        messageIds,
        toolCallIds,
        complete,
      };
    })
    .sort((left, right) => left.messageIds[0]?.localeCompare(right.messageIds[0] ?? "") ?? 0);
}

export function validateRuntimeHistorySnapshot(
  snapshot: RuntimeHistorySnapshot,
): RuntimeHistoryValidationIssue[] {
  const issues: RuntimeHistoryValidationIssue[] = [];
  if (snapshot.schemaVersion !== RUNTIME_HISTORY_SCHEMA_VERSION) {
    issues.push({ code: "history-schema-incompatible", message: "History schema version is incompatible" });
  }
  if (!snapshot.runtimeId.trim() || !snapshot.sessionId.trim() || !snapshot.revision.trim()) {
    issues.push({ code: "history-identity-invalid", message: "History identity fields must be non-empty" });
  }
  if (!snapshot.projectRoot.trim()) {
    issues.push({ code: "trusted-project-root-missing", message: "Trusted project root must be non-empty" });
  }

  const messageIds = new Set<string>();
  for (const message of snapshot.messages) {
    if (!message.id.trim() || messageIds.has(message.id)) {
      issues.push({
        code: messageIds.has(message.id) ? "history-message-id-duplicate" : "history-message-id-missing",
        message: "Canonical message IDs must be non-empty and unique",
        ...(message.id ? { messageId: message.id } : {}),
      });
    }
    messageIds.add(message.id);
    const runtimeProvenanceMismatch = message.provenance.source === "runtime-session"
      && message.provenance.runtimeId !== snapshot.runtimeId;
    if (message.provenance.sessionId !== snapshot.sessionId
      || !message.provenance.entryId.trim()
      || message.sourceEntryId !== message.provenance.entryId
      || runtimeProvenanceMismatch) {
      issues.push({
        code: "history-provenance-invalid",
        message: "Canonical message provenance does not match the snapshot",
        messageId: message.id,
      });
    }
  }

  const relations = canonicalToolRelations(snapshot.messages);
  for (const [toolCallId, callIndices] of relations.calls) {
    if (!toolCallId.trim() || callIndices.length !== 1) {
      issues.push({
        code: "tool-call-identity-invalid",
        message: "Canonical tool call IDs must be non-empty and unique",
        ...(toolCallId ? { toolCallId } : {}),
      });
    }
  }
  for (const toolCallId of relations.results.keys()) {
    if (!toolCallId.trim() || !relations.calls.has(toolCallId)) {
      issues.push({
        code: "tool-result-orphaned",
        message: "Canonical tool results must reference one known tool call",
        ...(toolCallId ? { toolCallId } : {}),
      });
    }
  }

  const expectedGroups = buildCanonicalToolAtomicGroups(snapshot.messages);
  const expectedByTool = new Map<string, RuntimeToolAtomicGroup>();
  for (const group of expectedGroups) {
    for (const toolCallId of group.toolCallIds) expectedByTool.set(toolCallId, group);
  }
  const actualByTool = new Map<string, RuntimeToolAtomicGroup>();
  const groupedMessages = new Set<string>();
  for (const group of snapshot.toolAtomicGroups) {
    if (!group.id.trim() || group.messageIds.length === 0 || group.toolCallIds.length === 0) {
      issues.push({ code: "tool-atomic-group-invalid", message: "Tool atomic groups must have stable IDs and members" });
    }
    for (const messageId of group.messageIds) {
      if (!messageIds.has(messageId) || groupedMessages.has(messageId)) {
        issues.push({
          code: !messageIds.has(messageId) ? "tool-atomic-message-missing" : "tool-atomic-message-overlap",
          message: "Tool atomic group message membership is invalid",
          messageId,
        });
      }
      groupedMessages.add(messageId);
    }
    for (const toolCallId of group.toolCallIds) {
      if (actualByTool.has(toolCallId)) {
        issues.push({
          code: "tool-atomic-call-overlap",
          message: "A tool call belongs to more than one atomic group",
          toolCallId,
        });
      }
      actualByTool.set(toolCallId, group);
    }
  }

  for (const expected of expectedGroups) {
    for (const toolCallId of expected.toolCallIds) {
      const actual = actualByTool.get(toolCallId);
      if (!actual) {
        issues.push({
          code: "tool-atomic-group-missing",
          message: "A canonical tool exchange has no atomic group",
          toolCallId,
        });
        continue;
      }
      const expectedMessages = [...expected.messageIds].sort().join("\0");
      const actualMessages = [...actual.messageIds].sort().join("\0");
      if (expectedMessages !== actualMessages || actual.complete !== expected.complete) {
        issues.push({
          code: "tool-atomic-group-mismatch",
          message: "Tool atomic group does not match canonical call/result relations",
          toolCallId,
        });
      }
    }
  }
  for (const toolCallId of actualByTool.keys()) {
    if (!expectedByTool.has(toolCallId)) {
      issues.push({
        code: "tool-atomic-call-unknown",
        message: "Tool atomic group references an unknown tool call",
        toolCallId,
      });
    }
  }

  return issues;
}
