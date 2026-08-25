import type { PrivacyConfig } from "../config/config.ts";

export const PRIVACY_CLASSIFICATIONS = [
  "normal",
  "internal",
  "sensitive",
  "local-only",
] as const;

export type PrivacyClassification = typeof PRIVACY_CLASSIFICATIONS[number];
export type ProviderDestination = "local" | "remote";

const CLASSIFICATION_RANK: Record<PrivacyClassification, number> = {
  normal: 0,
  internal: 1,
  sensitive: 2,
  "local-only": 3,
};

const STRUCTURAL_KEYS = new Set([
  "api",
  "id",
  "model",
  "name",
  "role",
  "stopreason",
  "stop_reason",
  "toolcallid",
  "tool_call_id",
  "type",
]);

const CONTENT_KEYS = new Set([
  "arguments",
  "content",
  "contents",
  "context",
  "description",
  "input",
  "instructions",
  "messages",
  "metadata",
  "parts",
  "prompt",
  "requestmetadata",
  "system",
  "system_instruction",
  "systeminstruction",
  "systemprompt",
  "text",
  "thinking",
  "toolconfig",
  "tools",
]);

const CLOSED_MARKER = /(?<!\\)\[ds4:(normal|internal|sensitive|local-only)\]([\s\S]*?)(?<!\\)\[\/ds4:\1\]/giu;
const PREFIX_MARKER = /^\s*(?<!\\)\[ds4:(normal|internal|sensitive|local-only)\]\s*/iu;
const ANY_MARKER = /(?<!\\)\[\/?ds4:(?:normal|internal|sensitive|local-only)\]/iu;

export interface ProviderPrivacyPolicy {
  provider: string;
  destination: ProviderDestination;
  allowedClassifications: PrivacyClassification[];
}

export interface PrivacySanitization<T> {
  value: T;
  classification: PrivacyClassification;
  changed: boolean;
  blockedBlocks: number;
  secretRedactions: number;
  inspectedStrings: number;
}

export interface PrivacyExcludedSource {
  kind: "pin" | "memory" | "retrieval" | "project";
  sourceId: string;
  classification: PrivacyClassification;
  reason: string;
}

export interface PrivacyDiagnostics {
  enabled: boolean;
  provider?: string;
  destination?: ProviderDestination;
  allowedClassifications: PrivacyClassification[];
  inspectedMessages: number;
  selectedClassifications: Record<PrivacyClassification, number>;
  blockedBlocks: number;
  excludedSources: number;
  secretRedactions: number;
  providerChecks: number;
  providerPayloadRedactions: number;
  enforcement: "disabled" | "context" | "context-and-provider";
  warnings: string[];
}

interface MutableSanitization {
  classification: PrivacyClassification;
  changed: boolean;
  blockedBlocks: number;
  secretRedactions: number;
  inspectedStrings: number;
}

export function isPrivacyClassification(value: unknown): value is PrivacyClassification {
  return typeof value === "string" && (PRIVACY_CLASSIFICATIONS as readonly string[]).includes(value);
}

export function highestClassification(
  left: PrivacyClassification,
  right: PrivacyClassification,
): PrivacyClassification {
  return CLASSIFICATION_RANK[right] > CLASSIFICATION_RANK[left] ? right : left;
}

export function emptyPrivacyCounts(): Record<PrivacyClassification, number> {
  return { normal: 0, internal: 0, sensitive: 0, "local-only": 0 };
}

export function disabledPrivacyDiagnostics(): PrivacyDiagnostics {
  return {
    enabled: false,
    allowedClassifications: [...PRIVACY_CLASSIFICATIONS],
    inspectedMessages: 0,
    selectedClassifications: emptyPrivacyCounts(),
    blockedBlocks: 0,
    excludedSources: 0,
    secretRedactions: 0,
    providerChecks: 0,
    providerPayloadRedactions: 0,
    enforcement: "disabled",
    warnings: [],
  };
}

function normalizedProvider(value: string): string {
  return value.trim().toLowerCase();
}

