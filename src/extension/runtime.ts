import { randomUUID } from "node:crypto";
import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  CompactionCoordinator,
  defaultCompactionDiagnostics,
  defaultSummaryGraphDiagnostics,
  type CompactionDiagnostics,
  type SessionCompactFailedLike,
  type SummaryGraphDiagnostics,
} from "../compaction/compaction-coordinator.ts";
export type {
  CompactionDiagnostics,
  CompactionPhase,
  SummaryGraphDiagnostics,
} from "../compaction/compaction-coordinator.ts";
import { loadConfig, resolveDatabasePath, type LoadedConfig } from "../config/config-loader.ts";
import { createDefaultConfig, type Ds4ContextConfig } from "../config/config.ts";
import { calculateContextBudget, type ContextBudget } from "../core/budget-manager.ts";
import { createModelProfile } from "../core/model-profile.ts";
import { estimateMessagesTokens } from "../core/token-estimator.ts";
import type { ContextManifest } from "../manifest/context-manifest.ts";
import { planManagedContext } from "../planner/context-planner.ts";
import {
  emptyProjectDiagnostics,
  ProjectKnowledgeManager,
  type ProjectKnowledgeDiagnostics,
} from "../project/project-knowledge.ts";
import {
  emptyRetrievalDiagnostics,
  HistoricalRetrievalEngine,
  type RetrievalDiagnostics,
} from "../retrieval/retrieval-engine.ts";
import { currentRequestText } from "../retrieval/task-descriptor.ts";
import { ContextDatabase, type DatabaseHealth, type SessionIndexStats } from "../persistence/sqlite.ts";
import {
  buildPiObserverManifest,
  findPiPinnedMessageIndices,
} from "../pi-adapter/context-observer.ts";
import { PiSessionIndexer, type SessionIndexResult } from "../pi-adapter/session-indexer.ts";
import { snapshotModel, snapshotSession, type PiSessionSnapshot } from "../pi-adapter/session-reader.ts";
import { silentLogger, StructuredLogger, type Logger } from "../shared/logging.ts";
import {
  EXTENSION_VERSION,
  OBSERVER_PLANNER_VERSION,
  PLANNER_VERSION,
  POLICY_VERSION,
  SUPPORTED_PI_VERSION,
} from "../shared/version.ts";

export type RuntimePhase = "idle" | "initializing" | "disabled" | "observer" | "managed" | "degraded" | "closed";

const READ_ONLY_PROJECT_TOOLS = new Set(["read", "grep", "find", "ls"]);

