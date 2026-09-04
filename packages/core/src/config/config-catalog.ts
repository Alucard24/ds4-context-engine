import {
  COMPACTION_THINKING_LEVELS,
  type Ds4ContextConfig,
} from "./config.ts";
import {
  PRIVACY_CLASSIFICATIONS,
  isPrivacyClassification,
} from "../privacy/privacy-policy.ts";

/**
 * Machine-readable catalog of every configuration key accepted by the
 * `ds4-context-config-v1` schema. It powers the `/context config` command:
 * value display, type-safe editing, and clear rejection messages.
 */
export type ConfigFieldKind =
  | "boolean"
  | "integer"
  | "number"
  | "string"
  | "enum"
  | "string-array"
  | "enum-array"
  | "classification-map"
  | "object-map"
  | "object";

export interface ConfigFieldDoc {
  path: string;
  kind: ConfigFieldKind;
  description: string;
  /** For `enum` and `enum-array`: the allowed values. */
  values?: readonly string[];
  /** Fields absent from the default configuration (added by user JSON only). */
  optional?: boolean;
}

function field(
  path: string,
  kind: ConfigFieldKind,
  description: string,
  optional = false,
  values?: readonly string[],
): ConfigFieldDoc {
  return values ? { path, kind, description, values, optional } : { path, kind, description, optional };
}

const CLASSIFICATIONS = PRIVACY_CLASSIFICATIONS as readonly string[];