export function providerPrivacyPolicy(config: PrivacyConfig, provider: string): ProviderPrivacyPolicy {
  const normalized = normalizedProvider(provider);
  const local = config.localProviders.some((item) => normalizedProvider(item) === normalized);
  if (local) {
    return {
      provider,
      destination: "local",
      allowedClassifications: [...PRIVACY_CLASSIFICATIONS],
    };
  }
  const providerRule = Object.entries(config.remoteProviders)
    .find(([name]) => normalizedProvider(name) === normalized)?.[1];
  return {
    provider,
    destination: "remote",
    allowedClassifications: [...(providerRule ?? config.remoteDefaultAllowed)],
  };
}

function blockedPlaceholder(classification: PrivacyClassification): string {
  return `[DS4 ${classification} content excluded by privacy policy]`;
}

function replaceCount(
  value: string,
  pattern: RegExp,
  replacement: string | ((substring: string, ...args: string[]) => string),
): { value: string; count: number } {
  let count = 0;
  const next = value.replace(pattern, (...args: [string, ...string[]]) => {
    count++;
    return typeof replacement === "string" ? replacement : replacement(...args);
  });
  return { value: next, count };
}

export function redactSecrets(value: string): { value: string; count: number } {
  let current = value;
  let count = 0;
  const apply = (pattern: RegExp, replacement: string | ((substring: string, ...args: string[]) => string)) => {
    const result = replaceCount(current, pattern, replacement);
    current = result.value;
    count += result.count;
  };

  apply(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gu,
    "[DS4 REDACTED PRIVATE KEY]");
  apply(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16})\b/gu,
    "[DS4 REDACTED CREDENTIAL]");
  apply(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu, (_match, prefix) => `${prefix}[DS4 REDACTED TOKEN]`);
  apply(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b(\s*[:=]\s*)(["']?)[^\s,"';}\]]{4,}\3/giu,
    (_match, key, separator, quote) => `${key}${separator}${quote}[DS4 REDACTED SECRET]${quote}`);
  return { value: current, count };
}

function sanitizeSegment(
  text: string,
  classification: PrivacyClassification,
  allowed: ReadonlySet<PrivacyClassification>,
): { value: string; blocked: number } {
  if (allowed.has(classification)) return { value: text, blocked: 0 };
  return { value: blockedPlaceholder(classification), blocked: 1 };
}

export function sanitizeClassifiedText(
  text: string,
  policy: ProviderPrivacyPolicy,
  defaultClassification: PrivacyClassification,
  redactRemoteSecrets: boolean,
): PrivacySanitization<string> {
  if (text.length === 0) {
    return {
      value: text,
      classification: defaultClassification,
      changed: false,
      blockedBlocks: 0,
      secretRedactions: 0,
      inspectedStrings: 1,
    };
  }
  const allowed = new Set(policy.allowedClassifications);
  let classification = defaultClassification;
  let blockedBlocks = 0;
  let output = "";
  let cursor = 0;
  let markerCount = 0;
  CLOSED_MARKER.lastIndex = 0;
  for (const match of text.matchAll(CLOSED_MARKER)) {
    const index = match.index ?? 0;
    const before = text.slice(cursor, index);
    if (before) {
      const sanitized = sanitizeSegment(before, defaultClassification, allowed);
      output += sanitized.value;
      blockedBlocks += sanitized.blocked;
    }
    const markerClassification = match[1]?.toLowerCase() as PrivacyClassification;
    const markedClassification = highestClassification(defaultClassification, markerClassification);
    const markedText = match[2] ?? "";
    classification = highestClassification(classification, markedClassification);
    const sanitized = sanitizeSegment(markedText, markedClassification, allowed);
    output += sanitized.value;
    blockedBlocks += sanitized.blocked;
    cursor = index + match[0].length;
    markerCount++;
  }

  if (markerCount > 0) {
    const remaining = text.slice(cursor);
    if (remaining) {
      const sanitized = sanitizeSegment(remaining, defaultClassification, allowed);
      output += sanitized.value;
      blockedBlocks += sanitized.blocked;
    }
  } else {
    const prefix = PREFIX_MARKER.exec(text);
    if (prefix) {
      const markerClassification = prefix[1]?.toLowerCase() as PrivacyClassification;
      const markedClassification = highestClassification(defaultClassification, markerClassification);
      classification = markedClassification;
      const sanitized = sanitizeSegment(text.slice(prefix[0].length), markedClassification, allowed);
      output = sanitized.value;
      blockedBlocks += sanitized.blocked;
      markerCount = 1;
    } else {
      const sanitized = sanitizeSegment(text, defaultClassification, allowed);
      output = sanitized.value;
      blockedBlocks += sanitized.blocked;
    }
  }

  let secretRedactions = 0;
  if (policy.destination === "remote" && redactRemoteSecrets) {
    const redacted = redactSecrets(output);
    output = redacted.value;
    secretRedactions = redacted.count;
  }
  return {
    value: output,
    classification,
    changed: output !== text || markerCount > 0,
    blockedBlocks,
    secretRedactions,
    inspectedStrings: 1,
  };
}

function markerStructureFloor(value: unknown): PrivacyClassification | undefined {
  const strings: string[] = [];
  const seen = new WeakSet<object>();
  const collect = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      strings.push(candidate);
      return;
    }
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    for (const child of Array.isArray(candidate) ? candidate : Object.values(candidate)) collect(child);
  };
  collect(value);

  const stack: Array<{ classification: PrivacyClassification; stringIndex: number }> = [];
  let floor: PrivacyClassification | undefined;
  const raise = (classification: PrivacyClassification): void => {
    floor = floor ? highestClassification(floor, classification) : classification;
  };
  for (let stringIndex = 0; stringIndex < strings.length; stringIndex++) {
    const text = strings[stringIndex] ?? "";
    const markers = text.matchAll(/(?<!\\)\[(\/?)ds4:(normal|internal|sensitive|local-only)\]/giu);
    for (const marker of markers) {
      const closing = marker[1] === "/";
      const classification = marker[2]?.toLowerCase() as PrivacyClassification;
      if (!closing) {
        if (stack.length > 0) {
          for (const active of stack) raise(active.classification);
          raise(classification);
        }
        stack.push({ classification, stringIndex });
        continue;
      }
      const active = stack.pop();
      if (!active || active.classification !== classification || active.stringIndex !== stringIndex) {
        if (active) raise(active.classification);
        raise(classification);
      }
    }
  }
  for (const active of stack) raise(active.classification);
  return floor;
}

