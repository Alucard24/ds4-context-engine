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

/**
 * Optional dedicated model used to generate compaction summaries instead of the
 * active session model. Opt-in only: when absent, compaction uses the active
 * model exactly as before.
 */
export interface CompactionModelConfig {
  provider: string;
  id: string;
}

/**
 * Reasoning levels applied to the compaction summary request only. `off` omits
 * any provider-specific thinking option, preserving the pre-existing request
 * shape. Providers without reasoning support ignore the mapped option.
 */
export const COMPACTION_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type CompactionThinkingLevel = (typeof COMPACTION_THINKING_LEVELS)[number];

export interface CompactionSummaryConfig {
  /** Reasoning level for compaction summary requests. Default: `off`. */
  thinking?: CompactionThinkingLevel;
}

/**
 * Transport retry policy for compaction summary requests: 3 total attempts,
 * 2000 ms base delay, exponential backoff, abort-aware.
 * Only transport-classified failures are retried;
 * deterministic failures and aborts never replay the request.
 */
export interface CompactionTransportConfig {
  /** Total attempts for transport-classified failures. Default: 3. */
  maxAttempts?: number;
  /** Base backoff delay in ms, doubled per attempt. Default: 2000. */
  baseDelayMs?: number;
}

export interface CompactionConfig {
  enabled: boolean;
  mode: "hierarchical";
  validate: boolean;
  segmentTargetTokens: number;
  preserveRecentVerbatim: boolean;
  /** Use one validated previous-summary + source update when the complete prompt fits. Default: true. */
  directUpdate?: boolean;
  /** Summary-specific hard budget or legacy ordinary-context fill target. Default: summary. */
  inputBudget?: "summary" | "context";
  /** Independent segment calls in flight; aggregates remain ordered. Default: 2, range 1–2. */
  maxConcurrentSegments?: number;
  /** Opt-in dedicated model for compaction summary generation. */
  model?: CompactionModelConfig;
  /** Opt-in summary request controls. */
  summary?: CompactionSummaryConfig;
  /** Transport retry policy for summary requests. */
  transport?: CompactionTransportConfig;
}

export interface EditingConfig {
  /** Opt-in Pi edit override with execution-time [upto] anchor expansion. */
  anchored: boolean;
  /** Bounded report from the actual native edit patch. Independent of anchors. */
  postEditReport: boolean;
}

export interface ReadingConfig {
  /** Adapt the default Pi read line limit to the execution-time model window. */
  adaptive: boolean;
}

export interface JobsConfig {
  /** Local, confirmed, session-owned background shell jobs. */
  enabled: boolean;
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
  /** Lower inline/excerpt caps according to the current estimated input budget. */
  adaptiveBudget: boolean;
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
  editing: EditingConfig;
  reading: ReadingConfig;
  jobs: JobsConfig;
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
    directUpdate: true,
    inputBudget: "summary",
    maxConcurrentSegments: 2,
    transport: {
      maxAttempts: 3,
      baseDelayMs: 2000,
    },
  },
  editing: {
    anchored: false,
    postEditReport: false,
  },
  reading: {
    adaptive: false,
  },
  jobs: {
    enabled: false,
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
    adaptiveBudget: false,
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
