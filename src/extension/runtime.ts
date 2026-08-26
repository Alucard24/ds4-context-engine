import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";
import type {
  Api,
  AssistantMessage,
  Model,
} from "@earendil-works/pi-ai";
import {
  sessionEntryToContextMessages,
  type ContextEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { RuntimeCapabilityNegotiation } from "ds4-context-core/adapter/runtime-adapter";
import {
  ArtifactManager,
  disabledArtifactDiagnostics,
  type ArtifactDiagnostics,
  type ArtifactSearchResult,
} from "ds4-context-core/artifacts/artifact-manager";
import { FileArtifactStore } from "ds4-context-core/artifacts/artifact-store";
import {
  CompactionCoordinator,
  defaultCompactionDiagnostics,
  defaultSummaryGraphDiagnostics,
  type CompactionDiagnostics,
  type SessionCompactFailedLike,
  type SummaryGraphDiagnostics,
} from "../pi-adapter/compaction-coordinator.ts";
import {
  NativeContinuationManager,
  type NativeContinuationAttempt,
  type NativeContinuationDiagnostics,
  type NativeContinuationManifest,
  type PreparedNativeContinuation,
} from "ds4-context-core/continuation/native-continuation";
export type {
  CompactionDiagnostics,
  CompactionPhase,
  SummaryGraphDiagnostics,
} from "../pi-adapter/compaction-coordinator.ts";
import {
  loadConfig,
  resolveDatabasePath,
  resolveRankingModelPath,
  type LoadedConfig,
} from "ds4-context-core/config/config-loader";
import { createDefaultConfig, type Ds4ContextConfig } from "ds4-context-core/config/config";
import { calculateContextBudget, type ContextBudget } from "ds4-context-core/core/budget-manager";
import {
  modelProfileKey,
  resolveModelAwareness,
  type ResolvedModelAwareness,
  type TokenCalibrationSample,
} from "ds4-context-core/core/model-awareness";
import type { ModelDescriptor } from "ds4-context-core/core/model-profile";
import { estimateMessagesTokens } from "ds4-context-core/core/token-estimator";
import type {
  ContextManifest,
  ModelAwarenessManifest,
  ModelSwitchManifest,
  PrivacyManifest,
  ProviderUsageManifest,
} from "ds4-context-core/manifest/context-manifest";
import type { ExcludedContextSource, ObservedTool } from "ds4-context-core/manifest/observer";
import {
  disabledCrossSessionMemoryDiagnostics,
  disabledMemoryDiagnostics,
  MemoryManager,
  type MemoryDiagnostics,
  type MemorySelection,
} from "ds4-context-core/memory/memory-manager";
import {
  MEMORY_CUSTOM_ENTRY_TYPE,
  PIN_CUSTOM_ENTRY_TYPE,
  type CrossSessionMemoryDiagnostics,
  type MemoryItem,
  type MemoryMutation,
  type MemoryScope,
  type PinItem,
  type PinMutation,
  type PinScope,
  type ProjectMemorySource,
} from "ds4-context-core/memory/memory-types";
import { planManagedContext, type SupplementalContextMessage } from "ds4-context-core/planner/context-planner";
import {
  disabledContextQualityDiagnostics,
  evaluateManifestQuality,
  type ContextQualityDiagnostics,
} from "ds4-context-core/quality/context-quality";
import {
  createRankingFeatures,
  createRankingFeedback,
  disabledRankingDiagnostics,
  loadLearnedRankingModel,
  rankCandidates,
  RANKING_FEEDBACK_CUSTOM_ENTRY_TYPE,
  saveLearnedRankingModel,
  trainLearnedRankingModel,
  type LearnedRankingModel,
  type RankingDiagnostics,
  type RankingFeatureVector,
  type RankingFeedbackEntry,
  type RankingFeedbackLabel,
} from "ds4-context-core/ranking/learned-ranker";
import {
  disabledPrivacyDiagnostics,
  emptyPrivacyCounts,
  PrivacyPolicyEngine,
  type PrivacyClassification,
  type PrivacyDiagnostics,
} from "ds4-context-core/privacy/privacy-policy";
import {
  emptyProjectDiagnostics,
  ProjectKnowledgeManager,
  type ProjectKnowledgeDiagnostics,
} from "ds4-context-core/project/project-knowledge";
import type { EmbeddingPort } from "ds4-context-core/retrieval/embedding";
import { SemanticEmbeddingIndex } from "ds4-context-core/retrieval/semantic-index";
import {
  emptyRetrievalDiagnostics,
  HistoricalRetrievalEngine,
  type RetrievalDiagnostics,
} from "ds4-context-core/retrieval/retrieval-engine";
import { currentRequestText } from "ds4-context-core/retrieval/task-descriptor";
import { LocalFeatureHashEmbedding } from "../pi-adapter/local-embedding.ts";
import { ContextDatabase, type DatabaseHealth, type SessionIndexStats } from "ds4-context-core/persistence/sqlite";
import {
  activeTools,
  buildPiObserverManifest,
  findExactPiMessageSourceIds,
  findPiPinnedMessageIndices,
} from "../pi-adapter/context-observer.ts";
import { projectSessionFileMutations } from "../pi-adapter/memory-adapter.ts";
import { ProjectMemorySynchronizer } from "../pi-adapter/project-memory-sync.ts";
import { projectRankingLabels } from "../pi-adapter/ranking-adapter.ts";
import { negotiatePiRuntimeCapabilities } from "../pi-adapter/runtime-contract.ts";
import { PiSessionIndexer, type SessionIndexResult } from "../pi-adapter/session-indexer.ts";
import { snapshotModel, snapshotSession, type PiSessionSnapshot } from "../pi-adapter/session-reader.ts";
import { silentLogger, StructuredLogger, type Logger } from "ds4-context-core/shared/logging";
import {
  EXTENSION_VERSION,
  OBSERVER_PLANNER_VERSION,
  PLANNER_VERSION,
  POLICY_VERSION,
  SUPPORTED_PI_VERSION,
} from "../pi-adapter/version.ts";

export type RuntimePhase = "idle" | "initializing" | "disabled" | "observer" | "managed" | "degraded" | "closed";

const READ_ONLY_PROJECT_TOOLS = new Set(["read", "grep", "find", "ls"]);
const MAX_PRIOR_RANKING_OUTCOMES = 50_000;

function comparablePath(path: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    canonical = resolve(path);
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function isBroadProjectRoot(projectPath: string, homePath = homedir()): boolean {
  const project = comparablePath(projectPath);
  const home = comparablePath(homePath);
  const filesystemRoot = comparablePath(parse(project).root);
  return project === home || project === filesystemRoot;
}

export interface RuntimeDependencies {
  agentDir: string;
  configDirName: string;
  homeDir?: string;
  now?: () => number;
  idGenerator?: () => string;
  logSink?: (line: string) => void;
  /** Optional runtime-owned embedding provider; required for configured remote models. */
  embeddingPort?: EmbeddingPort;
}

interface PreparedPrivacyContext {
  event: ContextEvent;
  messageClassifications: PrivacyClassification[];
  messagePrivacyReasons: Array<string | undefined>;
  systemPrompt: string;
  systemClassification?: PrivacyClassification;
  systemPrivacyReason?: string;
  tools: ObservedTool[];
  changed: boolean;
  blockedBlocks: number;
  secretRedactions: number;
}

export interface ContextObservation {
  mode: "observer" | "managed" | "fallback";
  messageCount: number;
  estimatedMessageTokens: number;
  originalMessageCount: number;
  originalEstimatedMessageTokens: number;
  reportedTokens?: number;
  planningDurationMs?: number;
  fallbackReason?: string;
  observedAt: number;
  budget?: ContextBudget;
}

function canonicalProjectPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function failClosedMessage(message: ContextEvent["messages"][number]): ContextEvent["messages"][number] {
  if (!message || typeof message !== "object") return message;
  const record = message as unknown as Record<string, unknown>;
  const replacement = "[DS4 content unavailable because privacy enforcement failed closed]";
  const sanitizeBlock = (block: unknown): unknown => {
    if (!block || typeof block !== "object") return replacement;
    const value = block as Record<string, unknown>;
    if (value.type === "toolCall") return { ...value, arguments: {} };
    if (value.type === "text" || value.type === "thinking") return { ...value, text: replacement };
    if (value.type === "image") return { type: "text", text: replacement };
    return { type: "text", text: replacement };
  };
  return {
    ...record,
    ...(Array.isArray(record.content)
      ? { content: record.content.map(sanitizeBlock) }
      : "content" in record
        ? { content: replacement }
        : {}),
    ...(record.arguments && typeof record.arguments === "object" ? { arguments: {} } : {}),
  } as unknown as ContextEvent["messages"][number];
}

function privacyReason(blockedBlocks: number, secretRedactions: number): string | undefined {
  const reasons = [
    ...(blockedBlocks > 0 ? [`${blockedBlocks} classified block(s) excluded due to privacy policy`] : []),
    ...(secretRedactions > 0 ? [`${secretRedactions} credential-like value(s) redacted`] : []),
  ];
  return reasons.length > 0 ? reasons.join("; ") : undefined;
}

function numericUsage(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function providerUsageManifest(input: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): ProviderUsageManifest {
  const totalInputTokens = input.inputTokens + input.cacheReadTokens + input.cacheWriteTokens;
  const rounded = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
  return {
    ...input,
    totalInputTokens,
    cacheReadShare: totalInputTokens > 0 ? rounded(input.cacheReadTokens / totalInputTokens) : 0,
    cacheWriteShare: totalInputTokens > 0 ? rounded(input.cacheWriteTokens / totalInputTokens) : 0,
  };
}

export interface CreatePinInput {
  content: string;
  scope: PinScope;
  sourceEntryId?: string;
  sourceFile?: string;
  supersedes?: string;
  classification?: PrivacyClassification;
}

export interface CreateMemoryInput {
  claim: string;
  scope: MemoryScope;
  key?: string;
  classification?: PrivacyClassification;
  sourceEntryIds: string[];
}

export type CustomEntryAppender = (
  customType: string,
  data: MemoryMutation | PinMutation | RankingFeedbackEntry,
) => void;

export interface RuntimeRankingDiagnostics extends RankingDiagnostics {
  modelPath?: string;
  modelLoaded: boolean;
  promoted: boolean;
  trainingSamples: number;
  malformedFeedback: number;
  duplicateFeedback: number;
  warnings: string[];
}

export interface RankingTrainingResult {
  modelId: string;
  modelPath: string;
  sampleCount: number;
  positiveSamples: number;
  negativeSamples: number;
  repositoryCount: number;
  warnings: string[];
}

export interface RuntimeDiagnostics {
  extensionVersion: string;
  supportedPiVersion: string;
  plannerVersion: string;
  phase: RuntimePhase;
  enabled: boolean;
  contextMode: "observer" | "managed";
  adapter: RuntimeCapabilityNegotiation;
  session?: PiSessionSnapshot;
  model?: { provider: string; id: string };
  databasePath?: string;
  databaseSchemaVersion?: number;
  indexed?: SessionIndexStats;
  observation?: ContextObservation;
  lastManifest?: ContextManifest;
  retrieval: RetrievalDiagnostics;
  project: ProjectKnowledgeDiagnostics;
  memory: MemoryDiagnostics;
  privacy: PrivacyDiagnostics;
  modelAwareness?: ModelAwarenessManifest;
  nativeContinuation: NativeContinuationDiagnostics;
  quality: ContextQualityDiagnostics;
  ranking: RuntimeRankingDiagnostics;
  artifacts: ArtifactDiagnostics;
  compaction: CompactionDiagnostics;
  lastIndexResult?: SessionIndexResult;
  configFiles: string[];
  configWarnings: string[];
  lastIndexError?: string;
  lastError?: string;
}

export class Ds4ContextRuntime {
  private phase: RuntimePhase = "idle";
  private config: Ds4ContextConfig = createDefaultConfig();
  private loadedConfig?: LoadedConfig;
  private session?: PiSessionSnapshot;
  private database?: ContextDatabase;
  private indexer?: PiSessionIndexer;
  private databasePath?: string;
  private observation?: ContextObservation;
  private lastManifest?: ContextManifest;
  private pendingManifestId?: string;
  private retrievalEngine?: HistoricalRetrievalEngine;
  private lastRetrieval: RetrievalDiagnostics = emptyRetrievalDiagnostics();
  private semanticIndex?: SemanticEmbeddingIndex;
  private semanticFallbackReason?: string;
  private projectKnowledge?: ProjectKnowledgeManager;
  private lastProject: ProjectKnowledgeDiagnostics = emptyProjectDiagnostics();
  private projectRefreshPending = false;
  private readonly projectLeaseOwnerId = randomUUID();
  private memoryManager?: MemoryManager;
  private projectMemorySynchronizer?: ProjectMemorySynchronizer;
  private lastCrossSessionMemory: CrossSessionMemoryDiagnostics = disabledCrossSessionMemoryDiagnostics();
  private lastMemory: MemoryDiagnostics = disabledMemoryDiagnostics();
  private privacyEngine?: PrivacyPolicyEngine;
  private lastPrivacy: PrivacyDiagnostics = disabledPrivacyDiagnostics();
  private lastModelAwareness?: ModelAwarenessManifest;
  private pendingModelSwitch?: ModelSwitchManifest;
  private nativeContinuation: NativeContinuationManager;
  private lastContextProfileKey?: string;
  private readonly knownModelProfiles = new Set<string>();
  private readonly volatileCalibration = new Map<string, TokenCalibrationSample[]>();
  private lastMemoryMutationSignature?: string;
  private artifactManager?: ArtifactManager;
  private lastArtifacts: ArtifactDiagnostics = disabledArtifactDiagnostics();
  private compaction?: CompactionCoordinator;
  private lastIndexResult?: SessionIndexResult;
  private lastIndexError?: string;
  private lastQualityError?: string;
  private rankingModel?: LearnedRankingModel;
  private rankingModelPath?: string;
  private lastRanking: RankingDiagnostics = disabledRankingDiagnostics();
  private readonly rankingCandidates = new Map<string, RankingFeatureVector>();
  private readonly priorRankingSelection = new Map<string, number>();
  private rankingWarnings: string[] = [];
  private readonly pendingQuality: Array<{
    manifest: ContextManifest;
    contextConfig: Ds4ContextConfig["context"];
    recordedAt: number;
  }> = [];
  private lastError?: string;
  private logger: Logger = silentLogger;
  private readonly now: () => number;
  private readonly idGenerator: () => string;

  constructor(private readonly dependencies: RuntimeDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.idGenerator = dependencies.idGenerator ?? randomUUID;
    this.nativeContinuation = new NativeContinuationManager(
      this.config.nativeContinuation,
      this.now,
    );
  }

  openSession(ctx: ExtensionContext): void {
    this.flushContextQuality();
    this.closeDatabase();
    this.phase = "initializing";
    this.lastError = undefined;
    this.lastIndexError = undefined;
    this.lastQualityError = undefined;
    this.rankingModel = undefined;
    this.rankingModelPath = undefined;
    this.lastRanking = disabledRankingDiagnostics(this.config.ranking.mode);
    this.rankingCandidates.clear();
    this.priorRankingSelection.clear();
    this.rankingWarnings = [];
    this.pendingQuality.length = 0;
    this.lastIndexResult = undefined;
    this.lastManifest = undefined;
    this.pendingManifestId = undefined;
    this.retrievalEngine = undefined;
    this.semanticIndex = undefined;
    this.semanticFallbackReason = undefined;
    this.lastRetrieval = emptyRetrievalDiagnostics(
      this.config.context.maxRetrievedHistoryTokens,
      this.config.retrieval.maxResults,
    );
    this.projectKnowledge = undefined;
    this.lastProject = emptyProjectDiagnostics();
    this.projectRefreshPending = false;
    this.memoryManager = undefined;
    this.projectMemorySynchronizer = undefined;
    this.lastCrossSessionMemory = disabledCrossSessionMemoryDiagnostics();
    this.lastMemory = disabledMemoryDiagnostics();
    this.privacyEngine = undefined;
    this.lastPrivacy = disabledPrivacyDiagnostics();
    this.lastModelAwareness = undefined;
    this.pendingModelSwitch = undefined;
    this.nativeContinuation.invalidate("session-opened");
    this.lastContextProfileKey = undefined;
    this.knownModelProfiles.clear();
    this.volatileCalibration.clear();
    this.lastMemoryMutationSignature = undefined;
    this.artifactManager = undefined;
    this.lastArtifacts = disabledArtifactDiagnostics();
    this.compaction = undefined;
    this.observation = undefined;
    this.session = this.snapshotCanonicalSession(ctx);

    try {
      this.loadedConfig = loadConfig({
        agentDir: this.dependencies.agentDir,
        cwd: ctx.cwd,
        configDirName: this.dependencies.configDirName,
        projectTrusted: ctx.isProjectTrusted(),
        ...(this.dependencies.homeDir ? { homeDir: this.dependencies.homeDir } : {}),
      });
      this.config = this.loadedConfig.config;
      this.nativeContinuation = new NativeContinuationManager(
        this.config.nativeContinuation,
        this.now,
      );
      this.privacyEngine = new PrivacyPolicyEngine(this.config.privacy);
      this.logger = new StructuredLogger({
        level: this.config.diagnostics.logLevel,
        ...(this.dependencies.logSink ? { sink: this.dependencies.logSink } : {}),
      });

      for (const warning of this.loadedConfig.warnings) this.logger.warn("configuration.warning", { warning });
      if (this.loadedConfig.warnings.length > 0 && ctx.hasUI) {
        ctx.ui.notify(
          `DS4 Context Engine: ${this.loadedConfig.warnings.length} configuration warning(s). See logs for details.`,
          "warning",
        );
      }

      if (!this.config.enabled) {
        this.phase = "disabled";
        this.setStatus(ctx, "DS4 ctx: disabled");
        this.logger.info("runtime.disabled", { sessionId: this.session.sessionId });
        return;
      }

      this.databasePath = resolveDatabasePath(
        this.config.storage.databasePath,
        this.dependencies.agentDir,
        this.dependencies.homeDir,
      );
      this.database = ContextDatabase.open(this.databasePath, {
        logger: this.logger,
        now: this.now(),
        busyTimeoutMs: this.config.storage.busyTimeoutMs,
        writeRetryTimeoutMs: this.config.storage.writeRetryTimeoutMs,
      });
      this.initializeRanking();

      this.indexer = new PiSessionIndexer(this.database.sessionIndex, {
        logger: this.logger,
        now: this.now,
      });
      this.initializeSemanticRetrieval();
      this.retrievalEngine = new HistoricalRetrievalEngine(
        this.database.sessionIndex,
        undefined,
        this.semanticIndex,
        this.semanticFallbackReason,
      );
      this.lastRetrieval = emptyRetrievalDiagnostics(
        this.config.context.maxRetrievedHistoryTokens,
        this.config.retrieval.maxResults,
      );
      this.initializeProjectKnowledge(ctx);
      if (this.session.sessionFile) {
        this.database.upsertSession({
          sessionId: this.session.sessionId,
          sessionFile: this.session.sessionFile,
          projectPath: this.session.projectPath,
          indexedAt: this.now(),
        });
        this.syncSessionIndex(ctx);
        this.lastManifest = this.database.manifests.getLatest(this.session.sessionId);
        if (this.lastManifest) {
          this.lastContextProfileKey = modelProfileKey(
            this.lastManifest.provider,
            this.lastManifest.model,
          );
          this.knownModelProfiles.add(this.lastContextProfileKey);
          this.lastModelAwareness = this.lastManifest.modelAwareness;
        }
      }
      this.initializeMemory(ctx);
      this.initializeArtifacts(ctx);
      this.compaction = new CompactionCoordinator({
        config: this.config,
        database: this.database,
        sessionId: this.session.sessionId,
        persisted: Boolean(this.session.sessionFile),
        logger: this.logger,
        now: this.now,
        idGenerator: this.idGenerator,
        syncSessionIndex: (context) => {
          this.syncSessionIndex(context);
        },
        latestManifest: () => this.lastManifest,
        resolveModelBudget: (model) => {
          const resolved = this.resolveModelPolicy(model);
          return {
            budget: resolved.budget,
            recentTailTokens: resolved.awareness.limits.recentTailTokens,
          };
        },
        sanitizeContent: (text, provider) => this.privacyEngine?.sanitizeText(text, provider).value ?? text,
        classifyContent: (text, provider) => {
          const sanitized = this.privacyEngine?.sanitizeText(text, provider);
          return sanitized
            ? { value: sanitized.value, classification: sanitized.classification }
            : { value: text, classification: "normal" };
        },
      });
      this.compaction.initialize(ctx.sessionManager.getEntries());

      this.phase = this.config.context.mode;
      this.setStatus(ctx, `DS4 ctx: ${this.config.context.mode}`);
      this.logger.info("session.opened", {
        sessionId: this.session.sessionId,
        persisted: Boolean(this.session.sessionFile),
        projectPath: this.session.projectPath,
      });
    } catch (error) {
      this.enterDegradedMode(ctx, error, "startup");
    }
  }

  private preparePrivacyContext(
    event: ContextEvent,
    ctx: ExtensionContext,
    pi: ExtensionAPI,
  ): PreparedPrivacyContext {
    const provider = ctx.model?.provider ?? "unknown";
    const tools = activeTools(pi);
    if (!this.config.privacy.enabled || !this.privacyEngine) {
      return {
        event,
        messageClassifications: [],
        messagePrivacyReasons: [],
        systemPrompt: ctx.getSystemPrompt(),
        tools,
        changed: false,
        blockedBlocks: 0,
        secretRedactions: 0,
      };
    }

    const messages = event.messages.map((message) => this.privacyEngine!.sanitizeMessage(message, provider));
    const system = this.privacyEngine.sanitizeText(ctx.getSystemPrompt(), provider);
    const toolResults = tools.map((tool) => this.privacyEngine!.sanitizeMessage(tool, provider));
    const sanitizedTools = toolResults.map((sanitized) => ({
      ...sanitized.value,
      classification: sanitized.classification,
      ...(privacyReason(sanitized.blockedBlocks, sanitized.secretRedactions)
        ? { privacyReason: privacyReason(sanitized.blockedBlocks, sanitized.secretRedactions) }
        : {}),
    }));
    const blockedBlocks = messages.reduce((total, item) => total + item.blockedBlocks, system.blockedBlocks)
      + toolResults.reduce((total, item) => total + item.blockedBlocks, 0);
    const secretRedactions = messages.reduce((total, item) => total + item.secretRedactions, system.secretRedactions)
      + toolResults.reduce((total, item) => total + item.secretRedactions, 0);
    const policy = this.privacyEngine.policy(provider);
    this.lastPrivacy = {
      enabled: true,
      provider,
      destination: policy.destination,
      allowedClassifications: [...policy.allowedClassifications],
      inspectedMessages: messages.length,
      selectedClassifications: emptyPrivacyCounts(),
      blockedBlocks,
      excludedSources: 0,
      secretRedactions,
      providerChecks: 0,
      providerPayloadRedactions: 0,
      enforcement: "context",
      warnings: [],
    };
    return {
      event: { type: "context", messages: messages.map((item) => item.value) },
      messageClassifications: messages.map((item) => item.classification),
      messagePrivacyReasons: messages.map((item) => privacyReason(item.blockedBlocks, item.secretRedactions)),
      systemPrompt: system.value,
      systemClassification: system.classification,
      ...(privacyReason(system.blockedBlocks, system.secretRedactions)
        ? { systemPrivacyReason: privacyReason(system.blockedBlocks, system.secretRedactions) }
        : {}),
      tools: sanitizedTools,
      changed: system.changed || messages.some((item) => item.changed) || toolResults.some((item) => item.changed),
      blockedBlocks,
      secretRedactions,
    };
  }

  private privacyManifest(classifications: readonly PrivacyClassification[]): PrivacyManifest | undefined {
    if (!this.lastPrivacy.enabled || !this.lastPrivacy.provider || !this.lastPrivacy.destination) return undefined;
    const provider = this.lastPrivacy.provider;
    const destination = this.lastPrivacy.destination;
    const counts = emptyPrivacyCounts();
    for (const classification of classifications) counts[classification]++;
    this.lastPrivacy = { ...this.lastPrivacy, selectedClassifications: counts };
    return {
      enabled: true,
      destination,
      provider,
      allowedClassifications: [...this.lastPrivacy.allowedClassifications],
      selectedClassifications: { ...counts },
      blockedBlocks: this.lastPrivacy.blockedBlocks,
      excludedSources: this.lastPrivacy.excludedSources,
      secretRedactions: this.lastPrivacy.secretRedactions,
      providerChecks: this.lastPrivacy.providerChecks,
      providerPayloadRedactions: this.lastPrivacy.providerPayloadRedactions,
      enforcement: this.lastPrivacy.enforcement === "context-and-provider"
        ? "context-and-provider"
        : "context",
    };
  }

  private calibrationSamples(model: ModelDescriptor): TokenCalibrationSample[] {
    if (this.database && this.session?.sessionFile && this.config.diagnostics.storeContextManifest) {
      return this.database.manifests.listCalibrationSamples(
        model.provider,
        model.id,
        this.config.modelAwareness.calibrationWindow,
      );
    }
    return [...(this.volatileCalibration.get(modelProfileKey(model.provider, model.id)) ?? [])];
  }

  private switchForModel(model: ModelDescriptor): ModelSwitchManifest {
    const key = modelProfileKey(model.provider, model.id);
    const pending = this.pendingModelSwitch;
    if (pending) {
      this.pendingModelSwitch = undefined;
      return pending;
    }
    const previousKey = this.lastContextProfileKey;
    const separator = previousKey?.indexOf("/") ?? -1;
    const switched = previousKey !== undefined && previousKey !== key;
    return {
      source: "context",
      switched,
      ...(separator > 0 && previousKey ? {
        previousProvider: previousKey.slice(0, separator),
        previousModel: previousKey.slice(separator + 1),
      } : {}),
      profileReused: this.knownModelProfiles.has(key),
      cacheDisposition: switched
        ? "cold-model-switch"
        : previousKey === key
          ? "eligible"
          : "unknown",
    };
  }

  private resolveModelPolicy(model: ModelDescriptor): {
    awareness: ResolvedModelAwareness;
    budget: ContextBudget;
  } {
    const awareness = resolveModelAwareness(
      model,
      this.config.context,
      this.config.modelAwareness,
      this.calibrationSamples(model),
    );
    return {
      awareness,
      budget: calculateContextBudget(
        awareness.profile,
        awareness.contextConfig,
        awareness.calibration,
      ),
    };
  }

  private resolveActiveModel(model: ModelDescriptor): {
    awareness: ResolvedModelAwareness;
    budget: ContextBudget;
    manifest: ModelAwarenessManifest;
  } {
    const { awareness, budget } = this.resolveModelPolicy(model);
    const modelSwitch = this.switchForModel(model);
    const manifest: ModelAwarenessManifest = {
      enabled: this.config.modelAwareness.enabled,
      profileKey: awareness.profileKey,
      overrideKeys: [...awareness.overrideKeys],
      contextWindow: awareness.profile.contextWindow,
      ...(awareness.profile.maxOutputTokens !== undefined
        ? { maxOutputTokens: awareness.profile.maxOutputTokens }
        : {}),
      safetyMarginTokens: awareness.profile.safetyMarginTokens,
      calibration: {
        ...awareness.calibration,
        cache: { ...awareness.calibration.cache },
      },
      adaptive: { ...awareness.limits },
      switch: modelSwitch,
    };
    this.lastModelAwareness = manifest;
    this.lastContextProfileKey = awareness.profileKey;
    this.knownModelProfiles.add(awareness.profileKey);
    return { awareness, budget, manifest };
  }

  private rememberVolatileCalibration(
    manifest: ContextManifest,
    usage: ProviderUsageManifest,
    createdAt: number,
  ): void {
    const key = modelProfileKey(manifest.provider, manifest.model);
    const samples = this.volatileCalibration.get(key) ?? [];
    samples.unshift({
      estimatedTokens: manifest.estimatedInputTokens,
      actualInputTokens: usage.totalInputTokens,
      inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      createdAt,
    });
    this.volatileCalibration.set(
      key,
      samples.slice(0, this.config.modelAwareness.calibrationWindow),
    );
  }

  transformContext(
    event: ContextEvent,
    ctx: ExtensionContext,
    pi: ExtensionAPI,
  ): { messages?: ContextEvent["messages"] } | undefined {
    if (!this.config.enabled) return undefined;
    if (this.phase === "degraded" && this.config.privacy.enabled) {
      try {
        const prepared = this.preparePrivacyContext(event, ctx, pi);
        return prepared.changed ? { messages: prepared.event.messages } : undefined;
      } catch {
        return { messages: event.messages.map(failClosedMessage) };
      }
    }
    if (this.phase !== "observer" && this.phase !== "managed") return undefined;

    let privacyFallback: { messages: ContextEvent["messages"] } | undefined;
    try {
      const preparedPrivacy = this.preparePrivacyContext(event, ctx, pi);
      if (preparedPrivacy.changed) privacyFallback = { messages: preparedPrivacy.event.messages };
      this.syncSessionIndex(ctx);
      this.refreshProjectMemorySources();
      this.refreshProjectIndexIfPending();
      if (this.config.context.mode !== "managed") {
        this.lastRetrieval = emptyRetrievalDiagnostics(
          this.config.context.maxRetrievedHistoryTokens,
          this.config.retrieval.maxResults,
        );
      }
      let effectiveEvent = preparedPrivacy.event;
      let artifactReferences = [] as NonNullable<ContextManifest["artifacts"]>;
      const artifactReferenceByMessageIndex = new Map<number, NonNullable<ContextManifest["artifacts"]>[number]>();
      let artifactized = false;
      if (this.config.context.mode === "managed" && this.artifactManager) {
        const sourceEntryIds = findExactPiMessageSourceIds(event.messages, ctx);
        const transformed = this.artifactManager.transform(
          preparedPrivacy.event.messages,
          sourceEntryIds,
          preparedPrivacy.messageClassifications,
        );
        effectiveEvent = { type: "context", messages: transformed.messages };
        artifactReferences = transformed.artifacts.map((artifact, artifactIndex) => {
          const messageIndex = transformed.artifactMessageIndices[artifactIndex];
          const classification = messageIndex === undefined
            ? undefined
            : preparedPrivacy.messageClassifications[messageIndex];
          return classification ? { ...artifact, classification } : artifact;
        });
        transformed.artifactMessageIndices.forEach((messageIndex, artifactIndex) => {
          const artifact = artifactReferences[artifactIndex];
          if (artifact) artifactReferenceByMessageIndex.set(messageIndex, artifact);
        });
        artifactized = transformed.offloadedCount > 0;
        this.lastArtifacts = this.artifactManager.diagnostics(
          new Set(ctx.sessionManager.getBranch().map((entry) => entry.id)),
        );
        this.logger.debug("artifact_context.processed", {
          offloaded: transformed.offloadedCount,
          offloadedBytes: transformed.offloadedBytes,
          estimatedTokensSaved: transformed.estimatedTokensSaved,
          failed: transformed.failedCount,
        });
      }
      const usage = ctx.getContextUsage();
      const model = snapshotModel(ctx);
      const activeModel = model ? this.resolveActiveModel(model) : undefined;
      const budget = activeModel?.budget;
      const effectiveContextConfig = activeModel?.awareness.contextConfig ?? this.config.context;
      const observedAt = this.now();
      const manifestId = this.idGenerator();
      const baselineClassifications = this.config.privacy.enabled
        ? [
            ...(preparedPrivacy.systemPrompt
              ? [preparedPrivacy.systemClassification ?? this.config.privacy.defaultClassification]
              : []),
            ...preparedPrivacy.tools.map((tool) => tool.classification ?? this.config.privacy.defaultClassification),
            ...preparedPrivacy.messageClassifications,
          ]
        : [];
      const baselinePrivacy = this.privacyManifest(baselineClassifications);
      const baseline = buildPiObserverManifest({
        pi,
        event: effectiveEvent,
        ctx,
        contextConfig: effectiveContextConfig,
        manifestId,
        createdAt: observedAt,
        policyVersion: POLICY_VERSION,
        plannerVersion: OBSERVER_PLANNER_VERSION,
        ...(activeModel ? {
          profile: activeModel.awareness.profile,
          budget: activeModel.budget,
          modelAwareness: activeModel.manifest,
        } : {}),
        systemPrompt: preparedPrivacy.systemPrompt,
        ...(preparedPrivacy.systemClassification
          ? { systemClassification: preparedPrivacy.systemClassification }
          : {}),
        ...(preparedPrivacy.systemPrivacyReason
          ? { systemPrivacyReason: preparedPrivacy.systemPrivacyReason }
          : {}),
        tools: preparedPrivacy.tools,
        messageClassifications: preparedPrivacy.messageClassifications,
        messagePrivacyReasons: preparedPrivacy.messagePrivacyReasons,
        ...(baselinePrivacy ? { privacy: baselinePrivacy } : {}),
        ...(this.lastProject.revision ? { projectRevision: this.lastProject.revision } : {}),
        artifacts: artifactReferences,
      });

      let manifest = baseline;
      let result: { messages?: ContextEvent["messages"] } | undefined = privacyFallback;
      if (this.config.context.mode === "managed" && budget) {
        const planningStartedAt = this.now();
        this.rankingCandidates.clear();
        const requestText = currentRequestText(effectiveEvent.messages);
        const activeEntryIds = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
        const memorySelection: MemorySelection = this.memoryManager?.select(requestText, activeEntryIds) ?? {
          pins: [],
          memories: [],
          excludedPins: 0,
          excludedMemories: 0,
          pinTokens: 0,
          memoryTokens: 0,
        };
        if (this.memoryManager) this.lastMemory = this.memoryManager.diagnostics();
        const retrieval = this.retrieveHistory(
          effectiveEvent,
          ctx,
          effectiveContextConfig.maxRetrievedHistoryTokens,
        );
        const project = this.retrieveProjectKnowledge(
          requestText,
          effectiveContextConfig.maxProjectTokens,
        );
        this.lastRetrieval = {
          ...retrieval,
          plannerExcludedCount: retrieval.selected.length,
          selectedTokens: 0,
          selected: [],
        };
        this.lastProject = {
          ...project,
          plannerExcludedCount: project.selected.length,
          selectedTokens: 0,
          selected: [],
        };
        const rawSupplements: Array<SupplementalContextMessage<ContextEvent["messages"][number]>> = [
          ...memorySelection.pins.map((evidence) => ({
            id: `pin:${evidence.item.id}`,
            message: evidence.message,
            kind: "pin" as const,
            sourceIds: [evidence.item.id],
            score: 950,
            reason: evidence.reason,
            ...(evidence.item.classification ? { classification: evidence.item.classification } : {}),
          })),
          ...memorySelection.memories.map((evidence) => ({
            id: `memory:${evidence.item.id}`,
            message: evidence.message,
            kind: "memory" as const,
            sourceIds: [evidence.item.id],
            score: 90 + Math.min(0.999999, Math.max(0, evidence.score) / 1_000),
            reason: evidence.reason,
            rankingFeatures: createRankingFeatures({
              ...evidence.rankingFeatures,
              priorSelected: this.priorRankingSelection.get(`memory:${evidence.item.id}`) ?? 0,
            }),
            ...(evidence.item.classification ? { classification: evidence.item.classification } : {}),
          })),
          ...retrieval.selected.map((evidence) => ({
            id: `retrieval:${evidence.entryId}`,
            message: evidence.message,
            kind: "retrieval" as const,
            sourceIds: [evidence.entryId],
            score: 85 + Math.min(0.999999, Math.max(0, evidence.score) / 1_000),
            reason: `Historical evidence: ${evidence.reason}`,
            rankingFeatures: createRankingFeatures({
              ...evidence.rankingFeatures,
              priorSelected: this.priorRankingSelection.get(`retrieval:${evidence.entryId}`) ?? 0,
            }),
          })),
          ...project.selected.map((evidence) => ({
            id: `project:${evidence.snippetId}`,
            message: evidence.message,
            kind: "project" as const,
            sourceIds: [evidence.sourceId],
            score: 80 + Math.min(0.999999, Math.max(0, evidence.score) / 1_000),
            reason: `Project source: ${evidence.reason}`,
            projectSnippet: evidence.manifestRef,
            rankingFeatures: createRankingFeatures({
              ...evidence.rankingFeatures,
              priorSelected: this.priorRankingSelection.get(`project:${evidence.snippetId}`) ?? 0,
            }),
          })),
        ];
        const privacyExcludedSources: ExcludedContextSource[] = [];
        const supplementalMessages = rawSupplements.flatMap((supplement) => {
          if (!this.config.privacy.enabled || !this.privacyEngine || !model) return [supplement];
          const sanitized = this.privacyEngine.sanitizeMessage(
            supplement.message,
            model.provider,
            supplement.classification,
          );
          const reason = privacyReason(sanitized.blockedBlocks, sanitized.secretRedactions);
          this.lastPrivacy = {
            ...this.lastPrivacy,
            blockedBlocks: this.lastPrivacy.blockedBlocks + sanitized.blockedBlocks,
            secretRedactions: this.lastPrivacy.secretRedactions + sanitized.secretRedactions,
          };
          if (sanitized.blockedBlocks > 0) {
            privacyExcludedSources.push({
              sourceId: supplement.sourceIds[0],
              tokens: estimateMessagesTokens([supplement.message]),
              kind: supplement.kind,
              classification: sanitized.classification,
              score: supplement.score,
              reason: `${reason ?? "Classified source excluded"}; source omitted before provider serialization`,
            });
            return [];
          }
          return [{
            ...supplement,
            message: sanitized.value,
            classification: sanitized.classification,
            ...(reason ? { privacyReason: reason } : {}),
          }];
        });
        this.lastPrivacy = {
          ...this.lastPrivacy,
          excludedSources: this.lastPrivacy.excludedSources + privacyExcludedSources.length,
        };
        const learnedCandidates = supplementalMessages.flatMap((supplement) =>
          supplement.kind !== "pin" && supplement.rankingFeatures
            ? [{
                id: supplement.id,
                staticScore: supplement.score,
                features: supplement.rankingFeatures,
                value: supplement,
              }]
            : []
        );
        const ranking = rankCandidates(learnedCandidates, {
          mode: this.config.ranking.mode,
          ...(this.rankingModel ? { model: this.rankingModel } : {}),
          now: this.now,
          maxLatencyMs: this.config.ranking.maxLatencyMs,
        });
        this.lastRanking = ranking.diagnostics;
        const rankedById = new Map(ranking.ranked.map((candidate) => [candidate.id, candidate]));
        const rankedSupplementalMessages = supplementalMessages.map((supplement) => {
          const ranked = rankedById.get(supplement.id);
          if (!ranked) return supplement;
          return {
            ...supplement,
            score: ranked.effectiveScore,
            reason: ranking.diagnostics.status === "active"
              ? `${supplement.reason}; learned rank ${ranked.learnedScore.toFixed(6)}`
              : supplement.reason,
          };
        });
        const plan = planManagedContext({
          messages: effectiveEvent.messages,
          fixedTokens: baseline.composition.systemTokens + baseline.composition.toolTokens,
          budget,
          config: effectiveContextConfig,
          pinnedMessageIndices: findPiPinnedMessageIndices(effectiveEvent, ctx),
          supplementalMessages: rankedSupplementalMessages,
          ...(ranking.diagnostics.status === "active"
            ? { supplementalSelectionOrder: ranking.ranked.map((candidate) => candidate.id) }
            : {}),
          ...(this.config.privacy.enabled
            ? {
                messageClassifications: preparedPrivacy.messageClassifications,
                messagePrivacyReasons: preparedPrivacy.messagePrivacyReasons,
              }
            : {}),
        });
        if (plan.mode === "managed") {
          for (const candidate of learnedCandidates) {
            this.rankingCandidates.set(candidate.id, { ...candidate.features });
          }
        }
        const selectedPinIds = new Set(
          plan.selected.flatMap((metadata) => metadata.kind === "pin" && metadata.sourceId ? [metadata.sourceId] : []),
        );
        const selectedMemoryIds = new Set(
          plan.selected.flatMap((metadata) => metadata.kind === "memory" && metadata.sourceId ? [metadata.sourceId] : []),
        );
        this.memoryManager?.applyPlannerSelection(selectedPinIds, selectedMemoryIds);
        if (this.memoryManager) this.lastMemory = this.memoryManager.diagnostics();
        const selectedPinReferences = memorySelection.pins
          .filter((evidence) => selectedPinIds.has(evidence.item.id))
          .map((evidence) => evidence.manifestRef);
        const selectedMemoryReferences = memorySelection.memories
          .filter((evidence) => selectedMemoryIds.has(evidence.item.id))
          .map((evidence) => evidence.manifestRef);
        const selectedRetrievalIds = new Set(
          plan.selected.flatMap((metadata) => metadata.retrievedEventIds ?? []),
        );
        const plannerSelected = retrieval.selected.filter((evidence) => selectedRetrievalIds.has(evidence.entryId));
        this.lastRetrieval = {
          ...retrieval,
          plannerExcludedCount: retrieval.selected.length - plannerSelected.length,
          selectedTokens: plannerSelected.reduce((total, evidence) => total + evidence.estimatedTokens, 0),
          selected: plannerSelected,
        };
        const selectedProjectIds = new Set(
          plan.selected.flatMap((metadata) => metadata.projectSnippet?.snippetId ? [metadata.projectSnippet.snippetId] : []),
        );
        const plannerSelectedProject = project.selected.filter((evidence) => selectedProjectIds.has(evidence.snippetId));
        for (const supplement of rankedSupplementalMessages) {
          if (supplement.kind === "pin" || !supplement.rankingFeatures) continue;
          const selected = supplement.kind === "memory"
            ? selectedMemoryIds.has(supplement.sourceIds[0] ?? "")
            : supplement.kind === "retrieval"
              ? selectedRetrievalIds.has(supplement.sourceIds[0] ?? "")
              : Boolean(supplement.projectSnippet?.snippetId
                && selectedProjectIds.has(supplement.projectSnippet.snippetId));
          this.rememberPriorRankingSelection(supplement.id, selected ? 1 : 0);
        }
        this.lastProject = {
          ...project,
          plannerExcludedCount: project.selected.length - plannerSelectedProject.length,
          selectedTokens: plannerSelectedProject.reduce((total, evidence) => total + evidence.estimatedTokens, 0),
          selected: plannerSelectedProject,
        };
        plan.planning.durationMs = Math.max(0, this.now() - planningStartedAt);
        const plannedEvent: ContextEvent = { type: "context", messages: plan.messages };
        const selectedArtifactReferences = plan.mode === "managed"
          ? plan.selected.flatMap((metadata) => {
              const artifact = artifactReferenceByMessageIndex.get(metadata.originalIndex);
              return artifact ? [artifact] : [];
            })
          : artifactReferences;
        const planMetadataByIndex = new Map(
          [...plan.selected, ...plan.excluded].map((metadata) => [metadata.originalIndex, metadata] as const),
        );
        const planMessageClassifications = plan.originalMessages.map(
          (_message, index) => planMetadataByIndex.get(index)?.classification
            ?? this.config.privacy.defaultClassification,
        );
        const planMessagePrivacyReasons = plan.originalMessages.map(
          (_message, index) => planMetadataByIndex.get(index)?.privacyReason,
        );
        const managedPrivacy = this.privacyManifest(this.config.privacy.enabled
          ? [
              ...(preparedPrivacy.systemPrompt
                ? [preparedPrivacy.systemClassification ?? this.config.privacy.defaultClassification]
                : []),
              ...preparedPrivacy.tools.map((tool) => tool.classification ?? this.config.privacy.defaultClassification),
              ...plan.selected.map((metadata) => metadata.classification ?? this.config.privacy.defaultClassification),
            ]
          : []);
        manifest = buildPiObserverManifest({
          pi,
          event: plannedEvent,
          ctx,
          contextConfig: effectiveContextConfig,
          manifestId,
          createdAt: observedAt,
          policyVersion: POLICY_VERSION,
          plannerVersion: PLANNER_VERSION,
          ...(activeModel ? {
            profile: activeModel.awareness.profile,
            budget: activeModel.budget,
            modelAwareness: activeModel.manifest,
          } : {}),
          plan,
          systemPrompt: preparedPrivacy.systemPrompt,
          ...(preparedPrivacy.systemClassification
            ? { systemClassification: preparedPrivacy.systemClassification }
            : {}),
          ...(preparedPrivacy.systemPrivacyReason
            ? { systemPrivacyReason: preparedPrivacy.systemPrivacyReason }
            : {}),
          tools: preparedPrivacy.tools,
          messageClassifications: planMessageClassifications,
          messagePrivacyReasons: planMessagePrivacyReasons,
          privacyExcludedSources,
          ...(managedPrivacy ? { privacy: managedPrivacy } : {}),
          ...(this.lastProject.revision ? { projectRevision: this.lastProject.revision } : {}),
          pins: selectedPinReferences,
          memories: selectedMemoryReferences,
          artifacts: selectedArtifactReferences,
          artifactSources: artifactReferences,
        });
        if (plan.mode === "managed") result = { messages: plan.messages };
        else if (artifactized) result = { messages: effectiveEvent.messages };
      } else if (this.config.context.mode === "managed" && artifactized) {
        result = { messages: effectiveEvent.messages };
      }

      manifest = {
        ...manifest,
        ranking: { ...this.lastRanking },
        nativeContinuation: this.nativeContinuation.initialManifest(
          manifest.provider,
          manifest.model,
          manifest.planning?.mode === "managed",
          ctx.model?.api,
        ),
      };

      this.observation = {
        mode: manifest.planning?.mode ?? "observer",
        messageCount: manifest.composition.messageCount,
        estimatedMessageTokens: manifest.composition.messageTokens,
        originalMessageCount: manifest.planning?.originalMessageCount ?? event.messages.length,
        originalEstimatedMessageTokens: manifest.planning?.originalMessageTokens
          ?? estimateMessagesTokens(event.messages),
        ...(usage?.tokens !== null && usage?.tokens !== undefined ? { reportedTokens: usage.tokens } : {}),
        ...(manifest.planning?.durationMs !== undefined
          ? { planningDurationMs: manifest.planning.durationMs }
          : {}),
        ...(manifest.planning?.fallbackReason
          ? { fallbackReason: manifest.planning.fallbackReason }
          : {}),
        observedAt,
        ...(budget ? { budget } : {}),
      };
      if (this.config.quality.enabled) {
        this.pendingQuality.push({ manifest, contextConfig: effectiveContextConfig, recordedAt: observedAt });
        const pendingLimit = Math.min(this.config.quality.maxSamples, 256);
        if (this.pendingQuality.length > pendingLimit) this.pendingQuality.splice(0, this.pendingQuality.length - pendingLimit);
      }
      this.lastManifest = manifest;
      this.pendingManifestId = manifest.id;
      if (this.config.diagnostics.storeContextManifest && this.session?.sessionFile) {
        this.database?.manifests.save(manifest);
      }

      this.logger.trace("context.planned", {
        sessionId: this.session?.sessionId,
        manifestId: manifest.id,
        mode: manifest.planning?.mode ?? "observer",
        originalMessageCount: this.observation.originalMessageCount,
        selectedMessageCount: manifest.composition.messageCount,
        estimatedInputTokens: manifest.estimatedInputTokens,
        planningDurationMs: manifest.planning?.durationMs,
        promptHash: manifest.promptHash,
      });
      return result;
    } catch (error) {
      // Planner and observer failures must never replace or block Pi's context.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("context.planner_failed", {
        error: this.config.privacy.enabled
          ? error instanceof Error ? error.name : "UnknownError"
          : message,
      });
      if (privacyFallback) return privacyFallback;
      return this.config.privacy.enabled
        ? { messages: event.messages.map(failClosedMessage) }
        : undefined;
    }
  }

  enforceProviderPayload(payload: unknown, ctx: ExtensionContext): unknown {
    if (!this.config.privacy.enabled || !this.privacyEngine) return payload;
    const provider = ctx.model?.provider ?? this.lastPrivacy.provider ?? "unknown";
    try {
      const sanitized = this.privacyEngine.sanitizeProviderPayload(payload, provider);
      const redactions = sanitized.blockedBlocks + sanitized.secretRedactions;
      this.lastPrivacy = {
        ...this.lastPrivacy,
        enabled: true,
        provider,
        destination: this.privacyEngine.policy(provider).destination,
        allowedClassifications: [...this.privacyEngine.policy(provider).allowedClassifications],
        blockedBlocks: this.lastPrivacy.blockedBlocks + sanitized.blockedBlocks,
        secretRedactions: this.lastPrivacy.secretRedactions + sanitized.secretRedactions,
        providerChecks: this.lastPrivacy.providerChecks + 1,
        providerPayloadRedactions: this.lastPrivacy.providerPayloadRedactions + redactions,
        enforcement: "context-and-provider",
      };
      this.updateManifestPrivacy();
      this.logger.debug("privacy.provider_enforced", {
        provider,
        destination: this.lastPrivacy.destination,
        blockedBlocks: sanitized.blockedBlocks,
        secretRedactions: sanitized.secretRedactions,
      });
      return sanitized.value;
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.lastPrivacy = {
        ...this.lastPrivacy,
        enabled: true,
        provider,
        providerChecks: this.lastPrivacy.providerChecks + 1,
        providerPayloadRedactions: this.lastPrivacy.providerPayloadRedactions + 1,
        enforcement: "context-and-provider",
        warnings: [...this.lastPrivacy.warnings, "Provider payload replaced after privacy enforcement failure"],
      };
      this.updateManifestPrivacy();
      this.logger.error("privacy.provider_fail_closed", { provider, errorName });
      return {};
    }
  }

  private updateManifestPrivacy(): void {
    if (!this.lastManifest?.privacy) return;
    const updatedPrivacy = this.privacyManifest(
      Object.entries(this.lastPrivacy.selectedClassifications)
        .flatMap(([classification, count]) => Array.from(
          { length: count },
          () => classification as PrivacyClassification,
        )),
    );
    if (!updatedPrivacy) return;
    this.lastManifest = { ...this.lastManifest, privacy: updatedPrivacy };
    if (this.config.diagnostics.storeContextManifest && this.session?.sessionFile) {
      this.database?.manifests.save(this.lastManifest);
    }
  }

  nativeContinuationProviderIds(): string[] {
    return this.nativeContinuation.providerIds();
  }

  nativeContinuationProviderRegistered(provider: string): void {
    this.nativeContinuation.registerProvider(provider);
    this.logger.info("native_continuation.provider_registered", { provider });
  }

  nativeContinuationProviderRegistrationFailed(provider: string, error: unknown): void {
    this.nativeContinuation.providerRegistrationFailed(provider);
    this.logger.warn("native_continuation.provider_registration_failed", {
      provider,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  }

  prepareNativeContinuation(
    payload: unknown,
    model: Model<Api>,
    requestSessionId: string | undefined,
    options: {
      forceManagedReplay: boolean;
      retryOfContinuation: boolean;
      fallbackReason?: string;
    },
  ): PreparedNativeContinuation {
    try {
      const manifest = this.lastManifest?.provider === model.provider
        && this.lastManifest.model === model.id
        ? this.lastManifest
        : undefined;
      const prepared = this.nativeContinuation.prepare({
        payload,
        provider: model.provider,
        model: model.id,
        api: model.api,
        ...(requestSessionId ? { requestSessionId } : {}),
        canonicalSessionId: this.session?.sessionId ?? "",
        ...(manifest ? { manifestId: manifest.id } : {}),
        ...(manifest?.branchLeafId ? { branchLeafId: manifest.branchLeafId } : {}),
        managed: this.phase === "managed" && manifest?.planning?.mode === "managed",
        forceManagedReplay: options.forceManagedReplay,
        retryOfContinuation: options.retryOfContinuation,
        ...(options.fallbackReason ? { fallbackReason: options.fallbackReason } : {}),
      });
      if (prepared.tracked && prepared.decision) {
        this.updateManifestNativeContinuation(manifest?.id, prepared.decision);
        this.logger.debug("native_continuation.request_prepared", {
          provider: model.provider,
          model: model.id,
          mode: prepared.decision.mode,
          fullInputItems: prepared.decision.fullInputItems,
          sentInputItems: prepared.decision.sentInputItems,
          omittedInputItems: prepared.decision.omittedInputItems,
          fallbackReason: prepared.decision.fallbackReason,
          invalidationReason: prepared.decision.invalidationReason,
          retry: prepared.decision.retry,
        });
      }
      return prepared;
    } catch (error) {
      this.nativeContinuation.invalidate("continuation-preparation-failed");
      this.logger.warn("native_continuation.preparation_failed", {
        provider: model.provider,
        model: model.id,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      return { payload, tracked: false };
    }
  }

  beginNativeContinuationManagedReplayRetry(attempt: NativeContinuationAttempt): void {
    this.nativeContinuation.beginManagedReplayRetry(attempt);
  }

  completeNativeContinuation(
    attempt: NativeContinuationAttempt,
    message: AssistantMessage,
    responseItemHashes: readonly string[],
  ): void {
    const decision = message.stopReason === "deferred"
      ? this.nativeContinuation.fail(attempt, "deferred-response-not-continuable")
      : this.nativeContinuation.complete(attempt, message.responseId, responseItemHashes);
    this.updateManifestNativeContinuation(attempt.manifestId, decision);
    this.logger.debug("native_continuation.request_completed", {
      provider: attempt.provider,
      model: attempt.model,
      mode: decision.mode,
      stateReused: decision.stateReused,
      retry: decision.retry,
      responseStateAvailable: this.nativeContinuation.diagnostics().stateAvailable,
    });
  }

  failNativeContinuation(attempt: NativeContinuationAttempt, reason: string): void {
    const decision = this.nativeContinuation.fail(attempt, reason);
    this.updateManifestNativeContinuation(attempt.manifestId, decision);
    this.logger.debug("native_continuation.request_failed", {
      provider: attempt.provider,
      model: attempt.model,
      mode: decision.mode,
      reason,
      retry: decision.retry,
    });
  }

  shouldRetryNativeContinuationManagedReplay(): boolean {
    return this.nativeContinuation.shouldRetryManagedReplay();
  }

  invalidateNativeContinuation(reason: string): void {
    this.nativeContinuation.invalidate(reason);
  }

  private updateManifestNativeContinuation(
    manifestId: string | undefined,
    continuation: NativeContinuationManifest,
  ): void {
    if (!manifestId || this.lastManifest?.id !== manifestId) return;
    this.lastManifest = {
      ...this.lastManifest,
      nativeContinuation: { ...continuation },
    };
    if (!this.config.diagnostics.storeContextManifest || !this.session?.sessionFile) return;
    try {
      this.database?.manifests.save(this.lastManifest);
    } catch (error) {
      this.logger.warn("native_continuation.manifest_persistence_failed", {
        manifestId,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  recordAssistantUsage(message: unknown): void {
    if (!this.pendingManifestId || !message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant") return;

    const manifestId = this.pendingManifestId;
    this.pendingManifestId = undefined;
    if (record.stopReason === "error" || record.stopReason === "aborted") return;
    const usage = record.usage;
    if (!usage || typeof usage !== "object") return;
    const usageRecord = usage as Record<string, unknown>;
    const providerUsage = providerUsageManifest({
      inputTokens: numericUsage(usageRecord.input),
      cacheReadTokens: numericUsage(usageRecord.cacheRead),
      cacheWriteTokens: numericUsage(usageRecord.cacheWrite),
    });
    if (providerUsage.totalInputTokens <= 0) return;

    const manifest = this.lastManifest?.id === manifestId ? this.lastManifest : undefined;
    if (manifest) {
      this.lastManifest = {
        ...manifest,
        actualInputTokens: providerUsage.totalInputTokens,
        providerUsage,
      };
    }
    const createdAt = this.now();
    const persisted = Boolean(
      this.config.diagnostics.storeContextManifest
      && this.session?.sessionFile
      && this.database,
    );
    try {
      if (persisted) {
        const updated = this.database?.manifests.recordProviderUsage(
          manifestId,
          providerUsage,
          createdAt,
        );
        if (updated && this.lastManifest?.id === manifestId) this.lastManifest = updated;
      } else if (manifest?.estimatedInputTokens) {
        this.rememberVolatileCalibration(manifest, providerUsage, createdAt);
      }
    } catch (error) {
      if (manifest?.estimatedInputTokens) {
        this.rememberVolatileCalibration(manifest, providerUsage, createdAt);
      }
      this.logger.warn("context.usage_persistence_failed", {
        manifestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.logger.debug("context.actual_usage_recorded", {
      manifestId,
      inputTokens: providerUsage.inputTokens,
      cacheReadTokens: providerUsage.cacheReadTokens,
      cacheWriteTokens: providerUsage.cacheWriteTokens,
      actualInputTokens: providerUsage.totalInputTokens,
    });
  }

  beforeCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): ReturnType<CompactionCoordinator["beforeCompact"]> {
    return this.compaction?.beforeCompact(event, ctx) ?? Promise.resolve(undefined);
  }

  afterCompaction(event: SessionCompactEvent, ctx: ExtensionContext): void {
    this.nativeContinuation.invalidate("session-compacted");
    this.compaction?.afterCompaction(event, ctx);
  }

  compactionFailed(event: SessionCompactFailedLike): void {
    this.compaction?.compactionFailed(event);
  }

  afterAgentSettled(ctx: ExtensionContext): void {
    this.flushContextQuality();
    if (this.compaction) this.compaction.afterAgentSettled(ctx);
    else this.syncSessionIndex(ctx);
    this.refreshProjectMemorySources();
    this.refreshProjectIndex();
  }

  projectMayHaveChanged(toolName?: string): void {
    if (toolName && READ_ONLY_PROJECT_TOOLS.has(toolName.toLowerCase())) return;
    if (this.projectKnowledge) this.projectRefreshPending = true;
  }

  sessionTreeChanged(ctx: ExtensionContext): void {
    this.nativeContinuation.invalidate("session-branch-changed");
    this.syncSessionIndex(ctx);
  }

  latestManifest(): ContextManifest | undefined {
    return this.lastManifest;
  }

  summaryGraph(ctx: ExtensionContext): SummaryGraphDiagnostics {
    return this.compaction?.summaryGraph(ctx) ?? defaultSummaryGraphDiagnostics();
  }

  retrievalDiagnostics(): RetrievalDiagnostics {
    return this.lastRetrieval;
  }

  listPins(activeOnly = false): PinItem[] {
    return this.memoryManager?.listPins(activeOnly) ?? [];
  }

  listMemories(activeOnly = false): MemoryItem[] {
    return this.memoryManager?.listMemories(activeOnly) ?? [];
  }

  projectMemorySources(): ProjectMemorySource[] {
    return this.lastCrossSessionMemory.sources.map((source) => ({ ...source }));
  }

  setProjectMemorySourceExcluded(
    sessionId: string,
    excluded: boolean,
    reason?: string,
  ): ProjectMemorySource[] {
    if (!this.projectMemorySynchronizer || !this.memoryManager) {
      throw new Error("Cross-session project memory is unavailable for this session");
    }
    this.lastCrossSessionMemory = this.projectMemorySynchronizer.setExcluded(
      sessionId,
      excluded,
      reason,
    );
    this.memoryManager.setCrossSessionDiagnostics(this.lastCrossSessionMemory);
    this.lastMemory = this.memoryManager.diagnostics();
    return this.projectMemorySources();
  }

  recordRankingFeedback(
    candidateId: string,
    label: RankingFeedbackLabel,
    classification: PrivacyClassification | undefined,
    ctx: ExtensionContext,
    appendEntry: CustomEntryAppender,
  ): RankingFeedbackEntry {
    const normalizedId = candidateId.trim();
    let features = this.rankingCandidates.get(normalizedId);
    let resolvedId = normalizedId;
    if (!features) {
      const matches = [...this.rankingCandidates].filter(([id]) => id.endsWith(`:${normalizedId}`));
      if (matches.length === 1) {
        resolvedId = matches[0]?.[0] ?? normalizedId;
        features = matches[0]?.[1];
      }
    }
    if (!features) {
      throw new Error(`Ranking candidate ${candidateId} is not available in the latest managed context`);
    }
    if (!this.session) throw new Error("Canonical session identity is unavailable");
    const feedback = createRankingFeedback({
      feedbackId: this.idGenerator(),
      createdAt: this.now(),
      repositoryIdentity: this.session.projectPath,
      candidateKey: resolvedId,
      label,
      classification: classification ?? this.config.privacy.defaultClassification,
      features,
    });
    appendEntry(RANKING_FEEDBACK_CUSTOM_ENTRY_TYPE, feedback);
    this.syncSessionIndex(ctx);
    this.logger.info("ranking.feedback_recorded", {
      feedbackId: feedback.feedbackId,
      label,
      classification: feedback.classification,
    });
    return feedback;
  }

  trainRankingModel(ctx: ExtensionContext): RankingTrainingResult {
    if (!this.rankingModelPath) throw new Error("Ranking model path is unavailable");
    const projection = projectRankingLabels(
      ctx.sessionManager.getBranch(),
      this.config.ranking.maxTrainingSamples,
    );
    const model = trainLearnedRankingModel(projection.samples, {
      createdAt: this.now(),
      minimumSamples: this.config.ranking.minimumTrainingSamples,
    });
    saveLearnedRankingModel(this.rankingModelPath, model);
    this.rankingModel = model;
    this.rankingWarnings = [...projection.warnings];
    this.lastRanking = rankCandidates([], {
      mode: this.config.ranking.mode,
      model,
      now: this.now,
      maxLatencyMs: this.config.ranking.maxLatencyMs,
    }).diagnostics;
    if (this.config.ranking.mode === "off") {
      this.lastRanking = { ...this.lastRanking, modelId: model.modelId };
    }
    this.logger.info("ranking.model_trained", {
      modelId: model.modelId,
      samples: model.training.sampleCount,
      repositories: model.training.repositoryCount,
      promoted: Boolean(model.promotion?.eligible),
    });
    return {
      modelId: model.modelId,
      modelPath: this.rankingModelPath,
      sampleCount: model.training.sampleCount,
      positiveSamples: model.training.positiveSamples,
      negativeSamples: model.training.negativeSamples,
      repositoryCount: model.training.repositoryCount,
      warnings: [...projection.warnings],
    };
  }

  createPin(
    input: CreatePinInput,
    ctx: ExtensionContext,
    appendEntry: CustomEntryAppender,
  ): { pin: PinItem; duplicate: boolean } {
    const manager = this.requireMemoryManager();
    const branchLeafId = ctx.sessionManager.getLeafId();
    const proposal = manager.proposePin({
      ...input,
      ...(input.scope === "branch" && branchLeafId ? { branchLeafId } : {}),
      activeEntryIds: new Set(ctx.sessionManager.getBranch().map((entry) => entry.id)),
    });
    if (proposal.duplicateId) {
      const duplicate = manager.getPin(proposal.duplicateId);
      if (!duplicate) throw new Error(`Duplicate pin ${proposal.duplicateId} disappeared`);
      return { pin: duplicate, duplicate: true };
    }
    if (!proposal.mutation || proposal.mutation.operation === "status") {
      throw new Error("Pin mutation was not created");
    }
    appendEntry(PIN_CUSTOM_ENTRY_TYPE, proposal.mutation);
    this.syncSessionIndex(ctx);
    this.reconcileMemory(ctx);
    const id = proposal.mutation.item.id;
    const pin = manager.getPin(id);
    if (!pin) throw new Error(`Pin ${id} was not materialized`);
    this.logger.info("pin.created", { pinId: pin.id, scope: pin.scope });
    return { pin, duplicate: false };
  }

  unpin(pinId: string, reason: string | undefined, ctx: ExtensionContext, appendEntry: CustomEntryAppender): PinItem {
    const manager = this.requireMemoryManager();
    const mutation = manager.proposeUnpin(pinId, reason);
    appendEntry(PIN_CUSTOM_ENTRY_TYPE, mutation);
    this.syncSessionIndex(ctx);
    this.reconcileMemory(ctx);
    const pin = manager.getPin(pinId);
    if (!pin) throw new Error(`Pin ${pinId} was not materialized`);
    this.logger.info("pin.deleted", { pinId });
    return pin;
  }

  createMemory(
    input: CreateMemoryInput,
    ctx: ExtensionContext,
    appendEntry: CustomEntryAppender,
  ): { memory: MemoryItem; duplicate: boolean } {
    const manager = this.requireMemoryManager();
    const proposal = manager.proposeMemory({
      ...input,
      activeEntryIds: new Set(ctx.sessionManager.getBranch().map((entry) => entry.id)),
    });
    if (proposal.duplicateId) {
      const duplicate = manager.getMemory(proposal.duplicateId);
      if (!duplicate) throw new Error(`Duplicate memory ${proposal.duplicateId} disappeared`);
      return { memory: duplicate, duplicate: true };
    }
    if (!proposal.mutation || proposal.mutation.operation !== "add") {
      throw new Error("Memory mutation was not created");
    }
    appendEntry(MEMORY_CUSTOM_ENTRY_TYPE, proposal.mutation);
    this.syncSessionIndex(ctx);
    this.reconcileMemory(ctx);
    const memory = manager.getMemory(proposal.mutation.item.id);
    if (!memory) throw new Error(`Memory ${proposal.mutation.item.id} was not materialized`);
    this.logger.info("memory.created", { memoryId: memory.id, scope: memory.scope, hasKey: Boolean(memory.key) });
    return { memory, duplicate: false };
  }

  supersedeMemory(
    previousId: string,
    claim: string,
    sourceEntryIds: string[],
    classification: PrivacyClassification | undefined,
    ctx: ExtensionContext,
    appendEntry: CustomEntryAppender,
  ): MemoryItem {
    const manager = this.requireMemoryManager();
    const mutation = manager.proposeMemorySupersession({
      previousId,
      claim,
      sourceEntryIds,
      ...(classification ? { classification } : {}),
      activeEntryIds: new Set(ctx.sessionManager.getBranch().map((entry) => entry.id)),
    });
    if (mutation.operation !== "supersede") throw new Error("Memory supersession was not created");
    appendEntry(MEMORY_CUSTOM_ENTRY_TYPE, mutation);
    this.syncSessionIndex(ctx);
    this.reconcileMemory(ctx);
    const memory = manager.getMemory(mutation.item.id);
    if (!memory) throw new Error(`Memory ${mutation.item.id} was not materialized`);
    this.logger.info("memory.superseded", { previousId, memoryId: memory.id });
    return memory;
  }

  setMemoryStatus(
    memoryId: string,
    status: "invalid" | "expired",
    reason: string | undefined,
    ctx: ExtensionContext,
    appendEntry: CustomEntryAppender,
  ): MemoryItem {
    const manager = this.requireMemoryManager();
    const mutation = manager.proposeMemoryStatus(memoryId, status, reason);
    appendEntry(MEMORY_CUSTOM_ENTRY_TYPE, mutation);
    this.syncSessionIndex(ctx);
    this.reconcileMemory(ctx);
    const memory = manager.getMemory(memoryId);
    if (!memory) throw new Error(`Memory ${memoryId} was not materialized`);
    this.logger.info("memory.status_changed", { memoryId, status });
    return memory;
  }

  searchArtifact(
    artifactId: string,
    query: string,
    maxMatches: number,
    ctx: ExtensionContext,
  ): ArtifactSearchResult {
    if (!this.artifactManager) throw new Error("Artifact Store is unavailable for this session");
    let result = this.artifactManager.search(
      artifactId,
      query,
      maxMatches,
      new Set(ctx.sessionManager.getBranch().map((entry) => entry.id)),
    );
    if (this.config.privacy.enabled && this.privacyEngine) {
      const sanitized = this.privacyEngine.sanitizeText(
        result.text,
        ctx.model?.provider ?? "unknown",
        result.classification,
      );
      result = {
        ...result,
        text: sanitized.value,
        ...(sanitized.blockedBlocks > 0 ? { matches: 0 } : {}),
      };
      this.lastPrivacy = {
        ...this.lastPrivacy,
        blockedBlocks: this.lastPrivacy.blockedBlocks + sanitized.blockedBlocks,
        secretRedactions: this.lastPrivacy.secretRedactions + sanitized.secretRedactions,
      };
    }
    this.lastArtifacts = this.artifactManager.diagnostics(
      new Set(ctx.sessionManager.getBranch().map((entry) => entry.id)),
    );
    return result;
  }

  modelChanged(
    provider: string,
    modelId: string,
    previousProvider?: string,
    previousModelId?: string,
    source: "set" | "cycle" | "restore" = "set",
  ): void {
    const key = modelProfileKey(provider, modelId);
    const explicitPrevious = previousProvider && previousModelId
      ? modelProfileKey(previousProvider, previousModelId)
      : undefined;
    const previousKey = explicitPrevious ?? this.lastContextProfileKey;
    const separator = previousKey?.indexOf("/") ?? -1;
    const switched = previousKey !== undefined && previousKey !== key;
    if (switched) this.nativeContinuation.invalidate("provider-or-model-changed");
    this.pendingModelSwitch = {
      source,
      switched,
      ...(separator > 0 && previousKey ? {
        previousProvider: previousKey.slice(0, separator),
        previousModel: previousKey.slice(separator + 1),
      } : {}),
      profileReused: this.knownModelProfiles.has(key),
      cacheDisposition: switched
        ? "cold-model-switch"
        : previousKey === key
          ? "eligible"
          : "unknown",
    };
    if (this.config.privacy.enabled && this.privacyEngine) {
      const policy = this.privacyEngine.policy(provider);
      this.lastPrivacy = {
        ...this.lastPrivacy,
        enabled: true,
        provider,
        destination: policy.destination,
        allowedClassifications: [...policy.allowedClassifications],
        enforcement: "context",
      };
    }
    this.logger.info("model.changed", {
      provider,
      modelId,
      previousProvider,
      previousModelId,
      source,
      profileReused: this.pendingModelSwitch.profileReused,
    });
  }

  private initializeMemory(ctx: ExtensionContext): void {
    this.projectMemorySynchronizer = undefined;
    this.lastCrossSessionMemory = disabledCrossSessionMemoryDiagnostics();
    if (this.config.context.mode !== "managed" || !this.config.memory.enabled) {
      this.memoryManager = undefined;
      this.lastMemory = disabledMemoryDiagnostics();
      return;
    }
    if (!this.database || !this.indexer || !this.session?.sessionFile) {
      this.memoryManager = undefined;
      this.lastMemory = disabledMemoryDiagnostics("Memory and pins require a persisted Pi session");
      return;
    }
    try {
      const projectPath = canonicalProjectPath(this.session.projectPath);
      const projectTrusted = ctx.isProjectTrusted();
      this.memoryManager = new MemoryManager(
        this.database.memory,
        this.config.memory,
        this.config.context.maxPinnedTokens,
        this.config.context.maxMemoryTokens,
        this.session.sessionId,
        projectPath,
        projectTrusted,
        this.now,
        this.idGenerator,
      );
      if (existsSync(this.session.sessionFile)) this.reconcileMemory(ctx);
      else this.lastMemory = this.memoryManager.diagnostics();

      if (this.config.memory.crossSession && projectTrusted) {
        this.projectMemorySynchronizer = new ProjectMemorySynchronizer(
          this.database.memory,
          this.indexer,
          {
            projectPath,
            activeSessionId: this.session.sessionId,
            activeSessionFile: this.session.sessionFile,
            maxSessions: this.config.memory.maxProjectSessions,
            logger: this.logger,
            now: this.now,
          },
        );
        this.refreshProjectMemorySources();
      } else {
        const reason = this.config.memory.crossSession
          ? "Cross-session project memory requires a trusted Pi project"
          : undefined;
        this.lastCrossSessionMemory = disabledCrossSessionMemoryDiagnostics(reason);
        this.memoryManager.setCrossSessionDiagnostics(this.lastCrossSessionMemory);
        this.lastMemory = this.memoryManager.diagnostics();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.memoryManager = undefined;
      this.projectMemorySynchronizer = undefined;
      this.lastCrossSessionMemory = {
        ...disabledCrossSessionMemoryDiagnostics(message),
        enabled: this.config.memory.crossSession,
        status: "failed",
      };
      this.lastMemory = {
        ...disabledMemoryDiagnostics(message),
        status: "failed",
      };
      this.logger.warn("memory_manager.failed", { error: message });
    }
  }

  private reconcileMemory(ctx: ExtensionContext, force = false): void {
    if (!this.memoryManager || !this.session?.sessionFile || !existsSync(this.session.sessionFile)) return;
    const projection = projectSessionFileMutations(this.session.sessionFile, this.session.sessionId);
    const signature = [
      ...projection.memoryMutations.map((mutation) => `m:${mutation.mutationKey}:${mutation.mutationId}`),
      ...projection.pinMutations.map((mutation) => `p:${mutation.mutationKey}:${mutation.mutationId}`),
      ...projection.warnings.map((warning) => `w:${warning}`),
    ].join("\0");
    if (!force && signature === this.lastMemoryMutationSignature) return;
    const sourceEntryIds = [
      ...projection.memoryMutations.map((mutation) => mutation.mutationKey.slice(this.session!.sessionId.length + 1)),
      ...projection.pinMutations.map((mutation) => mutation.mutationKey.slice(this.session!.sessionId.length + 1)),
    ];
    if (sourceEntryIds.some((entryId) => !this.database?.sessionIndex.hasEntry(this.session!.sessionId, entryId))) {
      if (!this.indexer) throw new Error("Session index is unavailable for memory mutation replay");
      this.session = this.snapshotCanonicalSession(ctx);
      const rebuilt = this.indexer.sync(this.session, true);
      this.lastIndexResult = rebuilt;
      this.lastIndexError = undefined;
    }
    const missing = sourceEntryIds.filter((entryId) => !this.database?.sessionIndex.hasEntry(this.session!.sessionId, entryId));
    if (missing.length > 0) {
      throw new Error(`Canonical memory mutation entries missing from session index: ${missing.join(", ")}`);
    }
    const result = this.memoryManager.reconcile(projection);
    this.lastMemoryMutationSignature = signature;
    this.lastMemory = this.memoryManager.diagnostics();
    this.logger.debug("memory.materialized", {
      memories: result.memories,
      pins: result.pins,
      memoryMutations: result.memoryMutations,
      pinMutations: result.pinMutations,
      ignoredMutations: result.ignoredMutations,
      warnings: result.warnings.length,
    });
  }

  private refreshProjectMemorySources(): void {
    if (!this.projectMemorySynchronizer || !this.memoryManager) return;
    try {
      this.lastCrossSessionMemory = this.projectMemorySynchronizer.sync();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastCrossSessionMemory = {
        ...this.lastCrossSessionMemory,
        enabled: true,
        status: "failed",
        warnings: [...new Set([...this.lastCrossSessionMemory.warnings, message])],
      };
      this.logger.warn("project_memory.failed", { error: message });
    }
    this.memoryManager.setCrossSessionDiagnostics(this.lastCrossSessionMemory);
    this.lastMemory = this.memoryManager.diagnostics();
  }

  private requireMemoryManager(): MemoryManager {
    if (!this.memoryManager) throw new Error("DS4 memory and pins are unavailable for this session");
    return this.memoryManager;
  }

  private initializeArtifacts(ctx: ExtensionContext): void {
    if (this.config.context.mode !== "managed"
      || !this.config.artifacts.enabled
      || !this.config.artifacts.storeLargeOutputs) {
      this.lastArtifacts = disabledArtifactDiagnostics();
      return;
    }
    if (!this.database || !this.session?.sessionFile) {
      this.lastArtifacts = {
        ...disabledArtifactDiagnostics(),
        warnings: ["Artifact offload requires a persisted Pi session"],
      };
      return;
    }
    try {
      const store = new FileArtifactStore(
        join(this.dependencies.agentDir, "ds4-context", "artifacts"),
        this.now,
      );
      this.artifactManager = new ArtifactManager(
        store,
        this.database.artifacts,
        this.config.artifacts,
        this.session.sessionId,
        this.now,
      );
      this.lastArtifacts = this.artifactManager.diagnostics(
        new Set(ctx.sessionManager.getBranch().map((entry) => entry.id)),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.artifactManager = undefined;
      this.lastArtifacts = {
        ...disabledArtifactDiagnostics(),
        warnings: [`Artifact Store initialization failed: ${message}`],
      };
      this.logger.warn("artifact_store.failed", { error: message });
    }
  }

  private rebuildArtifacts(ctx: ExtensionContext): void {
    if (!this.artifactManager) return;
    const messages: ContextEvent["messages"] = [];
    const sourceEntryIds: string[] = [];
    for (const entry of ctx.sessionManager.getEntries()) {
      for (const message of sessionEntryToContextMessages(entry)) {
        messages.push(message);
        sourceEntryIds.push(entry.id);
      }
    }
    const classifications = this.config.privacy.enabled && this.privacyEngine
      ? messages.map((message) => this.privacyEngine!.sanitizeMessage(
          message,
          ctx.model?.provider ?? "unknown",
        ).classification)
      : [];
    const result = this.artifactManager.reconcile(messages, sourceEntryIds, classifications);
    this.lastArtifacts = this.artifactManager.diagnostics(
      new Set(ctx.sessionManager.getBranch().map((entry) => entry.id)),
    );
    this.logger.info("artifact_store.rebuilt", {
      references: result.artifactIds.length,
      offloadedBytes: result.offloadedBytes,
      failed: result.failedCount,
    });
  }

  private rememberPriorRankingSelection(candidateId: string, selected: number): void {
    this.priorRankingSelection.delete(candidateId);
    this.priorRankingSelection.set(candidateId, selected);
    while (this.priorRankingSelection.size > MAX_PRIOR_RANKING_OUTCOMES) {
      const oldest = this.priorRankingSelection.keys().next().value as string | undefined;
      if (!oldest) break;
      this.priorRankingSelection.delete(oldest);
    }
  }

  private initializeRanking(): void {
    this.rankingModel = undefined;
    this.rankingWarnings = [];
    this.rankingModelPath = resolveRankingModelPath(
      this.config.ranking.modelPath,
      this.dependencies.agentDir,
      this.dependencies.homeDir,
    );
    this.lastRanking = disabledRankingDiagnostics(this.config.ranking.mode);
    if (this.config.ranking.mode === "off") return;
    const loaded = loadLearnedRankingModel(this.rankingModelPath);
    if (loaded.model) {
      this.rankingModel = loaded.model;
      this.lastRanking = rankCandidates([], {
        mode: this.config.ranking.mode,
        model: loaded.model,
        now: this.now,
        maxLatencyMs: this.config.ranking.maxLatencyMs,
      }).diagnostics;
      if (this.config.ranking.mode === "active" && !loaded.model.promotion?.eligible) {
        this.rankingWarnings.push("Configured active model has not passed the promotion gate; static ranking remains active");
      }
      return;
    }
    this.rankingWarnings.push(`Learned ranking unavailable: ${loaded.error ?? "model load failed"}`);
  }

  private initializeSemanticRetrieval(): void {
    this.semanticIndex = undefined;
    this.semanticFallbackReason = undefined;
    if (!this.config.retrieval.semantic || !this.database) return;

    const configured = this.config.retrieval.embedding;
    const expectedDestination = configured.mode;
    const matchesConfiguration = (port: EmbeddingPort): boolean =>
      port.identity.provider === configured.provider
      && port.identity.model === configured.model
      && port.identity.dimensions === configured.dimensions
      && port.identity.destination === expectedDestination;

    let port = this.dependencies.embeddingPort;
    if (port && !matchesConfiguration(port)) port = undefined;
    if (!port && configured.mode === "local"
      && configured.provider === "ds4-local"
      && configured.model === "feature-hash-v1") {
      port = new LocalFeatureHashEmbedding(configured.dimensions);
    }
    if (configured.mode === "remote") {
      const profile = `${configured.provider}/${configured.model}`;
      if (!configured.remoteProfiles.includes(profile)) {
        this.semanticFallbackReason = "remote embedding profile lacks explicit consent";
        return;
      }
      if (!this.config.privacy.enabled || !this.privacyEngine) {
        this.semanticFallbackReason = "remote embedding requires privacy filtering";
        return;
      }
    }
    if (!port) {
      this.semanticFallbackReason = `embedding model unavailable: ${configured.provider}/${configured.model}`;
      return;
    }

    this.semanticIndex = new SemanticEmbeddingIndex(
      this.database.embeddings,
      port,
      {
        maxSources: configured.maxSources,
        candidatePool: configured.candidatePool,
        batchSize: configured.batchSize,
        queryCacheSize: configured.queryCacheSize,
        timeoutMs: configured.timeoutMs,
      },
      (text) => {
        if (port!.identity.destination === "local") return text;
        const sanitized = this.privacyEngine?.sanitizeText(text, port!.identity.provider);
        if (!sanitized || sanitized.classification === "local-only" || sanitized.blockedBlocks > 0) {
          return undefined;
        }
        return sanitized.value;
      },
      this.now,
      this.now,
    );
  }

  private initializeProjectKnowledge(ctx: ExtensionContext): void {
    if (!this.config.project.enabled) {
      this.lastProject = emptyProjectDiagnostics(
        "disabled",
        ctx.isProjectTrusted(),
        this.config.context.maxProjectTokens,
        this.config.project.maxResults,
      );
      return;
    }
    if (!ctx.isProjectTrusted()) {
      this.lastProject = emptyProjectDiagnostics(
        "untrusted",
        false,
        this.config.context.maxProjectTokens,
        this.config.project.maxResults,
      );
      return;
    }
    if (isBroadProjectRoot(ctx.cwd, this.dependencies.homeDir ?? homedir())) {
      this.lastProject = {
        ...emptyProjectDiagnostics(
          "disabled",
          true,
          this.config.context.maxProjectTokens,
          this.config.project.maxResults,
        ),
        projectPath: resolve(ctx.cwd),
        fallbackReason: "Project indexing is skipped for filesystem roots and the user home directory",
      };
      this.logger.warn("project_index.skipped", {
        reason: "broad-root",
        projectPath: resolve(ctx.cwd),
      });
      return;
    }
    if (!this.database) return;

    try {
      this.projectKnowledge = new ProjectKnowledgeManager(
        ctx.cwd,
        this.database.projectKnowledge,
        this.config.project,
        this.config.context.maxProjectTokens,
        this.now,
        {
          enabled: this.config.retrieval.semantic,
          ...(this.semanticIndex ? { index: this.semanticIndex } : {}),
          ...(this.semanticFallbackReason ? { fallbackReason: this.semanticFallbackReason } : {}),
        },
      );
      const sync = this.syncProjectKnowledge();
      if (!sync) {
        this.projectRefreshPending = true;
        this.lastProject = this.projectKnowledge.diagnostics(
          "ready",
          "Project indexing deferred while another Pi session indexes this project",
        );
        this.logger.debug("project_index.deferred", { projectPath: this.projectKnowledge.projectPath });
        return;
      }
      this.lastProject = this.projectKnowledge.diagnostics();
      this.logger.info("project_index.opened", {
        files: sync.discoveredFiles,
        indexedFiles: sync.indexedFiles,
        currentSnippets: sync.currentSnippets,
        staleSnippets: sync.staleSnippets,
        gitAvailable: sync.git.available,
        dirty: sync.git.dirty,
        durationMs: sync.durationMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.projectKnowledge = undefined;
      this.lastProject = {
        ...emptyProjectDiagnostics(
          "failed",
          true,
          this.config.context.maxProjectTokens,
          this.config.project.maxResults,
        ),
        projectPath: ctx.cwd,
        fallbackReason: message,
      };
      this.logger.warn("project_index.failed", { error: message });
    }
  }

  private withProjectIndexLease<T>(
    operation: (checkpoint: () => void) => T,
  ): { acquired: true; value: T } | { acquired: false } {
    const database = this.database;
    const project = this.projectKnowledge;
    if (!project || !database) return { acquired: false };
    const durationMs = this.config.storage.projectIndexLeaseMs;
    const lease = database.leases.acquire(
      "project-index",
      project.projectPath,
      this.projectLeaseOwnerId,
      this.now(),
      durationMs,
    );
    if (!lease) return { acquired: false };
    let activeLease = lease;

    let renewAt = this.now() + Math.max(1_000, Math.floor(durationMs / 3));
    const checkpoint = (): void => {
      const current = this.now();
      if (current < renewAt) {
        if (!database.leases.isHeld(activeLease, current)) {
          throw new Error("Project indexing lease expired or was superseded");
        }
        return;
      }
      const renewed = database.leases.renew(activeLease, current, durationMs);
      if (!renewed) throw new Error("Project indexing lease expired or was superseded");
      activeLease = renewed;
      renewAt = current + Math.max(1_000, Math.floor(durationMs / 3));
    };

    try {
      return { acquired: true, value: operation(checkpoint) };
    } finally {
      try {
        database.leases.release(activeLease);
      } catch (error) {
        this.logger.warn("project_index.lease_release_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private syncProjectKnowledge(
    force = false,
  ): ReturnType<ProjectKnowledgeManager["sync"]> | undefined {
    const project = this.projectKnowledge;
    if (!project) return undefined;
    const result = this.withProjectIndexLease((checkpoint) => project.sync(force, checkpoint));
    return result.acquired ? result.value : undefined;
  }

  private refreshProjectIndexIfPending(): void {
    if (this.projectRefreshPending) this.refreshProjectIndex();
  }

  private refreshProjectIndex(force = false): void {
    if (!this.projectKnowledge) return;
    try {
      const sync = this.syncProjectKnowledge(force);
      if (!sync) {
        this.projectRefreshPending = true;
        this.lastProject = this.projectKnowledge.diagnostics(
          "ready",
          "Project indexing deferred while another Pi session indexes this project",
        );
        this.logger.debug("project_index.deferred", { projectPath: this.projectKnowledge.projectPath });
        return;
      }
      this.projectRefreshPending = false;
      this.lastProject = this.projectKnowledge.diagnostics();
      this.logger.debug("project_index.synced", {
        mode: sync.mode,
        discoveredFiles: sync.discoveredFiles,
        indexedFiles: sync.indexedFiles,
        unchangedFiles: sync.unchangedFiles,
        deletedFiles: sync.deletedFiles,
        staleSnippets: sync.staleSnippets,
        durationMs: sync.durationMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastProject = this.projectKnowledge.diagnostics("failed", message);
      this.logger.warn("project_index.sync_failed", { error: message });
    }
  }

  private retrieveProjectKnowledge(
    requestText: string,
    maxTokens = this.config.context.maxProjectTokens,
  ): ProjectKnowledgeDiagnostics {
    if (!this.projectKnowledge) return this.lastProject;
    if (!requestText) return this.projectKnowledge.diagnostics();
    try {
      const project = this.projectKnowledge;
      const timestamp = this.now();
      const guarded = this.withProjectIndexLease((checkpoint) =>
        project.retrieve(requestText, timestamp, maxTokens, checkpoint));
      const diagnostics = guarded.acquired
        ? guarded.value
        : project.retrieve(requestText, timestamp, maxTokens, false);
      if (!guarded.acquired) {
        this.logger.debug("project_retrieval.validation_deferred", { projectPath: project.projectPath });
      }
      this.logger.debug("project_retrieval.completed", {
        candidates: diagnostics.candidateCount,
        selected: diagnostics.selected.length,
        invalidatedSnippets: diagnostics.invalidatedSnippets,
        reindexedFiles: diagnostics.reindexedFiles,
        selectedTokens: diagnostics.selectedTokens,
        durationMs: diagnostics.durationMs,
      });
      return diagnostics;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("project_retrieval.failed", { error: message });
      return this.projectKnowledge.diagnostics("failed", message);
    }
  }

  private retrieveHistory(
    event: ContextEvent,
    ctx: ExtensionContext,
    maxTokens = this.config.context.maxRetrievedHistoryTokens,
  ): RetrievalDiagnostics {
    const requestText = currentRequestText(event.messages);
    if (!this.retrievalEngine || !this.session?.sessionFile || !requestText) {
      return emptyRetrievalDiagnostics(
        maxTokens,
        this.config.retrieval.maxResults,
      );
    }
    try {
      const diagnostics = this.retrievalEngine.retrieve({
        sessionId: this.session.sessionId,
        requestText,
        activeBranchEntryIds: new Set(ctx.sessionManager.getBranch().map((entry) => entry.id)),
        activeContextEntryIds: new Set(ctx.sessionManager.buildContextEntries().map((entry) => entry.id)),
        exact: this.config.retrieval.exact,
        fts: this.config.retrieval.fts,
        semantic: this.config.retrieval.semantic,
        maxResults: this.config.retrieval.maxResults,
        maxTokens,
        timestamp: this.now(),
      });
      this.logger.debug("retrieval.completed", {
        status: diagnostics.status,
        candidates: diagnostics.candidateCount,
        selected: diagnostics.selected.length,
        alternateBranchCandidates: diagnostics.alternateBranchCandidates,
        selectedTokens: diagnostics.selectedTokens,
        durationMs: diagnostics.durationMs,
      });
      return diagnostics;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("retrieval.failed", { error: message });
      return {
        ...emptyRetrievalDiagnostics(
          maxTokens,
          this.config.retrieval.maxResults,
        ),
        status: "failed",
        fallbackReason: message,
      };
    }
  }

  private snapshotCanonicalSession(ctx: ExtensionContext): PiSessionSnapshot {
    const snapshot = snapshotSession(ctx);
    return { ...snapshot, projectPath: canonicalProjectPath(snapshot.projectPath) };
  }

  syncSessionIndex(ctx: ExtensionContext): SessionIndexResult | undefined {
    if (!this.indexer || this.phase === "disabled" || this.phase === "degraded" || this.phase === "closed") {
      return undefined;
    }

    this.session = this.snapshotCanonicalSession(ctx);
    try {
      this.lastIndexResult = this.indexer.sync(this.session);
      this.retrievalEngine?.syncSemantic(this.session.sessionId);
      this.lastIndexError = undefined;
      return this.lastIndexResult;
    } catch (error) {
      this.lastIndexError = error instanceof Error ? error.message : String(error);
      this.logger.warn("session_index.failed", {
        sessionId: this.session.sessionId,
        error: this.lastIndexError,
      });
      return undefined;
    }
  }

  rebuildIndex(ctx: ExtensionContext): SessionIndexResult {
    if (!this.indexer || !this.database) throw new Error("Context database is unavailable");
    this.session = this.snapshotCanonicalSession(ctx);
    if (!this.session.sessionFile) throw new Error("Ephemeral Pi sessions do not have a JSONL index");

    const result = this.indexer.sync(this.session, true);
    this.lastIndexResult = result;
    this.lastIndexError = undefined;
    this.refreshProjectIndex(true);
    this.reconcileMemory(ctx, true);
    this.refreshProjectMemorySources();
    this.rebuildArtifacts(ctx);
    return result;
  }

  private flushContextQuality(): void {
    const pending = this.pendingQuality.splice(0);
    for (const item of pending) {
      this.recordContextQuality(item.manifest, item.contextConfig, item.recordedAt);
    }
  }

  private recordContextQuality(
    manifest: ContextManifest,
    contextConfig: Ds4ContextConfig["context"],
    recordedAt: number,
  ): void {
    if (!this.config.quality.enabled || !this.database) return;
    try {
      const sample = evaluateManifestQuality(manifest, {
        pin: contextConfig.maxPinnedTokens,
        memory: contextConfig.maxMemoryTokens,
        retrieval: contextConfig.maxRetrievedHistoryTokens,
        project: contextConfig.maxProjectTokens,
        summary: contextConfig.maxSummaryTokens,
        recent: manifest.planning?.recentTailTokenLimit ?? contextConfig.recentTailTokens,
      });
      this.database.quality.save(sample, recordedAt, this.config.quality.maxSamples);
      this.lastQualityError = undefined;
    } catch (error) {
      this.lastQualityError = error instanceof Error ? error.message : String(error);
      this.logger.warn("quality.sample_ignored", { error: this.lastQualityError });
    }
  }

  private contextQualityDiagnostics(): ContextQualityDiagnostics {
    const empty = disabledContextQualityDiagnostics();
    if (!this.config.quality.enabled) return empty;
    if (!this.database) {
      return {
        ...empty,
        enabled: true,
        ...(this.lastQualityError ? { lastError: this.lastQualityError } : {}),
      };
    }
    try {
      const stored = this.database.quality.aggregate(this.config.quality.maxSamples);
      return {
        enabled: true,
        metricsVersion: empty.metricsVersion,
        storedSamples: stored.samples.length,
        ignoredSamples: stored.ignoredSamples,
        aggregate: stored.aggregate,
        timing: stored.timing,
        ...(this.lastQualityError ? { lastError: this.lastQualityError } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...empty, enabled: true, lastError: message };
    }
  }

  private runtimeRankingDiagnostics(ctx: ExtensionContext): RuntimeRankingDiagnostics {
    try {
      const projection = projectRankingLabels(
        ctx.sessionManager.getBranch(),
        this.config.ranking.maxTrainingSamples,
      );
      return {
        ...this.lastRanking,
        ...(this.rankingModelPath ? { modelPath: this.rankingModelPath } : {}),
        modelLoaded: Boolean(this.rankingModel),
        promoted: Boolean(this.rankingModel?.promotion?.eligible),
        trainingSamples: projection.samples.length,
        malformedFeedback: projection.malformedEntries,
        duplicateFeedback: projection.duplicateEntries,
        warnings: [...new Set([...this.rankingWarnings, ...projection.warnings])],
      };
    } catch (error) {
      return {
        ...this.lastRanking,
        ...(this.rankingModelPath ? { modelPath: this.rankingModelPath } : {}),
        modelLoaded: Boolean(this.rankingModel),
        promoted: Boolean(this.rankingModel?.promotion?.eligible),
        trainingSamples: 0,
        malformedFeedback: 0,
        duplicateFeedback: 0,
        warnings: [...this.rankingWarnings, error instanceof Error ? error.message : String(error)],
      };
    }
  }

  diagnostics(ctx: ExtensionContext): RuntimeDiagnostics {
    const currentSession = this.session ?? this.snapshotCanonicalSession(ctx);
    if (this.artifactManager) {
      this.lastArtifacts = this.artifactManager.diagnostics(
        new Set(ctx.sessionManager.getBranch().map((entry) => entry.id)),
      );
    }
    let indexed: SessionIndexStats | undefined;
    if (this.database && currentSession.sessionFile) {
      try {
        indexed = this.database.getSessionStats(currentSession.sessionId);
      } catch (error) {
        this.logger.warn("diagnostics.index_stats_failed", { error });
      }
    }

    return {
      extensionVersion: EXTENSION_VERSION,
      supportedPiVersion: SUPPORTED_PI_VERSION,
      plannerVersion: this.config.context.mode === "managed" ? PLANNER_VERSION : OBSERVER_PLANNER_VERSION,
      phase: this.phase,
      enabled: this.config.enabled,
      contextMode: this.config.context.mode,
      adapter: negotiatePiRuntimeCapabilities(),
      session: currentSession,
      ...(ctx.model ? { model: { provider: ctx.model.provider, id: ctx.model.id } } : {}),
      ...(this.databasePath ? { databasePath: this.databasePath } : {}),
      ...(this.database ? { databaseSchemaVersion: this.database.schemaVersion } : {}),
      ...(indexed ? { indexed } : {}),
      ...(this.observation ? { observation: this.observation } : {}),
      ...(this.lastManifest ? { lastManifest: this.lastManifest } : {}),
      retrieval: this.lastRetrieval,
      project: this.lastProject,
      memory: this.lastMemory,
      privacy: this.lastPrivacy,
      ...(this.lastModelAwareness ? { modelAwareness: this.lastModelAwareness } : {}),
      nativeContinuation: this.nativeContinuation.diagnostics(),
      quality: this.contextQualityDiagnostics(),
      ranking: this.runtimeRankingDiagnostics(ctx),
      artifacts: this.lastArtifacts,
      compaction: this.getCompactionDiagnostics(ctx),
      ...(this.lastIndexResult ? { lastIndexResult: this.lastIndexResult } : {}),
      configFiles: [...(this.loadedConfig?.loadedFiles ?? [])],
      configWarnings: [...(this.loadedConfig?.warnings ?? [])],
      ...(this.lastIndexError ? { lastIndexError: this.lastIndexError } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  verifyArtifactHealth(ctx: ExtensionContext): void {
    if (!this.artifactManager) return;
    this.artifactManager.verifyIntegrity();
    this.lastArtifacts = this.artifactManager.diagnostics(
      new Set(ctx.sessionManager.getBranch().map((entry) => entry.id)),
    );
  }

  health(): DatabaseHealth | undefined {
    if (!this.database) return undefined;
    return this.database.health();
  }

  shutdown(ctx?: ExtensionContext): void {
    if (ctx) this.syncSessionIndex(ctx);
    this.flushContextQuality();
    this.nativeContinuation.invalidate("session-shutdown");
    this.closeDatabase();
    if (ctx) this.setStatus(ctx, undefined);
    this.phase = "closed";
    this.logger.info("runtime.closed", { sessionId: this.session?.sessionId });
  }

  private getCompactionDiagnostics(ctx: ExtensionContext): CompactionDiagnostics {
    return this.compaction?.diagnostics(ctx) ?? defaultCompactionDiagnostics(this.config);
  }

  private enterDegradedMode(ctx: ExtensionContext, error: unknown, stage: string): void {
    this.nativeContinuation.invalidate("runtime-degraded");
    this.closeDatabase();
    this.phase = "degraded";
    this.lastError = error instanceof Error ? error.message : String(error);
    this.logger.error("runtime.degraded", { stage, error: this.lastError });
    this.setStatus(ctx, "DS4 ctx: Pi fallback");
    if (ctx.hasUI) {
      ctx.ui.notify(`DS4 Context Engine unavailable; using Pi context. ${this.lastError}`, "warning");
    }
  }

  private closeDatabase(): void {
    try {
      this.database?.close();
    } finally {
      this.compaction = undefined;
      this.retrievalEngine = undefined;
      this.projectKnowledge = undefined;
      this.projectRefreshPending = false;
      this.memoryManager = undefined;
      this.projectMemorySynchronizer = undefined;
      this.lastCrossSessionMemory = disabledCrossSessionMemoryDiagnostics();
      this.lastMemoryMutationSignature = undefined;
      this.artifactManager = undefined;
      this.indexer = undefined;
      this.database = undefined;
    }
  }

  private setStatus(ctx: ExtensionContext, value: string | undefined): void {
    if (ctx.hasUI) ctx.ui.setStatus("ds4-context-engine", value);
  }
}
