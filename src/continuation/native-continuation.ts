import type { NativeContinuationConfig } from "../config/config.ts";
import { sha256 } from "../shared/hash.ts";
import { stableStringify } from "../shared/stable-json.ts";

export const NATIVE_CONTINUATION_STRATEGY = "openai-previous-response-v1" as const;

export type NativeContinuationMode =
  | "disabled"
  | "pending"
  | "managed-replay"
  | "native-continuation"
  | "external-continuation";

export type NativeContinuationRetry = "none" | "pending" | "succeeded" | "failed";

export interface NativeContinuationManifest {
  enabled: boolean;
  eligible: boolean;
  strategy: typeof NATIVE_CONTINUATION_STRATEGY;
  providerStorage: "disabled" | "opt-in";
  mode: NativeContinuationMode;
  attempted: boolean;
  stateReused: boolean;
  fullInputItems: number;
  sentInputItems: number;
  omittedInputItems: number;
  retry: NativeContinuationRetry;
  stateAgeMs?: number;
  fallbackReason?: string;
  invalidationReason?: string;
}

export interface NativeContinuationDiagnostics {
  enabled: boolean;
  allowProviderStorage: boolean;
  strategy: typeof NATIVE_CONTINUATION_STRATEGY;
  profiles: string[];
  registeredProviders: string[];
  status: "disabled" | "idle" | "ready" | "continuing" | "fallback" | "error";
  stateAvailable: boolean;
  requests: number;
  fullReplayRequests: number;
  continuationRequests: number;
  continuationSuccesses: number;
  invalidations: number;
  retryAttempts: number;
  retrySuccesses: number;
  retryFailures: number;
  last?: NativeContinuationManifest;
  lastProvider?: string;
  lastModel?: string;
  lastInvalidationReason?: string;
  warnings: string[];
}

export interface NativeContinuationRequest {
  payload: unknown;
  provider: string;
  model: string;
  api?: string;
  requestSessionId?: string;
  canonicalSessionId: string;
  manifestId?: string;
  branchLeafId?: string;
  managed: boolean;
  forceManagedReplay?: boolean;
  retryOfContinuation?: boolean;
  fallbackReason?: string;
}

export interface NativeContinuationAttempt {
  readonly sequence: number;
  readonly key: string;
  readonly manifestId?: string;
  readonly branchLeafId?: string;
  readonly provider: string;
  readonly model: string;
  readonly requestItemHashes: readonly string[];
  readonly requestBodyHash: string;
  readonly fullInputItems: number;
  readonly sentInputItems: number;
  readonly usedContinuation: boolean;
  readonly retryOfContinuation: boolean;
  readonly decision: NativeContinuationManifest;
}

export interface PreparedNativeContinuation {
  payload: unknown;
  tracked: boolean;
  attempt?: NativeContinuationAttempt;
  decision?: NativeContinuationManifest;
}

interface ContinuationState {
  key: string;
  responseId: string;
  requestItemHashes: readonly string[];
  responseItemHashes: readonly string[];
  requestBodyHash: string;
  completedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function profileKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

function stateKey(sessionId: string, provider: string, model: string): string {
  return `${sessionId}\0${provider}\0${model}`;
}

function hashValue(value: unknown): string {
  return sha256(stableStringify(value));
}

function requestBodyHash(payload: Record<string, unknown>): string {
  const { input: _input, previous_response_id: _previousResponseId, ...body } = payload;
  return hashValue({ ...body, store: true });
}

function prefixMatches(current: readonly string[], expected: readonly string[]): boolean {
  if (current.length < expected.length) return false;
  for (let index = 0; index < expected.length; index++) {
    if (current[index] !== expected[index]) return false;
  }
  return true;
}

function cloneManifest(value: NativeContinuationManifest): NativeContinuationManifest {
  return { ...value };
}

export function nativeContinuationProfileMatches(
  profiles: readonly string[],
  provider: string,
  model: string,
): boolean {
  const exact = profileKey(provider, model);
  return profiles.includes(exact) || profiles.includes(`${provider}/*`);
}

export function nativeContinuationProviderIds(profiles: readonly string[]): string[] {
  return [...new Set(profiles.flatMap((profile) => {
    const separator = profile.indexOf("/");
    return separator > 0 ? [profile.slice(0, separator)] : [];
  }))].sort();
}

export function continuationItemHashes(items: readonly unknown[]): string[] {
  return items.map(hashValue);
}

export function disabledNativeContinuationDiagnostics(
  config?: NativeContinuationConfig,
): NativeContinuationDiagnostics {
  return {
    enabled: config?.enabled ?? false,
    allowProviderStorage: config?.allowProviderStorage ?? false,
    strategy: NATIVE_CONTINUATION_STRATEGY,
    profiles: [...(config?.profiles ?? [])],
    registeredProviders: [],
    status: "disabled",
    stateAvailable: false,
    requests: 0,
    fullReplayRequests: 0,
    continuationRequests: 0,
    continuationSuccesses: 0,
    invalidations: 0,
    retryAttempts: 0,
    retrySuccesses: 0,
    retryFailures: 0,
    warnings: [],
  };
}

export class NativeContinuationManager {
  private state?: ContinuationState;
  private sequence = 0;
  private pendingSequence?: number;
  private registeredProviders = new Set<string>();
  private registrationWarnings = new Set<string>();
  private diagnosticsValue: NativeContinuationDiagnostics;

