import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  LOCAL_KV_RUNTIME_PORT_VERSION,
  LocalKvReuseController,
  type LocalKvPreparedPrompt,
  type LocalKvReuseDiagnostics,
  type LocalKvRuntimePort,
} from "ds4-context-core/adapter/local-kv";
import {
  RUNTIME_ADAPTER_CONTRACT_VERSION,
  RUNTIME_HISTORY_SCHEMA_VERSION,
  buildCanonicalToolAtomicGroups,
  negotiateRuntimeCapabilities,
  validateRuntimeHistorySnapshot,
  type RuntimeAdapter,
  type RuntimeAdapterDiagnostic,
  type RuntimeAdapterIdentity,
  type RuntimeCapabilityDeclaration,
  type RuntimeCapabilityNegotiation,
  type RuntimeCapabilityRequest,
  type RuntimeCompletionRequest,
  type RuntimeCompletionResult,
  type RuntimeCompletionTransport,
  type RuntimeHistorySnapshot,
  type RuntimePrivacyRequest,
  type RuntimePrivacyResult,
} from "ds4-context-core/adapter/runtime-adapter";
import type { PrivacyConfig } from "ds4-context-core/config/config";
import type { CanonicalMessage } from "ds4-context-core/core/canonical-message";
import type { ModelDescriptor } from "ds4-context-core/core/model-profile";
import { PrivacyPolicyEngine } from "ds4-context-core/privacy/privacy-policy";
import type { EmbeddingPort } from "ds4-context-core/retrieval/embedding";
import { sha256 } from "ds4-context-core/shared/hash";
import { stableStringify } from "ds4-context-core/shared/stable-json";

export const REFERENCE_ADAPTER_VERSION = "0.3.5";
export const REFERENCE_HISTORY_RECORD_TYPE = "ds4-runtime-session-v1";
const DEFAULT_MAX_HISTORY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_HISTORY_MESSAGES = 100_000;
const MAX_DIAGNOSTICS = 100;

export const REFERENCE_ADAPTER_DEFAULT_PRIVACY: PrivacyConfig = {
  enabled: true,
  defaultClassification: "normal",
  localProviders: ["ollama", "llama-cpp", "lmstudio"],
  remoteDefaultAllowed: ["normal", "internal"],
  remoteProviders: {},
  redactSecrets: true,
};

interface ReferenceHistoryHeader {
  type: typeof REFERENCE_HISTORY_RECORD_TYPE;
  runtimeId: string;
  sessionId: string;
  projectRoot: string;
}

interface ReferenceMessageRecord {
  type: "message";
  message: CanonicalMessage;
}

export interface CreateReferenceHistoryInput {
  historyFile: string;
  runtimeId?: string;
  sessionId: string;
  projectRoot: string;
  messages?: readonly CanonicalMessage[];
}

export type ReferenceLocalKvPreparedPrompt = Omit<LocalKvPreparedPrompt, "payload">;

export interface ReferenceLocalKvOptions {
  /** Disabled unless explicitly enabled even when the runtime port is present. */
  enabled?: boolean;
  port: LocalKvRuntimePort;
  runtimeRevision: string;
  modelRevision: string;
  capabilityVersion?: string;
  privacyPolicyVersion?: string;
  /** Extract exact prefix bytes and options from an already-sanitized payload. */
  prepare(sanitizedPayload: unknown): ReferenceLocalKvPreparedPrompt | undefined;
}

export interface ReferenceRuntimeAdapterOptions {
  historyFile: string;
  projectRoot: string;
  model: ModelDescriptor;
  transport: RuntimeCompletionTransport;
  runtimeId?: string;
  privacy?: PrivacyConfig;
  embeddingPort?: EmbeddingPort;
  localKv?: ReferenceLocalKvOptions;
  maxHistoryBytes?: number;
  maxHistoryMessages?: number;
}

interface ParsedReferenceHistory {
  header: ReferenceHistoryHeader;
  raw: string;
  messages: CanonicalMessage[];
}

function canonicalPath(path: string): string {
  return realpathSync.native(resolve(path));
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return selected;
}

