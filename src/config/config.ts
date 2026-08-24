import type { LogLevel } from "../shared/logging.ts";

export interface ContextConfig {
  mode: "observer" | "managed";
  targetFillRatio: number;
  softLimitRatio: number;
  hardLimitRatio: number;
  minimumOutputReserve: number;
  preferredOutputReserve: number;
  recentTailTokens: number;
  maxRetrievedHistoryTokens: number;
  maxProjectTokens: number;
  maxSummaryTokens: number;
}

export interface CompactionConfig {
  enabled: boolean;
  mode: "hierarchical";
  validate: boolean;
  segmentTargetTokens: number;
  preserveRecentVerbatim: boolean;
}

export interface RetrievalConfig {
  exact: boolean;
  fts: boolean;
  semantic: boolean;
  maxResults: number;
}

export interface ProjectKnowledgeConfig {
  enabled: boolean;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  snippetLines: number;
  snippetOverlapLines: number;
  maxResults: number;
}

export interface ArtifactConfig {
  enabled: boolean;
  maxInlineToolResultChars: number;
  storeLargeOutputs: boolean;
}

export interface PrivacyConfig {
  enabled: boolean;
  defaultClassification: "normal" | "internal" | "sensitive" | "local-only";
}

export interface DiagnosticsConfig {
  storeContextManifest: boolean;
  storeFullRenderedContext: boolean;
  logLevel: LogLevel;
}

export interface StorageConfig {
  /** Absolute, `~`-relative, or relative to Pi's agent directory. */
  databasePath: string;
}

export interface Ds4ContextConfig {
  enabled: boolean;
  context: ContextConfig;
  compaction: CompactionConfig;
  retrieval: RetrievalConfig;
  project: ProjectKnowledgeConfig;
  artifacts: ArtifactConfig;
  privacy: PrivacyConfig;
  diagnostics: DiagnosticsConfig;
  storage: StorageConfig;
}

export const DEFAULT_CONFIG: Ds4ContextConfig = {
  enabled: true,
  context: {
    mode: "managed",
    targetFillRatio: 0.7,
    softLimitRatio: 0.8,
    hardLimitRatio: 0.9,
    minimumOutputReserve: 8192,
    preferredOutputReserve: 32768,
    recentTailTokens: 24000,
    maxRetrievedHistoryTokens: 16000,
    maxProjectTokens: 20000,
    maxSummaryTokens: 12000,
  },
  compaction: {
    enabled: true,
    mode: "hierarchical",
    validate: true,
    segmentTargetTokens: 30000,
    preserveRecentVerbatim: true,
  },
  retrieval: {
    exact: true,
    fts: true,
    semantic: false,
    maxResults: 12,
  },
  project: {
    enabled: true,
    maxFiles: 10_000,
    maxFileBytes: 512_000,
    maxTotalBytes: 50_000_000,
    snippetLines: 80,
    snippetOverlapLines: 12,
    maxResults: 8,
  },
  artifacts: {
    enabled: true,
    maxInlineToolResultChars: 12000,
    storeLargeOutputs: true,
  },
  privacy: {
    enabled: false,
    defaultClassification: "normal",
  },
  diagnostics: {
    storeContextManifest: true,
    storeFullRenderedContext: false,
    logLevel: "info",
  },
  storage: {
    databasePath: "ds4-context/context.db",
  },
};

export function createDefaultConfig(): Ds4ContextConfig {
  return structuredClone(DEFAULT_CONFIG);
}
