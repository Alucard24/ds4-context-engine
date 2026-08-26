import { sha256 } from "../shared/hash.ts";
import { stableStringify } from "../shared/stable-json.ts";

export const LOCAL_KV_ELIGIBILITY_VERSION = "local-kv-eligibility-v1" as const;
export const LOCAL_KV_RUNTIME_PORT_VERSION = "local-kv-runtime-port-v1" as const;
export const LOCAL_KV_DIAGNOSTICS_VERSION = "local-kv-diagnostics-v1" as const;

export type LocalKvIneligibilityReason =
  | "disabled"
  | "capability-unsupported"
  | "non-local-destination"
  | "invalid-provider"
  | "invalid-model"
  | "invalid-model-revision"
  | "invalid-runtime-identity"
  | "invalid-runtime-revision"
  | "invalid-capability-version"
  | "invalid-privacy-policy-version"
  | "invalid-prompt-prefix"
  | "invalid-options"
  | "invalid-token-count";

export interface LocalKvEligibilityInput {
  enabled: boolean;
  capabilityEnabled: boolean;
  capabilityVersion: string;
  destination: "local" | "remote";
  runtimeId: string;
  runtimeRevision: string;
  provider: string;
  model: string;
  modelRevision: string;
  privacyPolicyVersion: string;
  /** Exact provider-ready prefix bytes after privacy enforcement. */
  promptPrefix: string | Uint8Array;
  systemOptions: unknown;
  toolOptions: unknown;
  prefixTokenCount: number;
  /** Full context occupancy; kept separate from prefill savings. */
  contextTokenCount: number;
}

export interface LocalKvEligibilityKey {
  version: typeof LOCAL_KV_ELIGIBILITY_VERSION;
  fingerprint: string;
  prefixHash: string;
  providerModelHash: string;
  optionsHash: string;
  privacyHash: string;
  runtimeHash: string;
}

export type LocalKvEligibilityResult =
  | {
    eligible: true;
    key: LocalKvEligibilityKey;
    prefixTokenCount: number;
    contextTokenCount: number;
  }
  | {
    eligible: false;
    reason: LocalKvIneligibilityReason;
  };

export interface LocalKvPreparedPrompt<T = unknown> {
  /** Exact prefix bytes extracted from the already-sanitized provider payload. */
  promptPrefix: string | Uint8Array;
  payload: T;
  systemOptions: unknown;
  toolOptions: unknown;
  prefixTokenCount: number;
  contextTokenCount: number;
}

export interface LocalKvRuntimeRequest<T = unknown> {
  eligibility: LocalKvEligibilityKey;
  provider: string;
  model: string;
  payload: T;
  prefixTokenCount: number;
  contextTokenCount: number;
}

export type LocalKvReuseAttempt =
  | {
    status: "hit";
    output: unknown;
    savedPrefillTokens: number;
    prefillLatencyMs: number;
  }
  | {
    status: "miss" | "rejected" | "unavailable";
  };

export interface LocalKvFullReplayResult {
  output: unknown;
  prefillTokens: number;
  prefillLatencyMs: number;
}

/**
 * Runtime-owned KV boundary. Cache handles never cross this interface: the
 * implementation maps the eligibility fingerprint to volatile native state.
 */
export interface LocalKvRuntimePort {
  tryReuse(request: LocalKvRuntimeRequest): Promise<LocalKvReuseAttempt>;
  fullReplay(request: LocalKvRuntimeRequest): Promise<LocalKvFullReplayResult>;
  shutdown?(): Promise<void>;
}

export interface LocalKvCompletionInput<T = unknown> extends LocalKvEligibilityInput {
  payload: T;
}

export interface LocalKvCompletionMetadata {
  mode: "hit" | "full-replay";
  prefixTokens: number;
  contextTokens: number;
  savedPrefillTokens: number;
  replayPrefillTokens: number;
  prefillLatencyMs: number;
}

export type LocalKvCompletionResult =
  | {
    status: "completed";
    output: unknown;
    metadata: LocalKvCompletionMetadata;
  }
  | {
    status: "ineligible";
    reason: LocalKvIneligibilityReason;
  };

export interface LocalKvReuseDiagnostics {
  version: typeof LOCAL_KV_DIAGNOSTICS_VERSION;
  requests: number;
  eligibleRequests: number;
  bypassedRequests: number;
  hits: number;
  misses: number;
  rejected: number;
  unavailable: number;
  fullReplays: number;
  transportFailures: number;
  prefixTokens: number;
  contextTokens: number;
  savedPrefillTokens: number;
  replayPrefillTokens: number;
  replayPrefillLatencyMs: number;
}