function recordLine(value: ReferenceHistoryHeader | ReferenceMessageRecord): string {
  return `${JSON.stringify(value)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validCanonicalMessage(value: unknown): value is CanonicalMessage {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || typeof value.sourceEntryId !== "string"
    || typeof value.role !== "string"
    || !["system", "user", "assistant", "tool", "custom"].includes(value.role)
    || !Array.isArray(value.blocks)
    || !isRecord(value.provenance)
    || !isRecord(value.flags)) return false;
  const provenance = value.provenance;
  if ((provenance.source !== "pi-session" && provenance.source !== "runtime-session")
    || typeof provenance.sessionId !== "string"
    || typeof provenance.entryId !== "string"
    || (provenance.runtimeId !== undefined && typeof provenance.runtimeId !== "string")) return false;
  return value.blocks.every((block) => {
    if (!isRecord(block) || typeof block.type !== "string") return false;
    switch (block.type) {
      case "text": return typeof block.text === "string";
      case "thinking": return typeof block.thinking === "string";
      case "toolCall": return typeof block.id === "string" && typeof block.name === "string";
      case "toolResult":
        return typeof block.toolCallId === "string"
          && typeof block.toolName === "string"
          && typeof block.content === "string"
          && typeof block.isError === "boolean";
      case "image":
        return (block.mimeType === undefined || typeof block.mimeType === "string")
          && (block.data === undefined || typeof block.data === "string");
      case "fileReference": return typeof block.path === "string";
      case "artifactReference": return typeof block.artifactId === "string";
      case "summaryReference": return typeof block.summaryId === "string";
      case "opaqueProvider": return "value" in block;
      default: return false;
    }
  });
}

function referenceSnapshot(input: {
  runtimeId: string;
  sessionId: string;
  projectRoot: string;
  revision: string;
  messages: CanonicalMessage[];
}): RuntimeHistorySnapshot {
  return {
    schemaVersion: RUNTIME_HISTORY_SCHEMA_VERSION,
    runtimeId: input.runtimeId,
    sessionId: input.sessionId,
    revision: input.revision,
    projectRoot: input.projectRoot,
    messages: input.messages,
    toolAtomicGroups: buildCanonicalToolAtomicGroups(input.messages),
  };
}

function assertValidMessages(
  runtimeId: string,
  sessionId: string,
  projectRoot: string,
  messages: readonly CanonicalMessage[],
): void {
  if (!messages.every(validCanonicalMessage)) {
    throw new Error("Reference history contains an invalid canonical message");
  }
  const snapshot = referenceSnapshot({
    runtimeId,
    sessionId,
    projectRoot,
    revision: "pending-write",
    messages: structuredClone([...messages]),
  });
  const issues = validateRuntimeHistorySnapshot(snapshot);
  if (issues.length > 0) {
    throw new Error(`Reference history is invalid: ${[...new Set(issues.map((issue) => issue.code))].join(", ")}`);
  }
}

export function createReferenceHistory(input: CreateReferenceHistoryInput): string {
  const historyFile = resolve(input.historyFile);
  const projectRoot = canonicalPath(input.projectRoot);
  const runtimeId = input.runtimeId?.trim() || "jsonl-reference";
  const sessionId = input.sessionId.trim();
  if (!sessionId) throw new Error("Reference session ID must be non-empty");
  const messages = [...(input.messages ?? [])];
  assertValidMessages(runtimeId, sessionId, projectRoot, messages);
  const header: ReferenceHistoryHeader = {
    type: REFERENCE_HISTORY_RECORD_TYPE,
    runtimeId,
    sessionId,
    projectRoot,
  };
  const serialized = [
    recordLine(header),
    ...messages.map((message) => recordLine({ type: "message", message })),
  ].join("");
  mkdirSync(dirname(historyFile), { recursive: true, mode: 0o700 });
  writeFileSync(historyFile, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    chmodSync(historyFile, 0o600);
  } catch {
    // Permission hardening is best effort on platforms without POSIX modes.
  }
  return historyFile;
}

export function appendReferenceHistoryMessage(
  historyFile: string,
  message: CanonicalMessage,
): void {
  const path = resolve(historyFile);
  const parsed = parseReferenceHistory(path, DEFAULT_MAX_HISTORY_BYTES, DEFAULT_MAX_HISTORY_MESSAGES);
  const projectRoot = canonicalPath(parsed.header.projectRoot);
  if (message.provenance.sessionId !== parsed.header.sessionId
    || message.provenance.runtimeId !== parsed.header.runtimeId) {
    throw new Error("Reference message provenance does not match the canonical session");
  }
  assertValidMessages(
    parsed.header.runtimeId,
    parsed.header.sessionId,
    projectRoot,
    [...parsed.messages, message],
  );
  appendFileSync(path, recordLine({ type: "message", message }), { encoding: "utf8", mode: 0o600 });
}

function parseReferenceHistory(
  path: string,
  maxHistoryBytes: number,
  maxHistoryMessages: number,
): ParsedReferenceHistory {
  const stats = statSync(path);
  if (!stats.isFile() || stats.size <= 0 || stats.size > maxHistoryBytes) {
    throw new Error("Reference history file size is invalid");
  }
  const raw = readFileSync(path, "utf8");
  if (!raw.endsWith("\n")) throw new Error("Reference history has an unterminated final record");
  const lines = raw.slice(0, -1).split("\n");
  const firstLine = lines.shift();
  if (!firstLine) throw new Error("Reference history header is missing");
  let header: ReferenceHistoryHeader;
  try {
    header = JSON.parse(firstLine) as ReferenceHistoryHeader;
  } catch {
    throw new Error("Reference history header is malformed");
  }
  if (header.type !== REFERENCE_HISTORY_RECORD_TYPE
    || typeof header.runtimeId !== "string" || !header.runtimeId.trim()
    || typeof header.sessionId !== "string" || !header.sessionId.trim()
    || typeof header.projectRoot !== "string" || !header.projectRoot.trim()) {
    throw new Error("Reference history header is invalid");
  }
  if (lines.length > maxHistoryMessages) throw new Error("Reference history message limit exceeded");
  const messages = lines.map((line): CanonicalMessage => {
    let record: ReferenceMessageRecord;
    try {
      record = JSON.parse(line) as ReferenceMessageRecord;
    } catch {
      throw new Error("Reference history message record is malformed");
    }
    if (record.type !== "message" || !validCanonicalMessage(record.message)) {
      throw new Error("Reference history message record is invalid");
    }
    return record.message;
  });
  return { header, raw, messages };
}

export class JsonlReferenceRuntimeAdapter implements RuntimeAdapter {
  readonly identity: RuntimeAdapterIdentity;
  readonly embeddingPort?: EmbeddingPort;
  readonly localKvPort?: LocalKvRuntimePort;
  private readonly historyFile: string;
  private readonly projectRoot: string;
  private readonly model: ModelDescriptor;
  private readonly transport: RuntimeCompletionTransport;
  private readonly privacy: PrivacyPolicyEngine;
  private readonly localKvController = new LocalKvReuseController();
  private readonly localKv?: {
    enabled: boolean;
    runtimeRevision: string;
    modelRevision: string;
    capabilityVersion: string;
    privacyPolicyVersion: string;
    prepare(sanitizedPayload: unknown): ReferenceLocalKvPreparedPrompt | undefined;
  };
  private readonly maxHistoryBytes: number;
  private readonly maxHistoryMessages: number;
  private readonly diagnosticEntries: RuntimeAdapterDiagnostic[] = [];
  private cached?: RuntimeHistorySnapshot;
  private closed = false;

  constructor(options: ReferenceRuntimeAdapterOptions) {
    this.historyFile = resolve(options.historyFile);
    this.projectRoot = canonicalPath(options.projectRoot);
    this.model = structuredClone(options.model);
    if (!this.model.provider.trim() || !this.model.id.trim()
      || !Number.isFinite(this.model.contextWindow) || this.model.contextWindow <= 0) {
      throw new Error("Reference adapter model descriptor is invalid");
    }
    this.transport = options.transport;
    const privacyConfig = structuredClone(options.privacy ?? REFERENCE_ADAPTER_DEFAULT_PRIVACY);
    this.privacy = new PrivacyPolicyEngine(privacyConfig);
    if (options.localKv) {
      const runtimeRevision = options.localKv.runtimeRevision.trim();
      const modelRevision = options.localKv.modelRevision.trim();
      const capabilityVersion = (options.localKv.capabilityVersion ?? LOCAL_KV_RUNTIME_PORT_VERSION).trim();
      const privacyPolicyVersion = (options.localKv.privacyPolicyVersion
        ?? sha256(stableStringify(privacyConfig))).trim();
      if (!runtimeRevision || !modelRevision || !capabilityVersion || !privacyPolicyVersion) {
        throw new Error("Reference local KV revisions and versions must be non-empty");
      }
      this.localKvPort = options.localKv.port;
      this.localKv = {
        enabled: options.localKv.enabled === true,
        runtimeRevision,
        modelRevision,
        capabilityVersion,
        privacyPolicyVersion,
        prepare: options.localKv.prepare,
      };
    }
    this.maxHistoryBytes = positiveInteger(options.maxHistoryBytes, DEFAULT_MAX_HISTORY_BYTES, "maxHistoryBytes");
    this.maxHistoryMessages = positiveInteger(
      options.maxHistoryMessages,
      DEFAULT_MAX_HISTORY_MESSAGES,
      "maxHistoryMessages",
    );
    if (options.embeddingPort) this.embeddingPort = options.embeddingPort;
    this.identity = {
      runtimeId: options.runtimeId?.trim() || "jsonl-reference",
      adapterName: "ds4-context-reference-adapter",
      adapterVersion: REFERENCE_ADAPTER_VERSION,
      contractVersion: RUNTIME_ADAPTER_CONTRACT_VERSION,
    };
  }

  capabilityDeclarations(): readonly RuntimeCapabilityDeclaration[] {
    return [
      { id: "compaction", supported: false, reason: "reference JSONL runtime has no native compaction hook" },
      {
        id: "provider-continuation",
        supported: false,
        reason: "reference completion transport exposes no provider continuation handle",
      },
      ...(this.embeddingPort
        ? [{ id: "embeddings" as const, supported: true, version: "embedding-port-v1" }]
        : [{ id: "embeddings" as const, supported: false, reason: "no embedding port was configured" }]),
      ...(this.localKvPort && this.localKv
        ? [{ id: "local-kv-reuse" as const, supported: true, version: this.localKv.capabilityVersion }]
        : [{
          id: "local-kv-reuse" as const,
          supported: false,
          reason: "reference completion transport exposes no local KV state",
        }]),
    ];
  }

  negotiateCapabilities(requested: readonly RuntimeCapabilityRequest[]): RuntimeCapabilityNegotiation {
    return negotiateRuntimeCapabilities(this.capabilityDeclarations(), requested);
  }

  async snapshotHistory(): Promise<RuntimeHistorySnapshot> {
    this.assertOpen();
    let parsed: ParsedReferenceHistory;
    let projectRoot: string;
    try {
      parsed = parseReferenceHistory(this.historyFile, this.maxHistoryBytes, this.maxHistoryMessages);
      projectRoot = canonicalPath(parsed.header.projectRoot);
    } catch {
      this.pushDiagnostic({
        code: "canonical-history-read-failed",
        severity: "error",
        message: "Canonical JSONL history is missing, corrupt, truncated, or outside configured bounds",
      });
      throw new Error("Reference canonical history is unavailable");
    }
    if (parsed.header.runtimeId !== this.identity.runtimeId || projectRoot !== this.projectRoot) {
      this.pushDiagnostic({
        code: "canonical-history-identity-mismatch",
        severity: "error",
        message: "Canonical history identity does not match the trusted adapter configuration",
      });
      throw new Error("Reference canonical history identity mismatch");
    }
    const revision = sha256(parsed.raw);
    if (this.cached?.revision === revision) return structuredClone(this.cached);
    const snapshot = referenceSnapshot({
      runtimeId: parsed.header.runtimeId,
      sessionId: parsed.header.sessionId,
      projectRoot,
      revision,
      messages: parsed.messages,
    });
    const issues = validateRuntimeHistorySnapshot(snapshot);
    if (issues.length > 0) {
      this.pushDiagnostic({
        code: "canonical-history-invalid",
        severity: "error",
        message: `Canonical history validation failed with ${issues.length} issue(s)`,
      });
      throw new Error("Reference canonical history validation failed");
    }
    this.cached = structuredClone(snapshot);
    return structuredClone(snapshot);
  }

  async rebuildDerivedState(): Promise<RuntimeHistorySnapshot> {
    this.assertOpen();
    this.cached = undefined;
    const snapshot = await this.snapshotHistory();
    this.pushDiagnostic({
      code: "derived-state-rebuilt",
      severity: "info",
      message: "Disposable adapter state was rebuilt from canonical JSONL history",
    });
    return snapshot;
  }

  async currentModel(): Promise<ModelDescriptor> {
    this.assertOpen();
    return structuredClone(this.model);
  }

  async trustedProjectRoot(): Promise<string> {
    this.assertOpen();
    return this.projectRoot;
  }

  async enforcePrivacy<T>(request: RuntimePrivacyRequest<T>): Promise<RuntimePrivacyResult<T>> {
    this.assertOpen();
    if (!request.provider.trim()) throw new Error("Privacy provider must be non-empty");
    try {
      const policy = this.privacy.policy(request.provider);
      const sanitized = this.privacy.sanitizeProviderPayload(request.payload, request.provider);
      return {
        provider: request.provider,
        destination: policy.destination,
        payload: sanitized.value,
        changed: sanitized.changed,
        blockedBlocks: sanitized.blockedBlocks,
        secretRedactions: sanitized.secretRedactions,
      };
    } catch {
      this.pushDiagnostic({
        code: "privacy-enforcement-failed",
        severity: "error",
        message: "Privacy enforcement failed closed before completion transport",
      });
      throw new Error("Reference privacy enforcement failed closed");
    }
  }

  async complete<T>(request: RuntimeCompletionRequest<T>): Promise<RuntimeCompletionResult> {
    if (this.closed) {
      return {
        status: "fallback",
        code: "adapter-closed",
        reason: "reference adapter is closed",
        retryable: false,
      };
    }
    if (!request.provider.trim() || !request.model.trim()) {
      this.pushDiagnostic({
        code: "completion-request-invalid",
        severity: "warning",
        message: "Completion request is missing provider or model identity",
      });
      return {
        status: "fallback",
        code: "invalid-request",
        reason: "completion request is invalid",
        retryable: false,
      };
    }

    let sanitized: RuntimePrivacyResult<T>;
    try {
      sanitized = await this.enforcePrivacy({ provider: request.provider, payload: request.payload });
    } catch {
      return {
        status: "fallback",
        code: "privacy-enforcement-failed",
        reason: "privacy enforcement failed closed",
        retryable: false,
      };
    }

    const { payload: _payload, ...privacy } = sanitized;
    if (this.localKv?.enabled && this.localKvPort && sanitized.destination === "local") {
      try {
        const prepared = this.localKv.prepare(structuredClone(sanitized.payload));
        if (prepared) {
          const result = await this.localKvController.complete({
            enabled: true,
            capabilityEnabled: true,
            capabilityVersion: this.localKv.capabilityVersion,
            destination: sanitized.destination,
            runtimeId: this.identity.runtimeId,
            runtimeRevision: this.localKv.runtimeRevision,
            provider: request.provider,
            model: request.model,
            modelRevision: this.localKv.modelRevision,
            privacyPolicyVersion: this.localKv.privacyPolicyVersion,
            promptPrefix: prepared.promptPrefix,
            systemOptions: prepared.systemOptions,
            toolOptions: prepared.toolOptions,
            prefixTokenCount: prepared.prefixTokenCount,
            contextTokenCount: prepared.contextTokenCount,
            payload: sanitized.payload,
          }, this.localKvPort);
          if (result.status === "completed") {
            return {
              status: "completed",
              output: result.output,
              privacy,
              localKv: result.metadata,
            };
          }
        }
      } catch {
        this.pushDiagnostic({
          code: "local-kv-replay-failed",
          severity: "warning",
          capability: "local-kv-reuse",
          message: "Local KV transport failed; completion retried with a full prompt through native transport",
        });
      }
    }

    try {
      const output = await this.transport({
        provider: request.provider,
        model: request.model,
        destination: sanitized.destination,
        payload: sanitized.payload,
      });
      return { status: "completed", output, privacy };
    } catch {
      this.pushDiagnostic({
        code: "completion-transport-failed",
        severity: "warning",
        message: "Completion transport failed; native runtime fallback remains available",
      });
      return {
        status: "fallback",
        code: "transport-failed",
        reason: "completion transport failed",
        retryable: true,
      };
    }
  }

  diagnostics(): readonly RuntimeAdapterDiagnostic[] {
    return this.diagnosticEntries.map((diagnostic) => ({ ...diagnostic }));
  }

  localKvDiagnostics(): LocalKvReuseDiagnostics {
    return this.localKvController.diagnostics();
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cached = undefined;
    try {
      await this.localKvPort?.shutdown?.();
    } catch {
      this.pushDiagnostic({
        code: "local-kv-shutdown-failed",
        severity: "warning",
        capability: "local-kv-reuse",
        message: "Runtime KV shutdown failed after adapter closure",
      });
    }
    this.pushDiagnostic({
      code: "adapter-closed",
      severity: "info",
      message: "Reference adapter lifecycle closed cleanly",
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Reference adapter is closed");
  }

  private pushDiagnostic(diagnostic: RuntimeAdapterDiagnostic): void {
    this.diagnosticEntries.push(diagnostic);
    if (this.diagnosticEntries.length > MAX_DIAGNOSTICS) this.diagnosticEntries.shift();
  }
}