  constructor(
    private readonly config: NativeContinuationConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.diagnosticsValue = disabledNativeContinuationDiagnostics(config);
    this.diagnosticsValue.status = config.enabled ? "idle" : "disabled";
  }

  providerIds(): string[] {
    if (!this.config.enabled || !this.config.allowProviderStorage) return [];
    return nativeContinuationProviderIds(this.config.profiles);
  }

  registerProvider(provider: string): void {
    this.registeredProviders.add(provider);
    this.registrationWarnings.delete(provider);
    this.refreshRegistrationDiagnostics();
  }

  providerRegistrationFailed(provider: string): void {
    this.registrationWarnings.add(provider);
    this.refreshRegistrationDiagnostics();
  }

  private refreshRegistrationDiagnostics(): void {
    this.diagnosticsValue = {
      ...this.diagnosticsValue,
      registeredProviders: [...this.registeredProviders].sort(),
      warnings: [...this.registrationWarnings]
        .sort()
        .map((provider) => `Native continuation provider wrapper unavailable for ${provider}`),
      status: this.registrationWarnings.size > 0
        ? "error"
        : !this.config.enabled
          ? "disabled"
          : this.state
            ? "ready"
            : "idle",
    };
  }

  initialManifest(
    provider: string,
    model: string,
    managed: boolean,
    api = "openai-responses",
  ): NativeContinuationManifest {
    const profileEligible = nativeContinuationProfileMatches(this.config.profiles, provider, model);
    const registered = this.registeredProviders.has(provider);
    const apiEligible = api === "openai-responses";
    const enabled = this.config.enabled && this.config.allowProviderStorage;
    const eligible = enabled && managed && profileEligible && registered && apiEligible;
    return {
      enabled,
      eligible,
      strategy: NATIVE_CONTINUATION_STRATEGY,
      providerStorage: enabled ? "opt-in" : "disabled",
      mode: eligible ? "pending" : enabled ? "managed-replay" : "disabled",
      attempted: false,
      stateReused: false,
      fullInputItems: 0,
      sentInputItems: 0,
      omittedInputItems: 0,
      retry: "none",
      ...(!eligible ? {
        fallbackReason: !enabled
          ? "disabled"
          : !managed
            ? "managed-context-required"
            : !profileEligible
              ? "profile-not-enabled"
              : !apiEligible
                ? "openai-responses-api-required"
                : "provider-wrapper-unavailable",
      } : {}),
    };
  }