export const CONFIG_FIELD_DOCS: readonly ConfigFieldDoc[] = [
  field("enabled", "boolean", "Master switch for the DS4 managed context extension.", false),
  field("context.mode", "enum", "observer records only; managed plans and rewrites the context.", false, ["observer", "managed"]),
  field("context.targetFillRatio", "number", "Proactive compaction trigger: usage / target ratio.", false),
  field("context.softLimitRatio", "number", "Soft budget ratio where compaction becomes eligible.", false),
  field("context.hardLimitRatio", "number", "Hard budget ratio before the context overflows.", false),
  field("context.minimumOutputReserve", "integer", "Minimum output tokens reserved for the model.", false),
  field("context.preferredOutputReserve", "integer", "Preferred output reserve when planning the context.", false),
  field("context.recentTailTokens", "integer", "Recent verbatim tail preserved during compaction.", false),
  field("context.maxPinnedTokens", "integer", "Budget cap for pinned context in managed mode.", false),
  field("context.maxMemoryTokens", "integer", "Budget cap for durable memory in managed mode.", false),
  field("context.maxRetrievedHistoryTokens", "integer", "Budget cap for historical retrieval evidence.", false),
  field("context.maxProjectTokens", "integer", "Budget cap for project knowledge snippets.", false),
  field("context.maxSummaryTokens", "integer", "Budget cap for active compaction summaries.", false),

  field("compaction.enabled", "boolean", "Enable DS4 custom compaction; false falls back to Pi default compaction.", false),
  field("compaction.mode", "enum", "Compaction strategy (only hierarchical).", false, ["hierarchical"]),
  field("compaction.validate", "boolean", "Deterministic summary validation; false emits validation-disabled warning only.", false),
  field("compaction.segmentTargetTokens", "integer", "Target size of each compaction segment; higher means fewer segment calls.", false),
  field("compaction.preserveRecentVerbatim", "boolean", "Must remain true for non-destructive compaction.", false),
  field("compaction.model", "object", "Dedicated seed server model for compaction summary generation (JSON object {provider,id}).", true),
  field("compaction.model.provider", "string", "Provider name of the dedicated compaction model, as registered in Pi.", true),
  field("compaction.model.id", "string", "Model id of the dedicated compaction model, as registered in Pi.", true),
  field("compaction.summary", "object", "Summary request controls (JSON object {thinking}).", true),
  field("compaction.summary.thinking", "enum", "Reasoning level for compaction summary requests only; off preserves the legacy request.", true, COMPACTION_THINKING_LEVELS),
  field("compaction.transport", "object", "Transport retry policy for summary requests (JSON object {maxAttempts,baseDelayMs}).", false),
  field("compaction.transport.maxAttempts", "integer", "Total attempts for transport failures; default 3 (mirrors Pi).", false),
  field("compaction.transport.baseDelayMs", "integer", "Base backoff ms, doubled per attempt; default 2000 (mirrors Pi).", false),

  field("retrieval.exact", "boolean", "Exact-match retrieval over historical messages.", false),
  field("retrieval.fts", "boolean", "FTS5 retrieval over the session projection.", false),
  field("retrieval.semantic", "boolean", "Opt-in hybrid vector candidate generation.", false),
  field("retrieval.maxResults", "integer", "Maximum retrieved historical items per turn.", false),
  field("retrieval.embedding.mode", "enum", "local uses the built-in feature hash; remote requires exact consent profiles.", false, ["local", "remote"]),
  field("retrieval.embedding.provider", "string", "Embedding provider identifier.", false),
  field("retrieval.embedding.model", "string", "Embedding model identifier.", false),
  field("retrieval.embedding.dimensions", "integer", "Embedding vector dimensions.", false),
  field("retrieval.embedding.remoteProfiles", "string-array", "Exact provider/model consent profiles for remote embedding (JSON array).", false),
  field("retrieval.embedding.maxSources", "integer", "Maximum source entries considered per embedding run.", false),
  field("retrieval.embedding.candidatePool", "integer", "Candidate pool size for semantic ranking.", false),
  field("retrieval.embedding.batchSize", "integer", "Batch size for embedding calls.", false),
  field("retrieval.embedding.queryCacheSize", "integer", "Embedding query cache entries.", false),
  field("retrieval.embedding.timeoutMs", "integer", "Per-call embedding timeout in milliseconds.", false),

  field("project.enabled", "boolean", "Enable project knowledge indexing and snippet retrieval.", false),
  field("project.maxFiles", "integer", "Maximum indexed project files.", false),
  field("project.maxFileBytes", "integer", "Maximum indexed bytes per file.", false),
  field("project.maxTotalBytes", "integer", "Maximum total indexed bytes.", false),
  field("project.snippetLines", "integer", "Lines per project snippet.", false),
  field("project.snippetOverlapLines", "integer", "Overlap lines between consecutive snippets.", false),
  field("project.maxResults", "integer", "Maximum project snippets per turn.", false),

  field("memory.enabled", "boolean", "Enable Pin and Durable Memory projection.", false),
  field("memory.crossSession", "boolean", "Opt-in replay of project-scoped mutations from sibling Pi sessions.", false),
  field("memory.maxProjectSessions", "integer", "Maximum canonical project session files inspected per refresh.", false),
  field("memory.maxPinChars", "integer", "Maximum characters per pin claim.", false),
  field("memory.maxClaimChars", "integer", "Maximum characters per memory claim.", false),
  field("memory.maxResults", "integer", "Maximum items returned by pins/memory list actions.", false),

  field("artifacts.enabled", "boolean", "Enable large tool result artifact offload.", false),
  field("artifacts.maxInlineToolResultChars", "integer", "Characters kept inline before offload is considered.", false),
  field("artifacts.maxArtifactBytes", "integer", "Maximum bytes stored per artifact.", false),
  field("artifacts.maxSearchBytes", "integer", "Maximum bytes scanned per artifact search.", false),
  field("artifacts.excerptChars", "integer", "Excerpt characters returned by artifact search.", false),
  field("artifacts.maxSearchMatches", "integer", "Maximum matches returned by artifact search.", false),
  field("artifacts.storeLargeOutputs", "boolean", "Persist offloaded artifacts to the artifact store.", false),

  field("privacy.enabled", "boolean", "Enable privacy policy enforcement for outbound content.", false),
  field("privacy.defaultClassification", "enum", "Default classification for content without explicit classification.", false, CLASSIFICATIONS),
  field("privacy.localProviders", "string-array", "Provider names treated as local-only (JSON array).", false),
  field("privacy.remoteDefaultAllowed", "enum-array", "Classifications allowed by default to remote providers (JSON array).", false, CLASSIFICATIONS),
  field("privacy.remoteProviders", "classification-map", "Per-provider allowed classifications (JSON object provider -> array).", true),
  field("privacy.redactSecrets", "boolean", "Redact detected secrets even when privacy.enabled is false.", false),

  field("modelAwareness.enabled", "boolean", "Enable per-provider token calibration.", false),
  field("modelAwareness.calibrationWindow", "integer", "Accepted calibration samples retained per profile.", false),
  field("modelAwareness.minimumCalibrationSamples", "integer", "Samples required before calibration is applied.", false),
  field("modelAwareness.calibrationRatioLowerBound", "number", "Lower bound of the applied calibration ratio.", false),
  field("modelAwareness.calibrationRatioUpperBound", "number", "Upper bound of the applied calibration ratio.", false),
  field("modelAwareness.overrides", "object-map", "Explicit profile overrides (JSON object provider/model -> field map).", true),

  field("nativeContinuation.enabled", "boolean", "Enable native provider continuation when supported.", false),
  field("nativeContinuation.allowProviderStorage", "boolean", "Acknowledge store:true for eligible Responses API calls.", false),
  field("nativeContinuation.profiles", "string-array", "Exact provider/model or provider/* continuation profiles (JSON array).", false),
  field("nativeContinuation.maxStateAgeMs", "integer", "Maximum age of continuation state in milliseconds.", false),
  field("nativeContinuation.retryManagedReplay", "boolean", "Retry managed replay after a continuation transport failure.", false),

  field("localKvReuse.enabled", "boolean", "Opt-in local KV reuse; also requires the runtime capability.", false),

  field("quality.enabled", "boolean", "Opt-in metadata-only quality sampling.", false),
  field("quality.maxSamples", "integer", "Bounded number of disposable quality samples retained.", false),

  field("ranking.mode", "enum", "off preserves the static ranker; shadow compares; active requires a promoted model.", false, ["off", "shadow", "active"]),
  field("ranking.modelPath", "string", "Learned ranking model path (absolute, ~-relative, or agent-dir relative).", false),
  field("ranking.minimumTrainingSamples", "integer", "Minimum classified labels before local training.", false),
  field("ranking.maxTrainingSamples", "integer", "Maximum feedback entries inspected per training run.", false),
  field("ranking.maxLatencyMs", "integer", "Promotion-gate p95 budget for learned inference.", false),

  field("diagnostics.storeContextManifest", "boolean", "Persist context manifests to the DS4 database.", false),
  field("diagnostics.storeFullRenderedContext", "boolean", "Persist the full rendered context alongside manifests.", false),
  field("diagnostics.logLevel", "enum", "Structured log level.", false, ["error", "warn", "info", "debug", "trace"]),

  field("storage.databasePath", "string", "SQLite database path (absolute, ~-relative, or agent-dir relative).", false),
  field("storage.busyTimeoutMs", "integer", "Per-attempt SQLite lock wait in milliseconds.", false),
  field("storage.writeRetryTimeoutMs", "integer", "Total bounded retry window for replayable writes.", false),
  field("storage.projectIndexLeaseMs", "integer", "Renewable cross-process lease duration for the project indexer.", false),
];

