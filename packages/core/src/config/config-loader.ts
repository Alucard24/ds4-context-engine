import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PRIVACY_CLASSIFICATIONS, isPrivacyClassification } from "../privacy/privacy-policy.ts";
import {
  COMPACTION_THINKING_LEVELS,
  createDefaultConfig,
  type Ds4ContextConfig,
} from "./config.ts";

export interface LoadConfigOptions {
  agentDir: string;
  cwd: string;
  configDirName: string;
  projectTrusted: boolean;
  homeDir?: string;
}

export interface LoadedConfig {
  config: Ds4ContextConfig;
  globalPath: string;
  projectPath: string;
  loadedFiles: string[];
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Object-valued opt-in paths whose keys are not part of the default shape.
 * They are merged as free objects and later validated by `validateConfig`.
 */
const OPTIONAL_OBJECT_PATHS = new Set(["compaction.model", "compaction.summary"]);

function mergeKnown<T extends object>(base: T, override: Record<string, unknown>, warnings: string[], prefix = ""): T {
  const result = structuredClone(base) as Record<string, unknown>;
  const known = base as Record<string, unknown>;

  for (const [key, incoming] of Object.entries(override)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in known)) {
      if (OPTIONAL_OBJECT_PATHS.has(path) && isRecord(incoming)) {
        result[key] = structuredClone(incoming);
        continue;
      }
      warnings.push(`Unknown configuration key ignored: ${path}`);
      continue;
    }

    const expected = known[key];
    if (isRecord(expected)) {
      if (!isRecord(incoming)) {
        warnings.push(`Invalid configuration value ignored: ${path} must be an object`);
        continue;
      }
      result[key] = path === "privacy.remoteProviders" || path === "modelAwareness.overrides"
        ? { ...structuredClone(expected), ...structuredClone(incoming) }
        : Object.keys(expected).length === 0
          ? structuredClone(incoming)
          : mergeKnown(expected, incoming, warnings, path);
      continue;
    }

    if (typeof incoming !== typeof expected || (typeof incoming === "number" && !Number.isFinite(incoming))) {
      warnings.push(`Invalid configuration value ignored: ${path} has the wrong type`);
      continue;
    }

    result[key] = incoming;
  }

  return result as T;
}