  prepare(request: NativeContinuationRequest): PreparedNativeContinuation {
    if (request.requestSessionId !== request.canonicalSessionId) {
      return { payload: request.payload, tracked: false };
    }

    const initial = this.initialManifest(
      request.provider,
      request.model,
      request.managed,
      request.api,
    );
    if (!initial.eligible) {
      this.recordDecision(initial, request.provider, request.model);
      return { payload: request.payload, tracked: true, decision: initial };
    }

    this.diagnosticsValue.requests++;
    if (!isRecord(request.payload)
      || !Array.isArray(request.payload.input)
      || request.payload.model !== request.model
      || request.payload.stream !== true) {
      const decision: NativeContinuationManifest = {
        ...initial,
        mode: "managed-replay",
        fallbackReason: "unsupported-provider-payload",
      };
      this.recordDecision(decision, request.provider, request.model, "fallback");
      return { payload: request.payload, tracked: true, decision };
    }

    const existingContinuation = request.payload.previous_response_id;
    if (typeof existingContinuation === "string" && existingContinuation.length > 0) {
      this.invalidateState("external-continuation-detected");
      const decision: NativeContinuationManifest = {
        ...initial,
        mode: "external-continuation",
        fallbackReason: "provider-payload-already-continued",
      };
      this.recordDecision(decision, request.provider, request.model, "fallback");
      return { payload: request.payload, tracked: true, decision };
    }

    const { previous_response_id: _previousResponseId, ...payloadWithoutContinuation } = request.payload;
    const fullPayload: Record<string, unknown> = {
      ...payloadWithoutContinuation,
      input: request.payload.input,
      store: true,
    };
    const itemHashes = continuationItemHashes(request.payload.input);
    const bodyHash = requestBodyHash(fullPayload);
    const key = stateKey(request.canonicalSessionId, request.provider, request.model);
    let invalidationReason: string | undefined;
    let stateAgeMs: number | undefined;
    let deltaStart: number | undefined;

    if (request.forceManagedReplay) {
      invalidationReason = this.invalidateState(request.fallbackReason ?? "forced-managed-replay");
    } else if (this.state) {
      if (this.state.key !== key) {
        invalidationReason = this.invalidateState("continuation-identity-changed");
      } else {
        stateAgeMs = Math.max(0, this.now() - this.state.completedAt);
        if (stateAgeMs > this.config.maxStateAgeMs) {
          invalidationReason = this.invalidateState("continuation-state-expired");
        } else if (this.state.requestBodyHash !== bodyHash) {
          invalidationReason = this.invalidateState("provider-request-options-changed");
        } else {
          const baseline = [
            ...this.state.requestItemHashes,
            ...this.state.responseItemHashes,
          ];
          if (!prefixMatches(itemHashes, baseline)) {
            invalidationReason = this.invalidateState("managed-context-prefix-changed");
          } else if (itemHashes.length === baseline.length) {
            invalidationReason = this.invalidateState("continuation-delta-empty");
          } else {
            deltaStart = baseline.length;
          }
        }
      }
    }

    const usedContinuation = deltaStart !== undefined && this.state !== undefined;
    const sentInput = usedContinuation
      ? request.payload.input.slice(deltaStart)
      : request.payload.input;
    const sentPayload: Record<string, unknown> = usedContinuation
      ? {
          ...fullPayload,
          input: sentInput,
          previous_response_id: this.state!.responseId,
        }
      : fullPayload;
    const retry = request.retryOfContinuation ? "pending" : "none";
    const fallbackReason = usedContinuation
      ? undefined
      : request.fallbackReason
        ?? invalidationReason
        ?? "continuation-cold-start";
    const decision: NativeContinuationManifest = {
      ...initial,
      mode: usedContinuation ? "native-continuation" : "managed-replay",
      attempted: usedContinuation || Boolean(request.retryOfContinuation),
      stateReused: usedContinuation,
      fullInputItems: request.payload.input.length,
      sentInputItems: sentInput.length,
      omittedInputItems: request.payload.input.length - sentInput.length,
      retry,
      ...(stateAgeMs !== undefined ? { stateAgeMs } : {}),
      ...(fallbackReason ? { fallbackReason } : {}),
      ...(invalidationReason ? { invalidationReason } : {}),
    };
    const attempt: NativeContinuationAttempt = {
      sequence: ++this.sequence,
      key,
      ...(request.manifestId ? { manifestId: request.manifestId } : {}),
      ...(request.branchLeafId ? { branchLeafId: request.branchLeafId } : {}),
      provider: request.provider,
      model: request.model,
      requestItemHashes: itemHashes,
      requestBodyHash: bodyHash,
      fullInputItems: request.payload.input.length,
      sentInputItems: sentInput.length,
      usedContinuation,
      retryOfContinuation: Boolean(request.retryOfContinuation),
      decision,
    };
    this.pendingSequence = attempt.sequence;
    if (!usedContinuation) this.state = undefined;
    if (usedContinuation) this.diagnosticsValue.continuationRequests++;
    else this.diagnosticsValue.fullReplayRequests++;
    this.recordDecision(
      decision,
      request.provider,
      request.model,
      usedContinuation ? "continuing" : "fallback",
    );
    return { payload: sentPayload, tracked: true, attempt, decision };
  }