export interface RuntimeDependencies {
  agentDir: string;
  configDirName: string;
  homeDir?: string;
  now?: () => number;
  idGenerator?: () => string;
  logSink?: (line: string) => void;
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

function numericUsage(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export interface RuntimeDiagnostics {
  extensionVersion: string;
  supportedPiVersion: string;
  plannerVersion: string;
  phase: RuntimePhase;
  enabled: boolean;
  contextMode: "observer" | "managed";
  session?: PiSessionSnapshot;
  model?: { provider: string; id: string };
  databasePath?: string;
  databaseSchemaVersion?: number;
  indexed?: SessionIndexStats;
  observation?: ContextObservation;
  lastManifest?: ContextManifest;
  retrieval: RetrievalDiagnostics;
  project: ProjectKnowledgeDiagnostics;
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
  private projectKnowledge?: ProjectKnowledgeManager;
  private lastProject: ProjectKnowledgeDiagnostics = emptyProjectDiagnostics();
  private projectRefreshPending = false;
  private compaction?: CompactionCoordinator;
  private lastIndexResult?: SessionIndexResult;
  private lastIndexError?: string;
  private lastError?: string;
  private logger: Logger = silentLogger;
  private readonly now: () => number;
  private readonly idGenerator: () => string;

  constructor(private readonly dependencies: RuntimeDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.idGenerator = dependencies.idGenerator ?? randomUUID;
  }

  openSession(ctx: ExtensionContext): void {
    this.closeDatabase();
    this.phase = "initializing";
    this.lastError = undefined;
    this.lastIndexError = undefined;
    this.lastIndexResult = undefined;
    this.lastManifest = undefined;
    this.pendingManifestId = undefined;
    this.retrievalEngine = undefined;
    this.lastRetrieval = emptyRetrievalDiagnostics(
      this.config.context.maxRetrievedHistoryTokens,
      this.config.retrieval.maxResults,
    );
    this.projectKnowledge = undefined;
    this.lastProject = emptyProjectDiagnostics();
    this.projectRefreshPending = false;
    this.compaction = undefined;
    this.observation = undefined;
    this.session = snapshotSession(ctx);

    try {
      this.loadedConfig = loadConfig({
        agentDir: this.dependencies.agentDir,
        cwd: ctx.cwd,
        configDirName: this.dependencies.configDirName,
        projectTrusted: ctx.isProjectTrusted(),
        ...(this.dependencies.homeDir ? { homeDir: this.dependencies.homeDir } : {}),
      });
      this.config = this.loadedConfig.config;
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
      });

      this.indexer = new PiSessionIndexer(this.database.sessionIndex, {
        logger: this.logger,
        now: this.now,
      });
      this.retrievalEngine = new HistoricalRetrievalEngine(this.database.sessionIndex);
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
      }
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

  transformContext(
    event: ContextEvent,
    ctx: ExtensionContext,
    pi: ExtensionAPI,
  ): { messages?: ContextEvent["messages"] } | undefined {
    if ((this.phase !== "observer" && this.phase !== "managed") || !this.config.enabled) return undefined;

    try {
      this.syncSessionIndex(ctx);
      this.refreshProjectIndexIfPending();
      if (this.config.context.mode !== "managed") {
        this.lastRetrieval = emptyRetrievalDiagnostics(
          this.config.context.maxRetrievedHistoryTokens,
          this.config.retrieval.maxResults,
        );
      }
      const usage = ctx.getContextUsage();
      const model = snapshotModel(ctx);
      const budget = model
        ? calculateContextBudget(createModelProfile(model), this.config.context)
        : undefined;
      const observedAt = this.now();
      const manifestId = this.idGenerator();
      const baseline = buildPiObserverManifest({
        pi,
        event,
        ctx,
        contextConfig: this.config.context,
        manifestId,
        createdAt: observedAt,
        policyVersion: POLICY_VERSION,
        plannerVersion: OBSERVER_PLANNER_VERSION,
        ...(this.lastProject.revision ? { projectRevision: this.lastProject.revision } : {}),
      });

      let manifest = baseline;
      let result: { messages?: ContextEvent["messages"] } | undefined;
      if (this.config.context.mode === "managed" && budget) {
        const planningStartedAt = this.now();
        const requestText = currentRequestText(event.messages);
        const retrieval = this.retrieveHistory(event, ctx);
        const project = this.retrieveProjectKnowledge(requestText);
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
        const plan = planManagedContext({
          messages: event.messages,
          fixedTokens: baseline.composition.systemTokens + baseline.composition.toolTokens,
          budget,
          config: this.config.context,
          pinnedMessageIndices: findPiPinnedMessageIndices(event, ctx),
          supplementalMessages: [
            ...retrieval.selected.map((evidence) => ({
              id: `retrieval:${evidence.entryId}`,
              message: evidence.message,
              kind: "retrieval" as const,
              sourceIds: [evidence.entryId],
              score: 85 + Math.min(0.999999, Math.max(0, evidence.score) / 1_000),
              reason: `Historical evidence: ${evidence.reason}`,
            })),
            ...project.selected.map((evidence) => ({
              id: `project:${evidence.snippetId}`,
              message: evidence.message,
              kind: "project" as const,
              sourceIds: [evidence.sourceId],
              score: 80 + Math.min(0.999999, Math.max(0, evidence.score) / 1_000),
              reason: `Project source: ${evidence.reason}`,
              projectSnippet: evidence.manifestRef,
            })),
          ],
        });
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
        this.lastProject = {
          ...project,
          plannerExcludedCount: project.selected.length - plannerSelectedProject.length,
          selectedTokens: plannerSelectedProject.reduce((total, evidence) => total + evidence.estimatedTokens, 0),
          selected: plannerSelectedProject,
        };
        plan.planning.durationMs = Math.max(0, this.now() - planningStartedAt);
        const plannedEvent: ContextEvent = { type: "context", messages: plan.messages };
        manifest = buildPiObserverManifest({
          pi,
          event: plannedEvent,
          ctx,
          contextConfig: this.config.context,
          manifestId,
          createdAt: observedAt,
          policyVersion: POLICY_VERSION,
          plannerVersion: PLANNER_VERSION,
          plan,
          ...(this.lastProject.revision ? { projectRevision: this.lastProject.revision } : {}),
        });
        if (plan.mode === "managed") result = { messages: plan.messages };
      }

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
      this.logger.warn("context.planner_failed", { error: message });
      return undefined;
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
    const input = numericUsage(usageRecord.input);
    const cacheRead = numericUsage(usageRecord.cacheRead);
    const cacheWrite = numericUsage(usageRecord.cacheWrite);
    const actualInputTokens = input + cacheRead + cacheWrite;
    if (actualInputTokens <= 0) return;

    if (this.lastManifest?.id === manifestId) {
      this.lastManifest = { ...this.lastManifest, actualInputTokens };
    }
    if (this.config.diagnostics.storeContextManifest && this.session?.sessionFile) {
      this.lastManifest = this.database?.manifests.recordActualInput(
        manifestId,
        actualInputTokens,
        this.now(),
      ) ?? this.lastManifest;
    }
    this.logger.debug("context.actual_usage_recorded", { manifestId, actualInputTokens });
  }

  beforeCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): ReturnType<CompactionCoordinator["beforeCompact"]> {
    return this.compaction?.beforeCompact(event, ctx) ?? Promise.resolve(undefined);
  }

  afterCompaction(event: SessionCompactEvent, ctx: ExtensionContext): void {
    this.compaction?.afterCompaction(event, ctx);
  }

  compactionFailed(event: SessionCompactFailedLike): void {
    this.compaction?.compactionFailed(event);
  }

  afterAgentSettled(ctx: ExtensionContext): void {
    if (this.compaction) this.compaction.afterAgentSettled(ctx);
    else this.syncSessionIndex(ctx);
    this.refreshProjectIndex();
  }

  projectMayHaveChanged(toolName?: string): void {
    if (toolName && READ_ONLY_PROJECT_TOOLS.has(toolName.toLowerCase())) return;
    if (this.projectKnowledge) this.projectRefreshPending = true;
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

  modelChanged(provider: string, modelId: string): void {
    this.logger.info("model.changed", { provider, modelId });
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
    if (!this.database) return;

    try {
      this.projectKnowledge = new ProjectKnowledgeManager(
        ctx.cwd,
        this.database.projectKnowledge,
        this.config.project,
        this.config.context.maxProjectTokens,
        this.now,
      );
      const sync = this.projectKnowledge.sync();
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

  private refreshProjectIndexIfPending(): void {
    if (this.projectRefreshPending) this.refreshProjectIndex();
  }

  private refreshProjectIndex(force = false): void {
    if (!this.projectKnowledge) return;
    this.projectRefreshPending = false;
    try {
      const sync = this.projectKnowledge.sync(force);
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

  private retrieveProjectKnowledge(requestText: string): ProjectKnowledgeDiagnostics {
    if (!this.projectKnowledge) return this.lastProject;
    if (!requestText) return this.projectKnowledge.diagnostics();
    try {
      const diagnostics = this.projectKnowledge.retrieve(requestText, this.now());
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

  private retrieveHistory(event: ContextEvent, ctx: ExtensionContext): RetrievalDiagnostics {
    const requestText = currentRequestText(event.messages);
    if (!this.retrievalEngine || !this.session?.sessionFile || !requestText) {
      return emptyRetrievalDiagnostics(
        this.config.context.maxRetrievedHistoryTokens,
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
        maxTokens: this.config.context.maxRetrievedHistoryTokens,
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
          this.config.context.maxRetrievedHistoryTokens,
          this.config.retrieval.maxResults,
        ),
        status: "failed",
        fallbackReason: message,
      };
    }
  }

  syncSessionIndex(ctx: ExtensionContext): SessionIndexResult | undefined {
    if (!this.indexer || this.phase === "disabled" || this.phase === "degraded" || this.phase === "closed") {
      return undefined;
    }

    this.session = snapshotSession(ctx);
    try {
      this.lastIndexResult = this.indexer.sync(this.session);
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
    this.session = snapshotSession(ctx);
    if (!this.session.sessionFile) throw new Error("Ephemeral Pi sessions do not have a JSONL index");

    const result = this.indexer.sync(this.session, true);
    this.lastIndexResult = result;
    this.lastIndexError = undefined;
    this.refreshProjectIndex(true);
    return result;
  }

  diagnostics(ctx: ExtensionContext): RuntimeDiagnostics {
    const currentSession = this.session ?? snapshotSession(ctx);
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
      session: currentSession,
      ...(ctx.model ? { model: { provider: ctx.model.provider, id: ctx.model.id } } : {}),
      ...(this.databasePath ? { databasePath: this.databasePath } : {}),
      ...(this.database ? { databaseSchemaVersion: this.database.schemaVersion } : {}),
      ...(indexed ? { indexed } : {}),
      ...(this.observation ? { observation: this.observation } : {}),
      ...(this.lastManifest ? { lastManifest: this.lastManifest } : {}),
      retrieval: this.lastRetrieval,
      project: this.lastProject,
      compaction: this.getCompactionDiagnostics(ctx),
      ...(this.lastIndexResult ? { lastIndexResult: this.lastIndexResult } : {}),
      configFiles: [...(this.loadedConfig?.loadedFiles ?? [])],
      configWarnings: [...(this.loadedConfig?.warnings ?? [])],
      ...(this.lastIndexError ? { lastIndexError: this.lastIndexError } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  health(): DatabaseHealth | undefined {
    if (!this.database) return undefined;
    return this.database.health();
  }

  shutdown(ctx?: ExtensionContext): void {
    if (ctx) this.syncSessionIndex(ctx);
    this.closeDatabase();
    if (ctx) this.setStatus(ctx, undefined);
    this.phase = "closed";
    this.logger.info("runtime.closed", { sessionId: this.session?.sessionId });
  }

  private getCompactionDiagnostics(ctx: ExtensionContext): CompactionDiagnostics {
    return this.compaction?.diagnostics(ctx) ?? defaultCompactionDiagnostics(this.config);
  }

  private enterDegradedMode(ctx: ExtensionContext, error: unknown, stage: string): void {
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
      this.indexer = undefined;
      this.database = undefined;
    }
  }

  private setStatus(ctx: ExtensionContext, value: string | undefined): void {
    if (ctx.hasUI) ctx.ui.setStatus("ds4-context-engine", value);
  }
}
