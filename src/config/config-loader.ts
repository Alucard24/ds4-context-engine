import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createDefaultConfig, type Ds4ContextConfig } from "./config.ts";

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

function mergeKnown<T extends object>(base: T, override: Record<string, unknown>, warnings: string[], prefix = ""): T {
  const result = structuredClone(base) as Record<string, unknown>;
  const known = base as Record<string, unknown>;

  for (const [key, incoming] of Object.entries(override)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in known)) {
      warnings.push(`Unknown configuration key ignored: ${path}`);
      continue;
    }

    const expected = known[key];
    if (isRecord(expected)) {
      if (!isRecord(incoming)) {
        warnings.push(`Invalid configuration value ignored: ${path} must be an object`);
        continue;
      }
      result[key] = mergeKnown(expected, incoming, warnings, path);
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
    ["context.maxRetrievedHistoryTokens", config.context.maxRetrievedHistoryTokens],
    ["context.maxProjectTokens", config.context.maxProjectTokens],
    ["context.maxSummaryTokens", config.context.maxSummaryTokens],
    ["compaction.segmentTargetTokens", config.compaction.segmentTargetTokens],
    ["artifacts.maxInlineToolResultChars", config.artifacts.maxInlineToolResultChars],
  ] as const;

  for (const [name, value] of nonNegative) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  }

  if (config.context.preferredOutputReserve < config.context.minimumOutputReserve) {
    throw new Error("context.preferredOutputReserve must be at least context.minimumOutputReserve");
  }
  if (!Number.isInteger(config.retrieval.maxResults) || config.retrieval.maxResults <= 0) {
    throw new Error("retrieval.maxResults must be a positive integer");
  }
  if (config.compaction.mode !== "hierarchical") {
    throw new Error("compaction.mode must be hierarchical");
  }
  if (!config.compaction.preserveRecentVerbatim) {
    throw new Error("compaction.preserveRecentVerbatim must remain true for non-destructive compaction");
  }
  if (!["normal", "internal", "sensitive", "local-only"].includes(config.privacy.defaultClassification)) {
    throw new Error("privacy.defaultClassification is invalid");
  }
  if (!["error", "warn", "info", "debug", "trace"].includes(config.diagnostics.logLevel)) {
    throw new Error("diagnostics.logLevel is invalid");
  }
  if (config.storage.databasePath.trim().length === 0) {
    throw new Error("storage.databasePath must not be empty");
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

export function resolveDatabasePath(
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