  beginManagedReplayRetry(attempt: NativeContinuationAttempt): void {
    if (!attempt.usedContinuation) return;
    this.diagnosticsValue.retryAttempts++;
    this.invalidateState("provider-rejected-continuation");
  }

  complete(
    attempt: NativeContinuationAttempt,
    responseId: string | undefined,
    responseItemHashes: readonly string[],
  ): NativeContinuationManifest {
    if (this.pendingSequence !== attempt.sequence) return cloneManifest(attempt.decision);
    this.pendingSequence = undefined;
    const normalizedResponseId = responseId?.trim();
    if (!normalizedResponseId || responseItemHashes.length === 0) {
      const reason = !normalizedResponseId ? "provider-response-id-missing" : "provider-response-items-missing";
      this.invalidateState(reason);
      if (attempt.retryOfContinuation) this.diagnosticsValue.retryFailures++;
      const decision: NativeContinuationManifest = {
        ...attempt.decision,
        mode: "managed-replay",
        stateReused: false,
        retry: attempt.retryOfContinuation ? "failed" : attempt.decision.retry,
        fallbackReason: reason,
        invalidationReason: reason,
      };
      this.recordDecision(decision, attempt.provider, attempt.model, "fallback");
      return decision;
    }

    this.state = {
      key: attempt.key,
      responseId: normalizedResponseId,
      requestItemHashes: [...attempt.requestItemHashes],
      responseItemHashes: [...responseItemHashes],
      requestBodyHash: attempt.requestBodyHash,
      completedAt: this.now(),
    };
    if (attempt.usedContinuation) this.diagnosticsValue.continuationSuccesses++;
    if (attempt.retryOfContinuation) this.diagnosticsValue.retrySuccesses++;
    const decision: NativeContinuationManifest = {
      ...attempt.decision,
      retry: attempt.retryOfContinuation ? "succeeded" : attempt.decision.retry,
    };
    this.recordDecision(decision, attempt.provider, attempt.model, "ready");
    return decision;
  }

  fail(attempt: NativeContinuationAttempt, reason: string): NativeContinuationManifest {
    if (this.pendingSequence === attempt.sequence) this.pendingSequence = undefined;
    this.invalidateState(reason);
    if (attempt.retryOfContinuation) this.diagnosticsValue.retryFailures++;
    const decision: NativeContinuationManifest = {
      ...attempt.decision,
      mode: attempt.usedContinuation ? "native-continuation" : "managed-replay",
      retry: attempt.retryOfContinuation ? "failed" : attempt.decision.retry,
      fallbackReason: reason,
      invalidationReason: reason,
    };
    this.recordDecision(decision, attempt.provider, attempt.model, "fallback");
    return decision;
  }

  invalidate(reason: string): void {
    this.pendingSequence = undefined;
    this.invalidateState(reason);
  }

  shouldRetryManagedReplay(): boolean {
    return this.config.retryManagedReplay;
  }

  diagnostics(): NativeContinuationDiagnostics {
    return {
      ...this.diagnosticsValue,
      profiles: [...this.diagnosticsValue.profiles],
      registeredProviders: [...this.diagnosticsValue.registeredProviders],
      ...(this.diagnosticsValue.last ? { last: cloneManifest(this.diagnosticsValue.last) } : {}),
      warnings: [...this.diagnosticsValue.warnings],
      stateAvailable: Boolean(this.state),
    };
  }

  private invalidateState(reason: string): string | undefined {
    const hadState = Boolean(this.state);
    this.state = undefined;
    if (hadState) this.diagnosticsValue.invalidations++;
    this.diagnosticsValue.lastInvalidationReason = reason;
    this.diagnosticsValue.stateAvailable = false;
    return hadState ? reason : undefined;
  }

  private recordDecision(
    decision: NativeContinuationManifest,
    provider: string,
    model: string,
    status?: NativeContinuationDiagnostics["status"],
  ): void {
    this.diagnosticsValue = {
      ...this.diagnosticsValue,
      enabled: this.config.enabled,
      allowProviderStorage: this.config.allowProviderStorage,
      status: status ?? this.diagnosticsValue.status,
      stateAvailable: Boolean(this.state),
      last: cloneManifest(decision),
      lastProvider: provider,
      lastModel: model,
    };
  }
}