export function findConfigField(path: string): ConfigFieldDoc | undefined {
  return CONFIG_FIELD_DOCS.find((doc) => doc.path === path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(rawValue: string, path: string): unknown {
  try {
    return JSON.parse(rawValue) as unknown;
  } catch {
    throw new Error(`${path}: expected valid JSON`);
  }
}

function assertStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${path}: expected a JSON array of strings`);
  }
  return value as string[];
}

function assertEnumArray(value: unknown, path: string, allowed: readonly string[]): string[] {
  const entries = assertStringArray(value, path);
  for (const entry of entries) {
    if (!allowed.includes(entry)) {
      throw new Error(`${path}: invalid value ${JSON.stringify(entry)}; allowed: ${allowed.join(", ")}`);
    }
  }
  if (new Set(entries).size !== entries.length) {
    throw new Error(`${path}: duplicate values are not allowed`);
  }
  return entries;
}

function assertClassificationMap(value: unknown, path: string): Record<string, string[]> {
  if (!isRecord(value)) throw new Error(`${path}: expected a JSON object`);
  const result: Record<string, string[]> = {};
  for (const [provider, allowed] of Object.entries(value)) {
    if (!provider.trim()) throw new Error(`${path}: provider names must not be empty`);
    if (!Array.isArray(allowed) || allowed.some((entry) => typeof entry !== "string" ||
      !isPrivacyClassification(entry))) {
      throw new Error(`${path}: provider ${JSON.stringify(provider)} must map to an array of ${PRIVACY_CLASSIFICATIONS.join(", ")}`);
    }
    result[provider] = allowed as string[];
  }
  return result;
}

function assertObjectMap(value: unknown, path: string): Record<string, Record<string, unknown>> {
  if (!isRecord(value)) throw new Error(`${path}: expected a JSON object`);
  const result: Record<string, Record<string, unknown>> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim()) throw new Error(`${path}: keys must not be empty`);
    if (!isRecord(entry)) throw new Error(`${path}: entry ${JSON.stringify(key)} must be a JSON object`);
    result[key] = entry;
  }
  return result;
}

/**
 * Convert a raw CLI string into the typed value described by `doc`.
 * Throws with a precise, user-facing message on invalid input.
 */
export function applyConfigValue(
  target: Record<string, unknown>,
  path: string,
  rawValue: string,
  doc: ConfigFieldDoc,
): unknown {
  const raw = rawValue.trim();
  let value: unknown;
  switch (doc.kind) {
    case "boolean": {
      const normalized = raw.toLowerCase();
      if (normalized !== "true" && normalized !== "false") {
        throw new Error(`${path}: expected true or false`);
      }
      value = normalized === "true";
      break;
    }
    case "integer": {
      if (!/^-?\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw))) {
        throw new Error(`${path}: expected a safe integer`);
      }
      value = Number(raw);
      break;
    }
    case "number": {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) throw new Error(`${path}: expected a finite number`);
      value = parsed;
      break;
    }
    case "string": {
      if (!raw) throw new Error(`${path}: expected a non-empty string`);
      value = raw;
      break;
    }
    case "enum": {
      if (!doc.values?.includes(raw)) {
        throw new Error(`${path}: expected one of ${doc.values?.join(", ") ?? "(none)"}`);
      }
      value = raw;
      break;
    }
    case "string-array":
      value = assertStringArray(parseJson(raw, path), path);
      break;
    case "enum-array":
      value = assertEnumArray(parseJson(raw, path), path, doc.values ?? []);
      break;
    case "classification-map":
      value = assertClassificationMap(parseJson(raw, path), path);
      break;
    case "object-map":
      value = assertObjectMap(parseJson(raw, path), path);
      break;
    case "object": {
      const parsed = parseJson(raw, path);
      if (!isRecord(parsed)) throw new Error(`${path}: expected a JSON object`);
      value = parsed;
      break;
    }
  }
  const segments = path.split(".");
  let node = target;
  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index]!;
    if (!isRecord(node[segment])) node[segment] = {};
    node = node[segment] as Record<string, unknown>;
  }
  node[segments[segments.length - 1]!] = value;
  return value;
}

/**
 * Remove a configuration key from a parsed file object, pruning empty
 * intermediate objects. Returns false when the key is not present.
 */
export function removeConfigValue(target: Record<string, unknown>, path: string): boolean {
  const segments = path.split(".");
  if (segments.length === 0) return false;
  const stack: Array<{ node: Record<string, unknown>; segment: string }> = [];
  let node = target;
  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index]!;
    const next = node[segment];
    if (!isRecord(next)) return false;
    stack.push({ node, segment });
    node = next;
  }
  const leaf = segments[segments.length - 1]!;
  if (!(leaf in node)) return false;
  delete node[leaf];
  for (let index = stack.length - 1; index >= 0; index--) {
    const { node: parent, segment } = stack[index]!;
    const child = parent[segment];
    if (isRecord(child) && Object.keys(child).length === 0) delete parent[segment];
    else break;
  }
  return true;
}

/** Read a value from a live configuration object by dotted path. */
export function getConfigValue(config: Ds4ContextConfig, path: string): unknown {
  let node: unknown = config;
  for (const segment of path.split(".")) {
    if (!isRecord(node)) return undefined;
    node = node[segment];
  }
  return node;
}