function identifier(value: unknown, maximum = 256): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertStableOption(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite option number");
    return;
  }
  if (typeof value === "undefined") return;
  if (typeof value !== "object" || value instanceof Uint8Array) {
    throw new Error("unsupported option value");
  }
  if (seen.has(value)) throw new Error("circular option value");
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error("non-plain option object");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const extraKeys = Reflect.ownKeys(value).filter((key) =>
        key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)));
      if (extraKeys.length > 0) throw new Error("unsupported array option property");
      for (const item of value) assertStableOption(item, seen);
    } else {
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") throw new Error("symbol option key");
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new Error("non-data option property");
        }
        assertStableOption(descriptor.value, seen);
      }
    }
  } finally {
    seen.delete(value);
  }
}

function optionsHash(systemOptions: unknown, toolOptions: unknown): string | undefined {
  try {
    const seen = new WeakSet<object>();
    assertStableOption(systemOptions, seen);
    assertStableOption(toolOptions, seen);
    return sha256(stableStringify({ systemOptions, toolOptions }));
  } catch {
    return undefined;
  }
}

export function deriveLocalKvEligibility(input: LocalKvEligibilityInput): LocalKvEligibilityResult {
  if (input.enabled !== true) return { eligible: false, reason: "disabled" };
  if (input.capabilityEnabled !== true) return { eligible: false, reason: "capability-unsupported" };
  if (input.destination !== "local") return { eligible: false, reason: "non-local-destination" };
  if (!identifier(input.provider)) return { eligible: false, reason: "invalid-provider" };
  if (!identifier(input.model)) return { eligible: false, reason: "invalid-model" };
  if (!identifier(input.modelRevision)) return { eligible: false, reason: "invalid-model-revision" };
  if (!identifier(input.runtimeId)) return { eligible: false, reason: "invalid-runtime-identity" };
  if (!identifier(input.runtimeRevision)) return { eligible: false, reason: "invalid-runtime-revision" };
  if (!identifier(input.capabilityVersion, 64)) return { eligible: false, reason: "invalid-capability-version" };
  if (!identifier(input.privacyPolicyVersion)) {
    return { eligible: false, reason: "invalid-privacy-policy-version" };
  }
  const prefixBytes = typeof input.promptPrefix === "string"
    ? new TextEncoder().encode(input.promptPrefix)
    : input.promptPrefix;
  if (!(prefixBytes instanceof Uint8Array) || prefixBytes.byteLength === 0) {
    return { eligible: false, reason: "invalid-prompt-prefix" };
  }
  if (!validTokenCount(input.prefixTokenCount)
    || !validTokenCount(input.contextTokenCount)
    || input.prefixTokenCount > input.contextTokenCount) {
    return { eligible: false, reason: "invalid-token-count" };
  }
  const hashedOptions = optionsHash(input.systemOptions, input.toolOptions);
  if (!hashedOptions) return { eligible: false, reason: "invalid-options" };

  const prefixHash = sha256(prefixBytes);
  const providerModelHash = sha256(stableStringify({
    provider: input.provider,
    model: input.model,
    modelRevision: input.modelRevision,
  }));
  const privacyHash = sha256(stableStringify({
    destination: input.destination,
    privacyPolicyVersion: input.privacyPolicyVersion,
  }));
  const runtimeHash = sha256(stableStringify({
    runtimeId: input.runtimeId,
    runtimeRevision: input.runtimeRevision,
    capabilityVersion: input.capabilityVersion,
  }));
  const fingerprint = sha256(stableStringify({
    version: LOCAL_KV_ELIGIBILITY_VERSION,
    prefixHash,
    providerModelHash,
    optionsHash: hashedOptions,
    privacyHash,
    runtimeHash,
  }));

  return {
    eligible: true,
    key: {
      version: LOCAL_KV_ELIGIBILITY_VERSION,
      fingerprint,
      prefixHash,
      providerModelHash,
      optionsHash: hashedOptions,
      privacyHash,
      runtimeHash,
    },
    prefixTokenCount: input.prefixTokenCount,
    contextTokenCount: input.contextTokenCount,
  };
}

function freshDiagnostics(): LocalKvReuseDiagnostics {
  return {
    version: LOCAL_KV_DIAGNOSTICS_VERSION,
    requests: 0,
    eligibleRequests: 0,
    bypassedRequests: 0,
    hits: 0,
    misses: 0,
    rejected: 0,
    unavailable: 0,
    fullReplays: 0,
    transportFailures: 0,
    prefixTokens: 0,
    contextTokens: 0,
    savedPrefillTokens: 0,
    replayPrefillTokens: 0,
    replayPrefillLatencyMs: 0,
  };
}

function boundedAdd(current: number, increment: number): number {
  if (!Number.isFinite(increment) || increment < 0) return current;
  return Math.min(Number.MAX_SAFE_INTEGER, current + increment);
}