export function classifyMarkedContent(value: unknown): PrivacyClassification | undefined {
  let classification = markerStructureFloor(value);
  const seen = new WeakSet<object>();
  const inspect = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      const markers = candidate.matchAll(/(?<!\\)\[\/?ds4:(normal|internal|sensitive|local-only)\]/giu);
      for (const marker of markers) {
        const found = marker[1]?.toLowerCase() as PrivacyClassification;
        classification = classification
          ? highestClassification(classification, found)
          : found;
      }
      return;
    }
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    for (const child of Array.isArray(candidate) ? candidate : Object.values(candidate)) inspect(child);
  };
  inspect(value);
  return classification;
}

function mergeState(target: MutableSanitization, result: PrivacySanitization<unknown>): void {
  target.classification = highestClassification(target.classification, result.classification);
  target.changed ||= result.changed;
  target.blockedBlocks += result.blockedBlocks;
  target.secretRedactions += result.secretRedactions;
  target.inspectedStrings += result.inspectedStrings;
}

function sanitizeValue(
  value: unknown,
  policy: ProviderPrivacyPolicy,
  config: PrivacyConfig,
  explicitClassification: PrivacyClassification | undefined,
  contentContext: boolean,
  key: string | undefined,
  seen: WeakMap<object, unknown>,
  state: MutableSanitization,
): unknown {
  const normalizedKey = key?.toLowerCase();
  if (typeof value === "string") {
    const hasMarker = ANY_MARKER.test(value);
    if (!contentContext && !hasMarker) return value;
    if (normalizedKey && STRUCTURAL_KEYS.has(normalizedKey) && !hasMarker) return value;
    const result = sanitizeClassifiedText(
      value,
      policy,
      explicitClassification ?? config.defaultClassification,
      config.redactSecrets,
    );
    mergeState(state, result);
    return result.value;
  }
  if (value === null || typeof value !== "object") return value;
  const known = seen.get(value);
  if (known !== undefined) return known;
  if (ArrayBuffer.isView(value)) {
    const classification = explicitClassification ?? config.defaultClassification;
    state.classification = highestClassification(state.classification, classification);
    if (contentContext && !policy.allowedClassifications.includes(classification)) {
      state.changed = true;
      state.blockedBlocks++;
      return new Uint8Array(0);
    }
    return value;
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    value.forEach((item) => output.push(sanitizeValue(
      item,
      policy,
      config,
      explicitClassification,
      contentContext,
      key,
      seen,
      state,
    )));
    return output;
  }
  const output: Record<string, unknown> = {};
  seen.set(value, output);
  let childIndex = 0;
  for (const [childKey, child] of Object.entries(value)) {
    const normalizedChildKey = childKey.toLowerCase();
    const childContent = contentContext || CONTENT_KEYS.has(normalizedChildKey);
    const defaultClassification = explicitClassification ?? config.defaultClassification;
    const dynamicContentKey = contentContext
      && !STRUCTURAL_KEYS.has(normalizedChildKey)
      && !CONTENT_KEYS.has(normalizedChildKey);
    let outputKey = childKey;
    if (ANY_MARKER.test(childKey) || dynamicContentKey) {
      const sanitizedKey = sanitizeClassifiedText(
        childKey,
        policy,
        defaultClassification,
        config.redactSecrets,
      );
      mergeState(state, sanitizedKey);
      outputKey = sanitizedKey.value;
    }
    while (outputKey in output) outputKey = `${outputKey}_${childIndex}`;
    output[outputKey] = sanitizeValue(
      child,
      policy,
      config,
      explicitClassification,
      childContent,
      childKey,
      seen,
      state,
    );
    childIndex++;
  }
  return output;
}