function validateConfig(config: Ds4ContextConfig): void {
  if (!["observer", "managed"].includes(config.context.mode)) {
    throw new Error("context.mode must be observer or managed");
  }

  const ratios = [
    ["context.targetFillRatio", config.context.targetFillRatio],
    ["context.softLimitRatio", config.context.softLimitRatio],
    ["context.hardLimitRatio", config.context.hardLimitRatio],
  ] as const;

  for (const [name, value] of ratios) {
    if (value <= 0 || value > 1) throw new Error(`${name} must be greater than 0 and at most 1`);
  }

  if (!(config.context.targetFillRatio <= config.context.softLimitRatio &&
    config.context.softLimitRatio <= config.context.hardLimitRatio)) {
    throw new Error("context ratios must satisfy targetFillRatio <= softLimitRatio <= hardLimitRatio");
  }

  const nonNegative = [
    ["context.minimumOutputReserve", config.context.minimumOutputReserve],
    ["context.preferredOutputReserve", config.context.preferredOutputReserve],
    ["context.recentTailTokens", config.context.recentTailTokens],
    ["context.maxPinnedTokens", config.context.maxPinnedTokens],
    ["context.maxMemoryTokens", config.context.maxMemoryTokens],
    ["context.maxRetrievedHistoryTokens", config.context.maxRetrievedHistoryTokens],
    ["context.maxProjectTokens", config.context.maxProjectTokens],
    ["context.maxSummaryTokens", config.context.maxSummaryTokens],
    ["compaction.segmentTargetTokens", config.compaction.segmentTargetTokens],
    ["project.maxFileBytes", config.project.maxFileBytes],
    ["project.maxTotalBytes", config.project.maxTotalBytes],
    ["memory.maxPinChars", config.memory.maxPinChars],
    ["memory.maxClaimChars", config.memory.maxClaimChars],
    ["artifacts.maxInlineToolResultChars", config.artifacts.maxInlineToolResultChars],
    ["artifacts.maxArtifactBytes", config.artifacts.maxArtifactBytes],
    ["artifacts.maxSearchBytes", config.artifacts.maxSearchBytes],
    ["artifacts.excerptChars", config.artifacts.excerptChars],
  ] as const;

  for (const [name, value] of nonNegative) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  }

  if (config.context.preferredOutputReserve < config.context.minimumOutputReserve) {
    throw new Error("context.preferredOutputReserve must be at least context.minimumOutputReserve");
  }
  if (!Number.isInteger(config.retrieval.maxResults) || config.retrieval.maxResults <= 0 || config.retrieval.maxResults > 100) {
    throw new Error("retrieval.maxResults must be a positive integer at most 100");
  }
  const embedding = config.retrieval.embedding;
  if (embedding.mode !== "local" && embedding.mode !== "remote") {
    throw new Error("retrieval.embedding.mode must be local or remote");
  }
  if (!embedding.provider.trim() || !embedding.model.trim()
    || embedding.provider.trim() !== embedding.provider
    || embedding.model.trim() !== embedding.model
    || /[\s/]/u.test(embedding.provider)
    || /\s/u.test(embedding.model)) {
    throw new Error("retrieval.embedding provider/model must be trimmed non-empty identifiers");
  }
  const boundedEmbeddingIntegers = [
    ["retrieval.embedding.dimensions", embedding.dimensions, 16, 4_096],
    ["retrieval.embedding.maxSources", embedding.maxSources, 1, 100_000],
    ["retrieval.embedding.candidatePool", embedding.candidatePool, 1, 500],
    ["retrieval.embedding.batchSize", embedding.batchSize, 1, 512],
    ["retrieval.embedding.queryCacheSize", embedding.queryCacheSize, 1, 1_000],
    ["retrieval.embedding.timeoutMs", embedding.timeoutMs, 1, 120_000],
  ] as const;
  for (const [name, value, minimum, maximum] of boundedEmbeddingIntegers) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
  }
  if (!Array.isArray(embedding.remoteProfiles)) {
    throw new Error("retrieval.embedding.remoteProfiles must be an array");
  }
  const remoteProfiles = new Set<string>();
  for (const profile of embedding.remoteProfiles) {
    if (typeof profile !== "string" || profile.trim() !== profile || /\s/u.test(profile)) {
      throw new Error("retrieval.embedding.remoteProfiles must contain trimmed provider/model profiles");
    }
    const separator = profile.indexOf("/");
    if (separator <= 0 || separator === profile.length - 1 || profile.includes("*")) {
      throw new Error(`retrieval embedding profile ${profile} must be an exact provider/model`);
    }
    if (remoteProfiles.has(profile)) {
      throw new Error("retrieval.embedding.remoteProfiles must not contain duplicates");
    }
    remoteProfiles.add(profile);
  }
  if (embedding.mode === "remote"
    && !remoteProfiles.has(`${embedding.provider}/${embedding.model}`)) {
    throw new Error("remote embedding requires exact provider/model consent in retrieval.embedding.remoteProfiles");
  }
  if (embedding.mode === "remote" && !config.privacy.enabled) {
    throw new Error("remote embedding requires privacy.enabled for filtering");
  }
  const positiveProjectIntegers = [
    ["project.maxFiles", config.project.maxFiles, 100_000],
    ["project.snippetLines", config.project.snippetLines, 500],
    ["project.maxResults", config.project.maxResults, 100],
  ] as const;
  for (const [name, value, maximum] of positiveProjectIntegers) {
    if (!Number.isInteger(value) || value <= 0 || value > maximum) {
      throw new Error(`${name} must be a positive integer at most ${maximum}`);
    }
  }
  if (!Number.isInteger(config.project.snippetOverlapLines)
    || config.project.snippetOverlapLines < 0
    || config.project.snippetOverlapLines >= config.project.snippetLines) {
    throw new Error("project.snippetOverlapLines must be a non-negative integer below project.snippetLines");
  }
  if (typeof config.memory.crossSession !== "boolean") {
    throw new Error("memory.crossSession must be boolean");
  }
  if (!Number.isInteger(config.memory.maxProjectSessions)
    || config.memory.maxProjectSessions < 1
    || config.memory.maxProjectSessions > 10_000) {
    throw new Error("memory.maxProjectSessions must be an integer between 1 and 10000");
  }
  if (config.memory.maxPinChars < 1 || config.memory.maxPinChars > 20_000) {
    throw new Error("memory.maxPinChars must be between 1 and 20000");
  }
  if (config.memory.maxClaimChars < 1 || config.memory.maxClaimChars > 20_000) {
    throw new Error("memory.maxClaimChars must be between 1 and 20000");
  }
  if (!Number.isInteger(config.memory.maxResults)
    || config.memory.maxResults <= 0
    || config.memory.maxResults > 100) {
    throw new Error("memory.maxResults must be a positive integer at most 100");
  }
  if (config.artifacts.maxInlineToolResultChars < 1_000) {
    throw new Error("artifacts.maxInlineToolResultChars must be at least 1000");
  }
  if (config.artifacts.excerptChars > config.artifacts.maxInlineToolResultChars) {
    throw new Error("artifacts.excerptChars must not exceed artifacts.maxInlineToolResultChars");
  }
  if (!Number.isInteger(config.artifacts.maxSearchMatches)
    || config.artifacts.maxSearchMatches <= 0
    || config.artifacts.maxSearchMatches > 100) {
    throw new Error("artifacts.maxSearchMatches must be a positive integer at most 100");
  }
  if (config.artifacts.maxSearchBytes > config.artifacts.maxArtifactBytes) {
    throw new Error("artifacts.maxSearchBytes must not exceed artifacts.maxArtifactBytes");
  }
  if (config.compaction.mode !== "hierarchical") {
    throw new Error("compaction.mode must be hierarchical");
  }
  if (!config.compaction.preserveRecentVerbatim) {
    throw new Error("compaction.preserveRecentVerbatim must remain true for non-destructive compaction");
  }
  if (config.compaction.directUpdate !== undefined && typeof config.compaction.directUpdate !== "boolean") {
    throw new Error("compaction.directUpdate must be boolean");
  }
  if (config.context.rescueImmediatePredecessor !== undefined && typeof config.context.rescueImmediatePredecessor !== "boolean") {
    throw new Error("context.rescueImmediatePredecessor must be boolean");
  }
  if (config.compaction.inputBudget !== undefined && !["summary", "context"].includes(config.compaction.inputBudget)) {
    throw new Error("compaction.inputBudget must be summary or context");
  }
  const concurrency = config.compaction.maxConcurrentSegments;
  if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2)) {
    throw new Error("compaction.maxConcurrentSegments must be an integer between 1 and 2");
  }
  if (config.compaction.model) {
    const { provider, id } = config.compaction.model;
    if (!provider.trim() || !id.trim()
      || provider.trim() !== provider
      || id.trim() !== id
      || /[\s/]/u.test(provider)
      || /[\s/]/u.test(id)) {
      throw new Error("compaction.model.provider and compaction.model.id must be non-empty trimmed tokens without whitespace or slashes");
    }
  }
  const thinking = config.compaction.summary?.thinking;
  if (thinking !== undefined && !COMPACTION_THINKING_LEVELS.includes(thinking)) {
    throw new Error(`compaction.summary.thinking must be one of ${COMPACTION_THINKING_LEVELS.join(", ")}`);
  }
  const transport = config.compaction.transport;
  if (transport) {
    const { maxAttempts, baseDelayMs } = transport;
    if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10)) {
      throw new Error("compaction.transport.maxAttempts must be an integer between 1 and 10");
    }
    if (baseDelayMs !== undefined && (!Number.isInteger(baseDelayMs) || baseDelayMs < 0 || baseDelayMs > 60_000)) {
      throw new Error("compaction.transport.baseDelayMs must be an integer between 0 and 60000");
    }
  }
  if (!isPrivacyClassification(config.privacy.defaultClassification)) {
    throw new Error("privacy.defaultClassification is invalid");
  }
  const validateClassifications = (name: string, values: unknown): void => {
    if (!Array.isArray(values) || values.some((value) => !isPrivacyClassification(value))) {
      throw new Error(`${name} must contain only ${PRIVACY_CLASSIFICATIONS.join(", ")}`);
    }
    if (new Set(values).size !== values.length) throw new Error(`${name} must not contain duplicates`);
    if (values.includes("local-only")) throw new Error(`${name} cannot allow local-only content to a remote provider`);
  };
  if (!Array.isArray(config.privacy.localProviders)
    || config.privacy.localProviders.some((provider) => typeof provider !== "string" || provider.trim().length === 0)) {
    throw new Error("privacy.localProviders must contain non-empty provider names");
  }
  const normalizedLocalProviders = config.privacy.localProviders.map((provider) => provider.trim().toLowerCase());
  if (new Set(normalizedLocalProviders).size !== normalizedLocalProviders.length) {
    throw new Error("privacy.localProviders must not contain duplicates");
  }
  validateClassifications("privacy.remoteDefaultAllowed", config.privacy.remoteDefaultAllowed);
  for (const [provider, allowed] of Object.entries(config.privacy.remoteProviders)) {
    if (provider.trim().length === 0) throw new Error("privacy.remoteProviders keys must not be empty");
    if (normalizedLocalProviders.includes(provider.trim().toLowerCase())) {
      throw new Error(`privacy provider ${provider} cannot be both local and remote`);
    }
    validateClassifications(`privacy.remoteProviders.${provider}`, allowed);
  }

  if (!Number.isInteger(config.modelAwareness.calibrationWindow)
    || config.modelAwareness.calibrationWindow < 3
    || config.modelAwareness.calibrationWindow > 200) {
    throw new Error("modelAwareness.calibrationWindow must be an integer between 3 and 200");
  }
  if (!Number.isInteger(config.modelAwareness.minimumCalibrationSamples)
    || config.modelAwareness.minimumCalibrationSamples < 1
    || config.modelAwareness.minimumCalibrationSamples > config.modelAwareness.calibrationWindow) {
    throw new Error("modelAwareness.minimumCalibrationSamples must be between 1 and calibrationWindow");
  }
  const lowerRatio = config.modelAwareness.calibrationRatioLowerBound;
  const upperRatio = config.modelAwareness.calibrationRatioUpperBound;
  if (!Number.isFinite(lowerRatio) || !Number.isFinite(upperRatio)
    || lowerRatio < 0.25 || upperRatio > 4 || lowerRatio >= upperRatio) {
    throw new Error("modelAwareness calibration ratio bounds must satisfy 0.25 <= lower < upper <= 4");
  }
  const overrideFields = new Set([
    "contextWindow",
    "maxOutputTokens",
    "safetyMarginTokens",
    "recentTailTokens",
    "maxRetrievedHistoryTokens",
    "maxProjectTokens",
  ]);
  for (const [key, override] of Object.entries(config.modelAwareness.overrides)) {
    const trimmed = key.trim();
    const separator = trimmed.indexOf("/");
    if (trimmed !== key || (trimmed !== "*" && (
      separator <= 0
      || separator === trimmed.length - 1
      || trimmed.slice(0, separator) === "*"
    ))) {
      throw new Error(`modelAwareness override ${key} must be provider/model, provider/*, or *`);
    }
    if (!isRecord(override)) throw new Error(`modelAwareness.overrides.${key} must be an object`);
    const overrideRecord: Record<string, unknown> = override;
    for (const field of Object.keys(overrideRecord)) {
      if (!overrideFields.has(field)) {
        throw new Error(`Unknown modelAwareness override field: ${key}.${field}`);
      }
    }
    const positive = [overrideRecord.contextWindow, overrideRecord.maxOutputTokens];
    if (positive.some((value) => value !== undefined
      && (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 10_000_000))) {
      throw new Error(`modelAwareness override ${key} context/output limits must be positive integers at most 10000000`);
    }
    const nonNegativeOverride = [
      overrideRecord.safetyMarginTokens,
      overrideRecord.recentTailTokens,
      overrideRecord.maxRetrievedHistoryTokens,
      overrideRecord.maxProjectTokens,
    ];
    if (nonNegativeOverride.some((value) => value !== undefined
      && (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10_000_000))) {
      throw new Error(`modelAwareness override ${key} token limits must be non-negative integers at most 10000000`);
    }
    const effectiveWindow = overrideRecord.contextWindow;
    const maxOutputTokens = overrideRecord.maxOutputTokens;
    if (typeof effectiveWindow === "number" && typeof maxOutputTokens === "number"
      && maxOutputTokens > effectiveWindow) {
      throw new Error(`modelAwareness override ${key} maxOutputTokens must not exceed contextWindow`);
    }
  }
  if (!Array.isArray(config.nativeContinuation.profiles)
    || config.nativeContinuation.profiles.length === 0) {
    throw new Error("nativeContinuation.profiles must contain at least one provider/model profile");
  }
  const continuationProfiles = new Set<string>();
  for (const profile of config.nativeContinuation.profiles) {
    if (typeof profile !== "string" || profile.trim() !== profile || /\s/u.test(profile)) {
      throw new Error("nativeContinuation.profiles must contain trimmed provider/model profiles without whitespace");
    }
    const separator = profile.indexOf("/");
    const provider = separator > 0 ? profile.slice(0, separator) : "";
    const model = separator > 0 ? profile.slice(separator + 1) : "";
    if (!provider || !model || provider.includes("*") || (model.includes("*") && model !== "*")) {
      throw new Error(`nativeContinuation profile ${profile} must be provider/model or provider/*`);
    }
    if (continuationProfiles.has(profile)) {
      throw new Error("nativeContinuation.profiles must not contain duplicates");
    }
    continuationProfiles.add(profile);
  }
  if (config.nativeContinuation.enabled && !config.nativeContinuation.allowProviderStorage) {
    throw new Error("nativeContinuation.allowProviderStorage must be true when native continuation is enabled");
  }
  if (!Number.isInteger(config.nativeContinuation.maxStateAgeMs)
    || config.nativeContinuation.maxStateAgeMs < 10_000
    || config.nativeContinuation.maxStateAgeMs > 86_400_000) {
    throw new Error("nativeContinuation.maxStateAgeMs must be an integer between 10000 and 86400000");
  }
  if (typeof config.localKvReuse.enabled !== "boolean") {
    throw new Error("localKvReuse.enabled must be boolean");
  }
  if (typeof config.quality.enabled !== "boolean") {
    throw new Error("quality.enabled must be boolean");
  }
  if (!Number.isInteger(config.quality.maxSamples)
    || config.quality.maxSamples < 1
    || config.quality.maxSamples > 100_000) {
    throw new Error("quality.maxSamples must be an integer between 1 and 100000");
  }
  if (!["off", "shadow", "active"].includes(config.ranking.mode)) {
    throw new Error("ranking.mode must be off, shadow, or active");
  }
  if (config.ranking.modelPath.trim().length === 0) {
    throw new Error("ranking.modelPath must not be empty");
  }
  if (!Number.isSafeInteger(config.ranking.minimumTrainingSamples)
    || config.ranking.minimumTrainingSamples < 2
    || config.ranking.minimumTrainingSamples > 100_000) {
    throw new Error("ranking.minimumTrainingSamples must be an integer between 2 and 100000");
  }
  if (!Number.isSafeInteger(config.ranking.maxTrainingSamples)
    || config.ranking.maxTrainingSamples < config.ranking.minimumTrainingSamples
    || config.ranking.maxTrainingSamples > 1_000_000) {
    throw new Error("ranking.maxTrainingSamples must be an integer between minimumTrainingSamples and 1000000");
  }
  if (!Number.isFinite(config.ranking.maxLatencyMs)
    || config.ranking.maxLatencyMs <= 0
    || config.ranking.maxLatencyMs > 1_000) {
    throw new Error("ranking.maxLatencyMs must be greater than 0 and at most 1000");
  }
  if (!["error", "warn", "info", "debug", "trace"].includes(config.diagnostics.logLevel)) {
    throw new Error("diagnostics.logLevel is invalid");
  }
  if (config.storage.databasePath.trim().length === 0) {
    throw new Error("storage.databasePath must not be empty");
  }
  if (!Number.isSafeInteger(config.storage.busyTimeoutMs)
    || config.storage.busyTimeoutMs < 1
    || config.storage.busyTimeoutMs > 60_000) {
    throw new Error("storage.busyTimeoutMs must be an integer between 1 and 60000");
  }
  if (!Number.isSafeInteger(config.storage.writeRetryTimeoutMs)
    || config.storage.writeRetryTimeoutMs < config.storage.busyTimeoutMs
    || config.storage.writeRetryTimeoutMs > 300_000) {
    throw new Error("storage.writeRetryTimeoutMs must be an integer between busyTimeoutMs and 300000");
  }
  if (!Number.isSafeInteger(config.storage.projectIndexLeaseMs)
    || config.storage.projectIndexLeaseMs < 10_000
    || config.storage.projectIndexLeaseMs > 3_600_000) {
    throw new Error("storage.projectIndexLeaseMs must be an integer between 10000 and 3600000");
  }
}