function validLatency(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validReuseAttempt(value: unknown, prefixTokens: number): value is LocalKvReuseAttempt {
  if (!value || typeof value !== "object" || !("status" in value)) return false;
  const attempt = value as Partial<LocalKvReuseAttempt>;
  if (attempt.status === "miss" || attempt.status === "rejected" || attempt.status === "unavailable") return true;
  return attempt.status === "hit"
    && "output" in attempt
    && validTokenCount(attempt.savedPrefillTokens as number)
    && (attempt.savedPrefillTokens as number) <= prefixTokens
    && validLatency(attempt.prefillLatencyMs);
}

function validFullReplay(value: unknown): value is LocalKvFullReplayResult {
  if (!value || typeof value !== "object") return false;
  const replay = value as Partial<LocalKvFullReplayResult>;
  return "output" in replay
    && validTokenCount(replay.prefillTokens as number)
    && validLatency(replay.prefillLatencyMs);
}

/** Volatile aggregate controller; it stores no prompt, fingerprint, or cache handle. */
export class LocalKvReuseController {
  private aggregate = freshDiagnostics();

  diagnostics(): LocalKvReuseDiagnostics {
    return { ...this.aggregate };
  }

  resetDiagnostics(): void {
    this.aggregate = freshDiagnostics();
  }

  async complete<T>(
    input: LocalKvCompletionInput<T>,
    port: LocalKvRuntimePort,
  ): Promise<LocalKvCompletionResult> {
    this.aggregate.requests = boundedAdd(this.aggregate.requests, 1);
    const eligibility = deriveLocalKvEligibility(input);
    if (!eligibility.eligible) {
      this.aggregate.bypassedRequests = boundedAdd(this.aggregate.bypassedRequests, 1);
      return { status: "ineligible", reason: eligibility.reason };
    }

    this.aggregate.eligibleRequests = boundedAdd(this.aggregate.eligibleRequests, 1);
    this.aggregate.prefixTokens = boundedAdd(this.aggregate.prefixTokens, eligibility.prefixTokenCount);
    this.aggregate.contextTokens = boundedAdd(this.aggregate.contextTokens, eligibility.contextTokenCount);
    const runtimeRequest: LocalKvRuntimeRequest<T> = {
      eligibility: eligibility.key,
      provider: input.provider,
      model: input.model,
      payload: input.payload,
      prefixTokenCount: eligibility.prefixTokenCount,
      contextTokenCount: eligibility.contextTokenCount,
    };

    let attempt: LocalKvReuseAttempt = { status: "unavailable" };
    try {
      const candidate = await port.tryReuse(runtimeRequest);
      if (validReuseAttempt(candidate, eligibility.prefixTokenCount)) attempt = candidate;
    } catch {
      // Runtime/cache loss is intentionally indistinguishable from unavailable state.
    }

    if (attempt.status === "hit") {
      this.aggregate.hits = boundedAdd(this.aggregate.hits, 1);
      this.aggregate.savedPrefillTokens = boundedAdd(
        this.aggregate.savedPrefillTokens,
        attempt.savedPrefillTokens,
      );
      return {
        status: "completed",
        output: attempt.output,
        metadata: {
          mode: "hit",
          prefixTokens: eligibility.prefixTokenCount,
          contextTokens: eligibility.contextTokenCount,
          savedPrefillTokens: attempt.savedPrefillTokens,
          replayPrefillTokens: 0,
          prefillLatencyMs: attempt.prefillLatencyMs,
        },
      };
    }

    if (attempt.status === "miss") this.aggregate.misses = boundedAdd(this.aggregate.misses, 1);
    else if (attempt.status === "rejected") this.aggregate.rejected = boundedAdd(this.aggregate.rejected, 1);
    else this.aggregate.unavailable = boundedAdd(this.aggregate.unavailable, 1);
    this.aggregate.fullReplays = boundedAdd(this.aggregate.fullReplays, 1);
    try {
      const replay = await port.fullReplay(runtimeRequest);
      if (!validFullReplay(replay)) throw new Error("local KV runtime returned invalid replay metadata");
      this.aggregate.replayPrefillTokens = boundedAdd(
        this.aggregate.replayPrefillTokens,
        replay.prefillTokens,
      );
      this.aggregate.replayPrefillLatencyMs = boundedAdd(
        this.aggregate.replayPrefillLatencyMs,
        replay.prefillLatencyMs,
      );
      return {
        status: "completed",
        output: replay.output,
        metadata: {
          mode: "full-replay",
          prefixTokens: eligibility.prefixTokenCount,
          contextTokens: eligibility.contextTokenCount,
          savedPrefillTokens: 0,
          replayPrefillTokens: replay.prefillTokens,
          prefillLatencyMs: replay.prefillLatencyMs,
        },
      };
    } catch (error) {
      this.aggregate.transportFailures = boundedAdd(this.aggregate.transportFailures, 1);
      throw error;
    }
  }
}