export class PrivacyPolicyEngine {
  constructor(private readonly config: PrivacyConfig) {}

  policy(provider: string): ProviderPrivacyPolicy {
    return providerPrivacyPolicy(this.config, provider);
  }

  sanitizeText(
    text: string,
    provider: string,
    explicitClassification?: PrivacyClassification,
  ): PrivacySanitization<string> {
    if (!this.config.enabled) {
      return {
        value: text,
        classification: explicitClassification ?? this.config.defaultClassification,
        changed: false,
        blockedBlocks: 0,
        secretRedactions: 0,
        inspectedStrings: 0,
      };
    }
    const markerFloor = markerStructureFloor(text);
    const effectiveClassification = explicitClassification
      ?? (markerFloor
        ? highestClassification(this.config.defaultClassification, markerFloor)
        : this.config.defaultClassification);
    return sanitizeClassifiedText(
      text,
      this.policy(provider),
      effectiveClassification,
      this.config.redactSecrets,
    );
  }

  sanitizeMessage<T>(
    message: T,
    provider: string,
    explicitClassification?: PrivacyClassification,
  ): PrivacySanitization<T> {
    if (!this.config.enabled) {
      return {
        value: message,
        classification: explicitClassification ?? this.config.defaultClassification,
        changed: false,
        blockedBlocks: 0,
        secretRedactions: 0,
        inspectedStrings: 0,
      };
    }
    const markerFloor = markerStructureFloor(message);
    const effectiveClassification = explicitClassification
      ?? (markerFloor
        ? highestClassification(this.config.defaultClassification, markerFloor)
        : undefined);
    const state: MutableSanitization = {
      classification: effectiveClassification ?? this.config.defaultClassification,
      changed: false,
      blockedBlocks: 0,
      secretRedactions: 0,
      inspectedStrings: 0,
    };
    const sanitized = sanitizeValue(
      message,
      this.policy(provider),
      this.config,
      effectiveClassification,
      false,
      undefined,
      new WeakMap(),
      state,
    ) as T;
    return { value: sanitized, ...state };
  }

  sanitizeProviderPayload<T>(payload: T, provider: string): PrivacySanitization<T> {
    if (!this.config.enabled) {
      return {
        value: payload,
        classification: this.config.defaultClassification,
        changed: false,
        blockedBlocks: 0,
        secretRedactions: 0,
        inspectedStrings: 0,
      };
    }
    const markerFloor = markerStructureFloor(payload);
    const effectiveClassification = markerFloor
      ? highestClassification(this.config.defaultClassification, markerFloor)
      : undefined;
    const state: MutableSanitization = {
      classification: effectiveClassification ?? this.config.defaultClassification,
      changed: false,
      blockedBlocks: 0,
      secretRedactions: 0,
      inspectedStrings: 0,
    };
    const value = sanitizeValue(
      payload,
      this.policy(provider),
      this.config,
      effectiveClassification,
      false,
      undefined,
      new WeakMap(),
      state,
    ) as T;
    return { value, ...state };
  }
}