function applyConfigFile(
  path: string,
  base: Ds4ContextConfig,
  warnings: string[],
): { config: Ds4ContextConfig; loaded: boolean } {
  if (!existsSync(path)) return { config: base, loaded: false };

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) throw new Error("top-level JSON value must be an object");

    const sourceWarnings: string[] = [];
    const candidate = mergeKnown(base, parsed, sourceWarnings);
    validateConfig(candidate);
    warnings.push(...sourceWarnings.map((warning) => `${path}: ${warning}`));
    return { config: candidate, loaded: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`${path}: configuration ignored: ${message}`);
    return { config: base, loaded: false };
  }
}

/**
 * Validate a parsed configuration file object against the default shape and
 * deterministic rules. Throws on the first violation; warnings report unknown
 * keys and invalid values that are ignored. `manage` uses this before writing
 * an edited configuration file to disk.
 */
export function validateConfigFile(content: Record<string, unknown>): {
  config: Ds4ContextConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  const config = mergeKnown(createDefaultConfig(), content, warnings);
  validateConfig(config);
  return { config, warnings };
}

export function loadConfig(options: LoadConfigOptions): LoadedConfig {
  const globalPath = join(options.agentDir, "ds4-context.json");
  const projectPath = join(options.cwd, options.configDirName, "ds4-context.json");
  const warnings: string[] = [];
  const loadedFiles: string[] = [];

  let config = createDefaultConfig();
  const global = applyConfigFile(globalPath, config, warnings);
  config = global.config;
  if (global.loaded) loadedFiles.push(globalPath);

  if (options.projectTrusted) {
    const project = applyConfigFile(projectPath, config, warnings);
    config = project.config;
    if (project.loaded) loadedFiles.push(projectPath);
  } else if (existsSync(projectPath)) {
    warnings.push(`${projectPath}: project configuration skipped because the project is not trusted`);
  }

  return { config, globalPath, projectPath, loadedFiles, warnings };
}

function resolveAgentPath(
  configuredPath: string,
  agentDir: string,
  homeDir = homedir(),
): string {
  const expanded = configuredPath === "~"
    ? homeDir
    : configuredPath.startsWith("~/")
      ? join(homeDir, configuredPath.slice(2))
      : configuredPath;

  return isAbsolute(expanded) ? resolve(expanded) : resolve(agentDir, expanded);
}

export function resolveDatabasePath(
  configuredPath: string,
  agentDir: string,
  homeDir = homedir(),
): string {
  return resolveAgentPath(configuredPath, agentDir, homeDir);
}

export function resolveRankingModelPath(
  configuredPath: string,
  agentDir: string,
  homeDir = homedir(),
): string {
  return resolveAgentPath(configuredPath, agentDir, homeDir);
}
