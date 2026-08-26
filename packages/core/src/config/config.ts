import type { PrivacyClassification } from "../privacy/privacy-policy.ts";
import type { LogLevel } from "../shared/logging.ts";

/** Frozen additive configuration contract for the 0.2 release line. */
export const CONFIG_SCHEMA_VERSION = "ds4-context-config-v1" as const;

export interface ContextConfig {
  mode: "observer" | "managed";
  targetFillRatio: number;
  softLimitRatio: number;
  hardLimitRatio: number;
  minimumOutputReserve: number;
  preferredOutputReserve: number;
  recentTailTokens: number;
  maxPinnedTokens: number;
  maxMemoryTokens: number;
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

export interface EmbeddingConfig {
  /** Local is the supported default; remote requires an exact consent profile. */
  mode: "local" | "remote";
  provider: string;
  model: string;
  dimensions: number;
  remoteProfiles: string[];
  maxSources: number;
  candidatePool: number;
  batchSize: number;
  queryCacheSize: number;
  timeoutMs: number;
}

export interface RetrievalConfig {
  exact: boolean;
  fts: boolean;
  /** Opt-in hybrid vector candidate generation. */
  semantic: boolean;
  maxResults: number;
  embedding: EmbeddingConfig;
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

export interface MemoryConfig {
  enabled: boolean;
  /** Opt-in replay of project-scoped mutations from sibling Pi sessions. */
  crossSession: boolean;
  /** Bounded number of canonical project session files inspected per refresh. */
  maxProjectSessions: number;
  maxPinChars: number;
  maxClaimChars: number;
  maxResults: number;
}

export interface ArtifactConfig {
  enabled: boolean;
  maxInlineToolResultChars: number;
  maxArtifactBytes: number;
  maxSearchBytes: number;
  excerptChars: number;
  maxSearchMatches: number;
  storeLargeOutputs: boolean;
}

export interface PrivacyConfig {
  enabled: boolean;
  defaultClassification: PrivacyClassification;
  localProviders: string[];
  remoteDefaultAllowed: PrivacyClassification[];
  remoteProviders: Record<string, PrivacyClassification[]>;
  redactSecrets: boolean;
}

export interface ModelProfileOverride {
  contextWindow?: number;
  maxOutputTokens?: number;
  safetyMarginTokens?: number;
  recentTailTokens?: number;
  maxRetrievedHistoryTokens?: number;
  maxProjectTokens?: number;
}

export interface ModelAwarenessConfig {
  enabled: boolean;
  calibrationWindow: number;
  minimumCalibrationSamples: number;
  calibrationRatioLowerBound: number;
  calibrationRatioUpperBound: number;
  /** Exact `provider/model`, provider wildcard `provider/*`, or global `*`. */
  overrides: Record<string, ModelProfileOverride>;
}

export interface NativeContinuationConfig {
  enabled: boolean;
  /** Explicit acknowledgement that eligible Responses API calls set `store: true`. */
  allowProviderStorage: boolean;
  /** Exact `provider/model` or provider wildcard `provider/*`; no global wildcard. */
  profiles: string[];
  maxStateAgeMs: number;
  retryManagedReplay: boolean;
}

export interface LocalKvReuseConfig {
  /** Opt-in; also requires an enabled runtime `local-kv-reuse` capability. */
  enabled: boolean;
}

export interface QualityConfig {
  /** Opt-in metadata-only quality sampling. */
  enabled: boolean;
  /** Bounded number of disposable samples retained in SQLite. */
  maxSamples: number;
}

export interface RankingConfig {
  /** Off preserves the static ranker; shadow compares only; active requires a promoted model. */
  mode: "off" | "shadow" | "active";
  /** Absolute, `~`-relative, or relative to Pi's agent directory. */
  modelPath: string;
  /** Minimum unique classified labels required for local training. */
  minimumTrainingSamples: number;
  /** Maximum canonical feedback entries inspected during one training run. */
  maxTrainingSamples: number;
  /** Promotion-gate p95 budget for learned inference inside planning. */
  maxLatencyMs: number;
}

export interface DiagnosticsConfig {
  storeContextManifest: boolean;
  storeFullRenderedContext: boolean;
  logLevel: LogLevel;
}

export interface StorageConfig {
  /** Absolute, `~`-relative, or relative to Pi's agent directory. */
  databasePath: string;
  /** Per-attempt SQLite lock wait. */
  busyTimeoutMs: number;
  /** Total bounded retry window for replayable writes. */
  writeRetryTimeoutMs: number;
  /** Renewable cross-process lease duration for one project indexer. */
  projectIndexLeaseMs: number;
}

export interface Ds4ContextConfig {
  enabled: boolean;
  context: ContextConfig;
  compaction: CompactionConfig;
  retrieval: RetrievalConfig;
  project: ProjectKnowledgeConfig;
  memory: MemoryConfig;
  artifacts: ArtifactConfig;
  privacy: PrivacyConfig;
  modelAwareness: ModelAwarenessConfig;
  nativeContinuation: NativeContinuationConfig;
  localKvReuse: LocalKvReuseConfig;
  quality: QualityConfig;
  ranking: RankingConfig;
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
    recentTailTokens: 64000,
    maxPinnedTokens: 16000,
    maxMemoryTokens: 8000,
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
    embedding: {
      mode: "local",
      provider: "ds4-local",
      model: "feature-hash-v1",
      dimensions: 256,
      remoteProfiles: [],
      maxSources: 50_000,
      candidatePool: 80,
      batchSize: 64,
      queryCacheSize: 64,
      timeoutMs: 2_000,
    },
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
  memory: {
    enabled: true,
    crossSession: false,
    maxProjectSessions: 250,
    maxPinChars: 4000,
    maxClaimChars: 2000,
    maxResults: 12,
  },
  artifacts: {
    enabled: true,
    maxInlineToolResultChars: 12000,
    maxArtifactBytes: 100_000_000,
    maxSearchBytes: 50_000_000,
    excerptChars: 6000,
    maxSearchMatches: 12,
    storeLargeOutputs: true,
  },
  privacy: {
    enabled: false,
    defaultClassification: "normal",
    localProviders: ["faux", "ollama", "llama-cpp", "lmstudio"],
    remoteDefaultAllowed: ["normal", "internal"],
    remoteProviders: {},
    redactSecrets: true,
  },
  modelAwareness: {
    enabled: true,
    calibrationWindow: 24,
    minimumCalibrationSamples: 3,
    calibrationRatioLowerBound: 0.5,
    calibrationRatioUpperBound: 2,
    overrides: {},
  },
  nativeContinuation: {
    enabled: false,
    allowProviderStorage: false,
    profiles: ["openai/*"],
    maxStateAgeMs: 1_800_000,
    retryManagedReplay: true,
  },
  localKvReuse: {
    enabled: false,
  },
  quality: {
    enabled: false,
    maxSamples: 1000,
  },
  ranking: {
    mode: "off",
    modelPath: "ds4-context/ranking-model.json",
    minimumTrainingSamples: 20,
    maxTrainingSamples: 10_000,
    maxLatencyMs: 10,
  },
  diagnostics: {
    storeContextManifest: true,
    storeFullRenderedContext: false,
    logLevel: "info",
  },
  storage: {
    databasePath: "ds4-context/context.db",
    busyTimeoutMs: 5_000,
    writeRetryTimeoutMs: 30_000,
    projectIndexLeaseMs: 120_000,
  },
};

export function createDefaultConfig(): Ds4ContextConfig {
  return structuredClone(DEFAULT_CONFIG);
}
