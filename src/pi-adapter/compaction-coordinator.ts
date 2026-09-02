import type {
  CompactionResult,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Ds4ContextConfig } from "ds4-context-core/config/config";
import { calculateContextBudget, type ContextBudget } from "ds4-context-core/core/budget-manager";
import { createModelProfile, type ModelDescriptor } from "ds4-context-core/core/model-profile";
import type { ContextManifest } from "ds4-context-core/manifest/context-manifest";
import type { ContextDatabase } from "ds4-context-core/persistence/sqlite";
import {
  highestClassification,
  type PrivacyClassification,
} from "ds4-context-core/privacy/privacy-policy";
import {
  prepareCompactionSource,
  sliceCompactionSource,
  type PreparedCompactionSource,
  type PreparedCompactionSourceSlice,
} from "./compaction-adapter.ts";
import { buildCompactionAtomicGroups } from "ds4-context-core/compaction/segmentation";
import { estimateMessageTokens } from "ds4-context-core/core/token-estimator";
import { adaptiveRecentTailLimit } from "ds4-context-core/planner/context-planner";
import type { Logger } from "ds4-context-core/shared/logging";
import {
  type CompactionTrigger,
  type Ds4CompactionDetails,
  type EmbeddedSummaryNode,
  parseDs4CompactionDetails,
  type SummaryRecord,
} from "ds4-context-core/compaction/compaction-record";
import {
  generateValidatedSummary,
  sumUsage,
  type GeneratedSummary,
} from "./summary-generator.ts";
import {
  createSummaryRecord,
  importUntrackedPreviousSummary,
  recordsFromCompactionEntry,
  type SummaryBoundary,
} from "ds4-context-core/compaction/summary-graph";
import {
  buildAggregateSummaryPrompt,
  buildSummaryPrompt,
  computeAggregateSourceHash,
  type SummaryValidationStatus,
} from "ds4-context-core/compaction/summary-contract";

const MAX_SEGMENT_REQUESTS = 32;
const MAX_AGGREGATE_REQUESTS = 64;
const MAX_AGGREGATE_LEVELS = 16;

export type CompactionPhase =
  | "idle"
  | "requested"
  | "generating"
  | "prepared"
  | "committed"
  | "pi-default"
  | "failed";

export interface CompactionDiagnostics {
  enabled: boolean;
  validate: boolean;
  preserveRecentVerbatim: boolean;
  segmentTargetTokens: number;
  phase: CompactionPhase;
  trigger?: CompactionTrigger;
  summaryId?: string;
  sourceEntries?: number;
  validationStatus?: SummaryValidationStatus;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  requestedAt?: number;
  completedAt?: number;
  lastError?: string;
  inputBudgetTokens?: number;
  sourcePromptTokens?: number;
  segmentCount?: number;
  aggregateCalls?: number;
  contextTokens?: number;
  softLimitTokens?: number;
  proactiveThresholdTokens?: number;
  proactiveEligible: boolean;
}

export interface SummaryGraphNodeDiagnostic {
  id: string;
  kind: SummaryRecord["kind"];
  graphLevel: number;
  lifecycleStatus: SummaryRecord["lifecycleStatus"];
  validationStatus: SummaryValidationStatus;
  sourceEntries: number;
  children: string[];
  createdAt: number;
  activePath: boolean;
  piCompactionEntryId?: string;
}

export interface SummaryGraphDiagnostics {
  totalNodes: number;
  committedNodes: number;
  preparedNodes: number;
  failedNodes: number;
  segmentNodes: number;
  aggregateNodes: number;
  branchNodes: number;
  maxGraphLevel: number;
  rootSummaryIds: string[];
  activeSummaryId?: string;
  activePathIds: string[];
  nodes: SummaryGraphNodeDiagnostic[];
}

export interface SessionCompactFailedLike {
  reason: "manual" | "threshold" | "overflow";
  errorMessage?: string;
  aborted: boolean;
  willRetry: boolean;
  fromExtension: boolean;
}

interface SegmentGenerationPlan {
  source: PreparedCompactionSourceSlice;
  prompt: string;
  validationSource: string;
  readFiles: string[];
  modifiedFiles: string[];
  classification: PrivacyClassification;
  promptTokens: number;
}

interface AggregateGenerationPlan {
  children: EmbeddedSummaryNode[];
  prompt: string;
  validationSource: string;
  readFiles: string[];
  modifiedFiles: string[];
  classification: PrivacyClassification;
  promptTokens: number;
}

interface CompactionCoordinatorDependencies {
  config: Ds4ContextConfig;
  database?: ContextDatabase;
  sessionId: string;
  persisted: boolean;
  logger: Logger;
  now: () => number;
  idGenerator: () => string;
  syncSessionIndex: (ctx: ExtensionContext) => void;
  latestManifest: () => ContextManifest | undefined;
  resolveModelBudget?: (model: ModelDescriptor) => {
    budget: ContextBudget;
    recentTailTokens: number;
  };
  sanitizeContent?: (text: string, provider: string) => string;
  classifyContent?: (
    text: string,
    provider: string,
  ) => { value: string; classification: PrivacyClassification };
}

type MutableCompactionState = Omit<
  CompactionDiagnostics,
  "enabled" | "validate" | "preserveRecentVerbatim" | "segmentTargetTokens" | "proactiveEligible"
>;

function classifiedSummary(content: string, classification: PrivacyClassification): string {
  return classification === "normal"
    ? content
    : `[ds4:${classification}]${content}[/ds4:${classification}]`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function activeSummaryId(entries: readonly SessionEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "compaction") continue;
    return parseDs4CompactionDetails(entry.details)?.ds4ContextEngine.summaryId;
  }
  return undefined;
}

export class CompactionCoordinator {
  private state: MutableCompactionState = { phase: "idle" };
  private pendingSummaryIds: string[] = [];
  private proactiveRequested = false;
  private lastProactiveLeafId?: string;
  private readonly graphRecords = new Map<string, SummaryRecord>();

  constructor(private readonly dependencies: CompactionCoordinatorDependencies) {}

  initialize(entries: readonly SessionEntry[]): void {
    if (!this.dependencies.database || !this.dependencies.persisted) return;
    this.dependencies.database.summaries.failPreparedForSession(this.dependencies.sessionId);
    this.reconcile(entries);
    this.reloadGraphRecords();
    const latest = this.dependencies.database.summaries.getLatest(this.dependencies.sessionId);
    if (latest) this.restoreState(latest);
  }

  async beforeCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): Promise<{ compaction?: CompactionResult } | undefined> {
    const config = this.dependencies.config;
    const model = ctx.model;
    if (!config.compaction.enabled || !config.enabled || !model || config.context.maxSummaryTokens <= 0) {
      return undefined;
    }

    const requestedAt = this.dependencies.now();
    const trigger: CompactionTrigger = this.proactiveRequested ? "proactive" : event.reason;
    this.state = {
      phase: "generating",
      trigger,
      requestedAt,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    };

    try {
      this.dependencies.syncSessionIndex(ctx);
      const source = prepareCompactionSource(event);
      const inputBudgetTokens = this.inputBudgetTokens(model);
      if (inputBudgetTokens <= 0) throw new Error("Active model has no safe compaction input budget");
      const wholePlan = this.buildSegmentPlan(source, event, model.provider);
      this.state = {
        ...this.state,
        sourceEntries: source.sourceEntryIds.length,
        inputBudgetTokens,
        sourcePromptTokens: wholePlan.promptTokens,
      };
      const segmentPlans = this.partitionSegmentPlans(
        source,
        wholePlan,
        event,
        model.provider,
        inputBudgetTokens,
      );
      this.state.segmentCount = segmentPlans.length;

      const usedIds = new Set(this.graphRecords.keys());
      if (source.previousNode) usedIds.add(source.previousNode.id);
      const nextId = (): string => {
        const id = this.dependencies.idGenerator();
        if (!id || usedIds.has(id)) throw new Error(`Summary ID collision: ${id || "<empty>"}`);
        usedIds.add(id);
        return id;
      };
      const boundary: SummaryBoundary = {
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        reason: trigger,
        isSplitTurn: event.preparation.isSplitTurn,
        messageCount: source.messages.length,
        provider: model.provider,
        model: model.id,
      };

      const usages: GeneratedSummary["usage"][] = [];
      const segmentNodes: EmbeddedSummaryNode[] = [];
      for (const plan of segmentPlans) {
        const generated = await this.generateSummary({
          stage: "segment",
          prompt: plan.prompt,
          validationSource: plan.validationSource,
          readFiles: plan.readFiles,
          modifiedFiles: plan.modifiedFiles,
          event,
          ctx,
        });
        usages.push(generated.usage);
        segmentNodes.push({
          id: nextId(),
          kind: "segment",
          content: classifiedSummary(generated.content, plan.classification),
          sourceHash: plan.source.sourceHash,
          sourceEntryIds: [...plan.source.sourceEntryIds],
          childSummaryIds: [],
          graphLevel: 0,
          createdAt: this.dependencies.now(),
          validationStatus: generated.validation.status,
          validationIssueCodes: unique(generated.validation.issues.map((issue) => issue.code)),
          provider: model.provider,
          model: model.id,
        });
      }
      const segmentId = segmentNodes[0]?.id;
      if (!segmentId) throw new Error("Compaction fan-out produced no segment summary node");

      const createdNodes: EmbeddedSummaryNode[] = [];
      let previousNode = source.previousNode;
      if (!previousNode && source.previousSummary) {
        previousNode = importUntrackedPreviousSummary({
          id: nextId(),
          content: source.previousSummary,
          createdAt: this.dependencies.now(),
          provider: model.provider,
          model: model.id,
        });
        createdNodes.push(previousNode);
      }
      createdNodes.push(...segmentNodes);
      const roots = [...(previousNode ? [previousNode] : []), ...segmentNodes];
      const aggregated = await this.aggregateSummaryNodes({
        roots,
        event,
        ctx,
        provider: model.provider,
        model: model.id,
        readFiles: source.readFiles,
        modifiedFiles: source.modifiedFiles,
        inputBudgetTokens,
        nextId,
        createdNodes,
        usages,
      });
      const activeNode = aggregated.activeNode;
      const embeddedNodes = createdNodes.filter((node) => node.id !== activeNode.id);

      const records = embeddedNodes.map((node) => createSummaryRecord({
        sessionId: this.dependencies.sessionId,
        node,
        boundary,
        segmentSummaryId: node.kind === "segment" ? node.id : segmentId,
        lifecycleStatus: "prepared",
      }));
      records.push(createSummaryRecord({
        sessionId: this.dependencies.sessionId,
        node: activeNode,
        boundary,
        segmentSummaryId: segmentId,
        lifecycleStatus: "prepared",
        embeddedNodes,
      }));
      if (this.dependencies.persisted) this.dependencies.database?.summaries.saveGraph(records);
      for (const record of records) this.graphRecords.set(record.id, record);
      this.pendingSummaryIds = records.map((record) => record.id);
      this.state = {
        phase: "prepared",
        trigger,
        summaryId: activeNode.id,
        sourceEntries: activeNode.sourceEntryIds.length,
        validationStatus: activeNode.validationStatus,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        requestedAt,
        inputBudgetTokens,
        sourcePromptTokens: wholePlan.promptTokens,
        segmentCount: segmentPlans.length,
        aggregateCalls: aggregated.aggregateCalls,
      };
      this.dependencies.logger.debug("compaction.summary_graph_prepared", {
        activeSummaryId: activeNode.id,
        segmentSummaryId: segmentId,
        graphLevel: activeNode.graphLevel,
        createdNodes: records.length,
        sourceEntries: activeNode.sourceEntryIds.length,
        validationStatus: activeNode.validationStatus,
        inputBudgetTokens,
        sourcePromptTokens: wholePlan.promptTokens,
        segmentCount: segmentPlans.length,
        aggregateCalls: aggregated.aggregateCalls,
        trigger,
      });
      const activeRecord = records.at(-1);
      if (!activeRecord) throw new Error("Compaction graph produced no active summary node");
      const details: Ds4CompactionDetails = {
        readFiles: source.readFiles,
        modifiedFiles: source.modifiedFiles,
        ds4ContextEngine: activeRecord.metadata,
      };
      return {
        compaction: {
          summary: activeNode.content,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          usage: sumUsage(usages),
          details,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state = {
        ...this.state,
        phase: "failed",
        trigger,
        completedAt: this.dependencies.now(),
        lastError: message,
      };
      this.dependencies.logger.warn("compaction.custom_fallback", { trigger, error: message });
      if (!event.signal.aborted && ctx.hasUI) {
        ctx.ui.notify(`DS4 compaction unavailable; using Pi default. ${message}`, "warning");
      }
      return undefined;
    }
  }

  afterCompaction(event: SessionCompactEvent, ctx: ExtensionContext): void {
    this.proactiveRequested = false;
    this.dependencies.syncSessionIndex(ctx);
    const expectedSummaryId = this.state.phase === "prepared" ? this.state.summaryId : undefined;
    const eventSummaryId = parseDs4CompactionDetails(event.compactionEntry.details)?.ds4ContextEngine.summaryId;
    const effectiveEntry = expectedSummaryId && eventSummaryId === expectedSummaryId
      ? event.compactionEntry
      : expectedSummaryId
        ? [...ctx.sessionManager.getEntries()].reverse().find((entry): entry is Extract<SessionEntry, { type: "compaction" }> => {
            if (entry.type !== "compaction") return false;
            return parseDs4CompactionDetails(entry.details)?.ds4ContextEngine.summaryId === expectedSummaryId;
          })
        : undefined;
    const details = expectedSummaryId && effectiveEntry
      ? parseDs4CompactionDetails(effectiveEntry.details)
      : undefined;
    if (!details || !effectiveEntry) {
      this.failPendingNodes();
      const attempt = this.state;
      const customError = attempt.lastError;
      this.state = {
        phase: "pi-default",
        trigger: event.reason,
        firstKeptEntryId: event.compactionEntry.firstKeptEntryId,
        tokensBefore: event.compactionEntry.tokensBefore,
        completedAt: this.dependencies.now(),
        ...(attempt.sourceEntries !== undefined ? { sourceEntries: attempt.sourceEntries } : {}),
        ...(attempt.inputBudgetTokens !== undefined ? { inputBudgetTokens: attempt.inputBudgetTokens } : {}),
        ...(attempt.sourcePromptTokens !== undefined ? { sourcePromptTokens: attempt.sourcePromptTokens } : {}),
        ...(attempt.segmentCount !== undefined ? { segmentCount: attempt.segmentCount } : {}),
        ...(attempt.aggregateCalls !== undefined ? { aggregateCalls: attempt.aggregateCalls } : {}),
        ...(customError ? { lastError: `Custom fallback: ${customError}` } : {}),
      };
      return;
    }

    if (effectiveEntry.id !== event.compactionEntry.id) {
      this.dependencies.logger.debug("compaction.stale_event_entry_corrected", {
        eventEntryId: event.compactionEntry.id,
        committedEntryId: effectiveEntry.id,
        summaryId: expectedSummaryId,
      });
    }
    try {
      this.persistCommitted(effectiveEntry, details);
    } catch (error) {
      this.dependencies.logger.warn("compaction.summary_graph_commit_persist_failed", {
        summaryId: details.ds4ContextEngine.summaryId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.pendingSummaryIds = [];
    const metadata = details.ds4ContextEngine;
    this.state = {
      phase: "committed",
      trigger: metadata.reason,
      summaryId: metadata.summaryId,
      sourceEntries: metadata.sourceEntryIds.length,
      validationStatus: metadata.validationStatus,
      firstKeptEntryId: effectiveEntry.firstKeptEntryId,
      tokensBefore: effectiveEntry.tokensBefore,
      requestedAt: metadata.generatedAt,
      completedAt: this.dependencies.now(),
      ...(this.state.inputBudgetTokens !== undefined
        ? { inputBudgetTokens: this.state.inputBudgetTokens }
        : {}),
      ...(this.state.sourcePromptTokens !== undefined
        ? { sourcePromptTokens: this.state.sourcePromptTokens }
        : {}),
      ...(this.state.segmentCount !== undefined ? { segmentCount: this.state.segmentCount } : {}),
      ...(this.state.aggregateCalls !== undefined ? { aggregateCalls: this.state.aggregateCalls } : {}),
    };
    this.dependencies.logger.debug("compaction.summary_graph_committed", {
      activeSummaryId: metadata.summaryId,
      segmentSummaryId: metadata.segmentSummaryId,
      graphLevel: metadata.graphLevel,
      compactionEntryId: effectiveEntry.id,
      trigger: metadata.reason,
    });
  }

  compactionFailed(event: SessionCompactFailedLike): void {
    this.proactiveRequested = false;
    this.failPendingNodes();
    const message = event.errorMessage ?? (event.aborted ? "Compaction aborted" : "Compaction failed");
    this.state = {
      ...this.state,
      phase: "failed",
      trigger: this.state.trigger ?? event.reason,
      completedAt: this.dependencies.now(),
      lastError: message,
    };
    this.dependencies.logger.warn("compaction.failed", {
      reason: event.reason,
      fromExtension: event.fromExtension,
      aborted: event.aborted,
      error: message,
    });
  }

  afterAgentSettled(ctx: ExtensionContext): void {
    this.dependencies.syncSessionIndex(ctx);
    const config = this.dependencies.config;
    if (!config.compaction.enabled || !config.enabled || this.proactiveRequested) return;
    if (!ctx.model || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    if (ctx.sessionManager.getBranch().at(-1)?.type === "compaction") return;

    const usage = ctx.getContextUsage();
    if (usage?.tokens === null || usage?.tokens === undefined) return;
    const resolved = this.dependencies.resolveModelBudget?.(ctx.model)
      ?? {
        budget: calculateContextBudget(createModelProfile(ctx.model), config.context),
        recentTailTokens: adaptiveRecentTailLimit(
          ctx.model.contextWindow,
          config.context.recentTailTokens,
        ),
      };
    const budget = resolved.budget;
    const leafId = ctx.sessionManager.getLeafId() ?? "root";
    const threshold = this.proactiveThreshold(budget, resolved.recentTailTokens);
    if (usage.tokens < threshold || this.lastProactiveLeafId === leafId) return;

    this.proactiveRequested = true;
    this.lastProactiveLeafId = leafId;
    this.state = {
      phase: "requested",
      trigger: "proactive",
      requestedAt: this.dependencies.now(),
      contextTokens: usage.tokens,
      softLimitTokens: this.providerSoftLimit(budget),
      proactiveThresholdTokens: threshold,
    };
    if (ctx.hasUI) {
      ctx.ui.notify(
        `DS4 proactive compaction: ${usage.tokens.toLocaleString()} tokens reached the ${threshold.toLocaleString()} proactive threshold.`,
        "info",
      );
    }
    try {
      ctx.compact({
        onComplete: () => {
          this.proactiveRequested = false;
        },
        onError: (error) => {
          this.proactiveRequested = false;
          if (this.state.phase === "requested") {
            this.state = {
              ...this.state,
              phase: "failed",
              completedAt: this.dependencies.now(),
              lastError: error.message,
            };
          }
        },
      });
    } catch (error) {
      this.proactiveRequested = false;
      this.state = {
        ...this.state,
        phase: "failed",
        completedAt: this.dependencies.now(),
        lastError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  diagnostics(ctx: ExtensionContext): CompactionDiagnostics {
    const config = this.dependencies.config;
    const usage = ctx.getContextUsage();
    const resolved = ctx.model
      ? this.dependencies.resolveModelBudget?.(ctx.model)
        ?? {
          budget: calculateContextBudget(createModelProfile(ctx.model), config.context),
          recentTailTokens: adaptiveRecentTailLimit(
            ctx.model.contextWindow,
            config.context.recentTailTokens,
          ),
        }
      : undefined;
    const budget = resolved?.budget;
    const contextTokens = usage?.tokens ?? undefined;
    const threshold = resolved
      ? this.proactiveThreshold(resolved.budget, resolved.recentTailTokens)
      : undefined;
    const leafId = ctx.sessionManager.getLeafId() ?? "root";
    const lastEntryIsCompaction = ctx.sessionManager.getBranch().at(-1)?.type === "compaction";
    const proactiveEligible = Boolean(
      config.enabled
      && config.compaction.enabled
      && contextTokens !== undefined
      && threshold !== undefined
      && contextTokens >= threshold
      && !lastEntryIsCompaction
      && this.lastProactiveLeafId !== leafId,
    );

    return {
      enabled: config.compaction.enabled,
      validate: config.compaction.validate,
      preserveRecentVerbatim: config.compaction.preserveRecentVerbatim,
      segmentTargetTokens: config.compaction.segmentTargetTokens,
      ...this.state,
      ...(contextTokens !== undefined ? { contextTokens } : {}),
      ...(budget ? { softLimitTokens: this.providerSoftLimit(budget) } : {}),
      ...(threshold !== undefined ? { proactiveThresholdTokens: threshold } : {}),
      proactiveEligible,
    };
  }

  summaryGraph(ctx: ExtensionContext): SummaryGraphDiagnostics {
    const records = [...this.graphRecords.values()];
    const activeId = activeSummaryId(ctx.sessionManager.getBranch());
    const activePath = new Set<string>();
    const visit = (id: string): void => {
      if (activePath.has(id)) return;
      activePath.add(id);
      for (const child of this.graphRecords.get(id)?.childSummaryIds ?? []) visit(child);
    };
    if (activeId) visit(activeId);
    const committed = records.filter((record) => record.lifecycleStatus === "committed");
    const childIds = new Set(committed.flatMap((record) => record.childSummaryIds));
    const roots = committed.filter((record) => !childIds.has(record.id)).map((record) => record.id);
    const nodes = records
      .sort((left, right) => right.createdAt - left.createdAt || right.graphLevel - left.graphLevel || left.id.localeCompare(right.id))
      .map((record) => ({
        id: record.id,
        kind: record.kind,
        graphLevel: record.graphLevel,
        lifecycleStatus: record.lifecycleStatus,
        validationStatus: record.validationStatus,
        sourceEntries: record.sourceEntryIds.length,
        children: [...record.childSummaryIds],
        createdAt: record.createdAt,
        activePath: activePath.has(record.id),
        ...(record.piCompactionEntryId ? { piCompactionEntryId: record.piCompactionEntryId } : {}),
      }));
    return {
      totalNodes: records.length,
      committedNodes: committed.length,
      preparedNodes: records.filter((record) => record.lifecycleStatus === "prepared").length,
      failedNodes: records.filter((record) => record.lifecycleStatus === "failed").length,
      segmentNodes: records.filter((record) => record.kind === "segment").length,
      aggregateNodes: records.filter((record) => record.kind === "aggregate").length,
      branchNodes: records.filter((record) => record.kind === "branch").length,
      maxGraphLevel: records.reduce((maximum, record) => Math.max(maximum, record.graphLevel), 0),
      rootSummaryIds: roots,
      ...(activeId ? { activeSummaryId: activeId } : {}),
      activePathIds: [...activePath],
      nodes,
    };
  }

  private inputBudgetTokens(model: ModelDescriptor): number {
    const config = this.dependencies.config;
    const resolved = this.dependencies.resolveModelBudget?.(model)
      ?? {
        budget: calculateContextBudget(createModelProfile(model), config.context),
        recentTailTokens: adaptiveRecentTailLimit(
          model.contextWindow,
          config.context.recentTailTokens,
        ),
      };
    return Math.floor(resolved.budget.activeInputBudget);
  }

  private classify(text: string, provider: string): {
    value: string;
    classification: PrivacyClassification;
  } {
    const classified = this.dependencies.classifyContent?.(text, provider);
    if (classified) return classified;
    return {
      value: this.dependencies.sanitizeContent?.(text, provider) ?? text,
      classification: "normal",
    };
  }

  private promptTokens(prompt: string): number {
    return estimateMessageTokens({
      role: "user",
      content: [{ type: "text", text: prompt }],
    });
  }

  private buildSegmentPlan(
    source: PreparedCompactionSourceSlice,
    event: SessionBeforeCompactEvent,
    provider: string,
  ): SegmentGenerationPlan {
    const sourcePrivacy = this.classify(source.conversationText, provider);
    const validationPrivacy = this.classify(source.sourceText, provider);
    const instructionPrivacy = event.customInstructions
      ? this.classify(event.customInstructions, provider)
      : undefined;
    const readFilePrivacy = source.segmentReadFiles.map((file) => this.classify(file, provider));
    const modifiedFilePrivacy = source.segmentModifiedFiles.map((file) => this.classify(file, provider));
    const classification = [
      sourcePrivacy.classification,
      validationPrivacy.classification,
      ...(instructionPrivacy ? [instructionPrivacy.classification] : []),
      ...readFilePrivacy.map((item) => item.classification),
      ...modifiedFilePrivacy.map((item) => item.classification),
    ].reduce(highestClassification, "normal" as PrivacyClassification);
    const readFiles = readFilePrivacy.map((item) => item.value);
    const modifiedFiles = modifiedFilePrivacy.map((item) => item.value);
    const prompt = buildSummaryPrompt({
      conversationText: sourcePrivacy.value,
      ...(instructionPrivacy ? { customInstructions: instructionPrivacy.value } : {}),
      readFiles,
      modifiedFiles,
      isSplitTurn: source.isSplitTurn,
    });
    return {
      source,
      prompt,
      validationSource: validationPrivacy.value,
      readFiles,
      modifiedFiles,
      classification,
      promptTokens: this.promptTokens(prompt),
    };
  }

  private partitionSegmentPlans(
    source: PreparedCompactionSource,
    wholePlan: SegmentGenerationPlan,
    event: SessionBeforeCompactEvent,
    provider: string,
    inputBudgetTokens: number,
  ): SegmentGenerationPlan[] {
    if (wholePlan.promptTokens <= inputBudgetTokens) return [wholePlan];

    const groups = buildCompactionAtomicGroups(source.messages);
    const plans: SegmentGenerationPlan[] = [];
    let currentIndices: number[] = [];
    let currentPlan: SegmentGenerationPlan | undefined;

    for (const group of groups) {
      const candidateIndices = [...currentIndices, ...group.messageIndices];
      const candidatePlan = this.buildSegmentPlan(
        sliceCompactionSource(source, candidateIndices),
        event,
        provider,
      );
      if (candidatePlan.promptTokens <= inputBudgetTokens) {
        currentIndices = candidateIndices;
        currentPlan = candidatePlan;
        continue;
      }

      if (currentPlan) {
        plans.push(currentPlan);
        if (plans.length >= MAX_SEGMENT_REQUESTS) {
          throw new Error(`Compaction fan-out exceeded the bounded segment request limit (${MAX_SEGMENT_REQUESTS})`);
        }
      }
      const atomicPlan = this.buildSegmentPlan(
        sliceCompactionSource(source, group.messageIndices),
        event,
        provider,
      );
      if (atomicPlan.promptTokens > inputBudgetTokens) {
        throw new Error(
          `Compaction source contains an indivisible atomic group above the model input budget (promptTokens=${atomicPlan.promptTokens}; inputBudgetTokens=${inputBudgetTokens})`,
        );
      }
      currentIndices = [...group.messageIndices];
      currentPlan = atomicPlan;
    }

    if (currentPlan) plans.push(currentPlan);
    if (plans.length === 0) throw new Error("Compaction fan-out produced no source segments");
    if (plans.length > MAX_SEGMENT_REQUESTS) {
      throw new Error(`Compaction fan-out exceeded the bounded segment request limit (${MAX_SEGMENT_REQUESTS})`);
    }
    return plans;
  }

  private buildAggregatePlan(
    children: readonly EmbeddedSummaryNode[],
    event: SessionBeforeCompactEvent,
    provider: string,
    readFiles: readonly string[],
    modifiedFiles: readonly string[],
  ): AggregateGenerationPlan {
    const classifiedChildren = children.map((child) => ({
      child,
      privacy: this.classify(child.content, provider),
    }));
    const promptChildren = classifiedChildren.map(({ child, privacy }) => ({
      ...child,
      content: privacy.value,
    }));
    const aggregateReadFiles = readFiles.map((file) => this.classify(file, provider));
    const aggregateModifiedFiles = modifiedFiles.map((file) => this.classify(file, provider));
    const aggregateInstruction = event.customInstructions
      ? this.classify(event.customInstructions, provider)
      : undefined;
    const classification = [
      ...classifiedChildren.map((item) => item.privacy.classification),
      ...(aggregateInstruction ? [aggregateInstruction.classification] : []),
      ...aggregateReadFiles.map((item) => item.classification),
      ...aggregateModifiedFiles.map((item) => item.classification),
    ].reduce(highestClassification, "normal" as PrivacyClassification);
    const sanitizedReadFiles = aggregateReadFiles.map((item) => item.value);
    const sanitizedModifiedFiles = aggregateModifiedFiles.map((item) => item.value);
    const prompt = buildAggregateSummaryPrompt({
      children: promptChildren,
      ...(aggregateInstruction ? { customInstructions: aggregateInstruction.value } : {}),
      readFiles: sanitizedReadFiles,
      modifiedFiles: sanitizedModifiedFiles,
    });
    return {
      children: [...children],
      prompt,
      validationSource: promptChildren.map((child) => child.content).join("\n\n"),
      readFiles: sanitizedReadFiles,
      modifiedFiles: sanitizedModifiedFiles,
      classification,
      promptTokens: this.promptTokens(prompt),
    };
  }

  private async aggregateSummaryNodes(input: {
    roots: EmbeddedSummaryNode[];
    event: SessionBeforeCompactEvent;
    ctx: ExtensionContext;
    provider: string;
    model: string;
    readFiles: readonly string[];
    modifiedFiles: readonly string[];
    inputBudgetTokens: number;
    nextId: () => string;
    createdNodes: EmbeddedSummaryNode[];
    usages: GeneratedSummary["usage"][];
  }): Promise<{ activeNode: EmbeddedSummaryNode; aggregateCalls: number }> {
    let layer = [...input.roots];
    let aggregateCalls = 0;
    let graphPasses = 0;

    while (layer.length > 1) {
      graphPasses++;
      if (graphPasses > MAX_AGGREGATE_LEVELS) {
        throw new Error(`Compaction aggregation exceeded the bounded graph depth (${MAX_AGGREGATE_LEVELS})`);
      }
      const batches: EmbeddedSummaryNode[][] = [];
      let current: EmbeddedSummaryNode[] = [];
      for (const node of layer) {
        if (current.length === 0) {
          current = [node];
          continue;
        }
        const candidate = [...current, node];
        const candidatePlan = this.buildAggregatePlan(
          candidate,
          input.event,
          input.provider,
          input.readFiles,
          input.modifiedFiles,
        );
        if (candidatePlan.promptTokens <= input.inputBudgetTokens) {
          current = candidate;
          continue;
        }
        if (current.length === 1) {
          throw new Error(
            `Compaction child summaries cannot be aggregated within the model input budget (inputBudgetTokens=${input.inputBudgetTokens})`,
          );
        }
        batches.push(current);
        current = [node];
      }
      if (current.length > 0) batches.push(current);

      const nextLayer: EmbeddedSummaryNode[] = [];
      for (const batch of batches) {
        if (batch.length === 1) {
          nextLayer.push(batch[0] as EmbeddedSummaryNode);
          continue;
        }
        aggregateCalls++;
        if (aggregateCalls > MAX_AGGREGATE_REQUESTS) {
          throw new Error(`Compaction fan-in exceeded the bounded aggregate request limit (${MAX_AGGREGATE_REQUESTS})`);
        }
        const plan = this.buildAggregatePlan(
          batch,
          input.event,
          input.provider,
          input.readFiles,
          input.modifiedFiles,
        );
        if (plan.promptTokens > input.inputBudgetTokens) {
          throw new Error("Compaction aggregate prompt exceeded its preflight input budget");
        }
        const generated = await this.generateSummary({
          stage: "aggregate",
          prompt: plan.prompt,
          validationSource: plan.validationSource,
          readFiles: plan.readFiles,
          modifiedFiles: plan.modifiedFiles,
          event: input.event,
          ctx: input.ctx,
        });
        input.usages.push(generated.usage);
        const aggregateNode: EmbeddedSummaryNode = {
          id: input.nextId(),
          kind: "aggregate",
          content: classifiedSummary(generated.content, plan.classification),
          sourceHash: computeAggregateSourceHash(batch),
          sourceEntryIds: unique(batch.flatMap((child) => child.sourceEntryIds)),
          childSummaryIds: batch.map((child) => child.id),
          graphLevel: Math.max(...batch.map((child) => child.graphLevel)) + 1,
          createdAt: this.dependencies.now(),
          validationStatus: generated.validation.status,
          validationIssueCodes: unique(generated.validation.issues.map((issue) => issue.code)),
          provider: input.provider,
          model: input.model,
        };
        input.createdNodes.push(aggregateNode);
        nextLayer.push(aggregateNode);
      }
      if (nextLayer.length >= layer.length) {
        throw new Error("Compaction aggregation could not reduce the summary graph within the input budget");
      }
      layer = nextLayer;
    }

    const activeNode = layer[0];
    if (!activeNode) throw new Error("Compaction aggregation produced no active summary node");
    return { activeNode, aggregateCalls };
  }

  private generateSummary(input: {
    stage: "segment" | "aggregate";
    prompt: string;
    validationSource: string;
    readFiles: readonly string[];
    modifiedFiles: readonly string[];
    event: SessionBeforeCompactEvent;
    ctx: ExtensionContext;
  }): Promise<GeneratedSummary> {
    return generateValidatedSummary({
      ...input,
      validate: this.dependencies.config.compaction.validate,
      maxSummaryTokens: this.dependencies.config.context.maxSummaryTokens,
      now: this.dependencies.now,
    });
  }

  private providerSoftLimit(budget: ContextBudget): number {
    return budget.nominalSoftInputLimit ?? budget.softInputLimit;
  }

  private proactiveThreshold(budget: ContextBudget, recentTailTokens?: number): number {
    const manifest = this.dependencies.latestManifest();
    const fixedTokens = (manifest?.composition.systemTokens ?? 0) + (manifest?.composition.toolTokens ?? 0);
    const recentTail = recentTailTokens ?? adaptiveRecentTailLimit(
      budget.contextWindow,
      this.dependencies.config.context.recentTailTokens,
    );
    const estimatorThreshold = fixedTokens
      + recentTail
      + this.dependencies.config.compaction.segmentTargetTokens;
    const providerThreshold = Math.floor(estimatorThreshold * (budget.calibrationRatio ?? 1));
    return Math.min(this.providerSoftLimit(budget), providerThreshold);
  }

  private persistCommitted(
    entry: Extract<SessionEntry, { type: "compaction" }>,
    details: Ds4CompactionDetails,
  ): void {
    const records = recordsFromCompactionEntry({
      sessionId: this.dependencies.sessionId,
      entry,
      details,
      lifecycleStatus: "committed",
    });
    for (const record of records) this.graphRecords.set(record.id, record);
    if (this.dependencies.database && this.dependencies.persisted) {
      this.dependencies.database.summaries.saveGraph(records);
    }
  }

  private reconcile(entries: readonly SessionEntry[]): void {
    for (const entry of entries) {
      if (entry.type !== "compaction") continue;
      const details = parseDs4CompactionDetails(entry.details);
      if (!details) continue;
      try {
        this.persistCommitted(entry, details);
      } catch (error) {
        this.dependencies.logger.warn("compaction.summary_graph_reconcile_failed", {
          summaryId: details.ds4ContextEngine.summaryId,
          entryId: entry.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private failPendingNodes(): void {
    if (this.dependencies.database && this.dependencies.persisted) {
      try {
        this.dependencies.database.summaries.markFailedMany(this.pendingSummaryIds);
      } catch (error) {
        this.dependencies.logger.warn("compaction.summary_graph_failure_persist_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const id of this.pendingSummaryIds) {
      const record = this.graphRecords.get(id);
      if (record?.lifecycleStatus === "prepared") {
        this.graphRecords.set(id, { ...record, lifecycleStatus: "failed" });
      }
    }
    this.pendingSummaryIds = [];
  }

  private reloadGraphRecords(): void {
    if (!this.dependencies.database || !this.dependencies.persisted) return;
    this.graphRecords.clear();
    for (const record of this.dependencies.database.summaries.listBySession(this.dependencies.sessionId)) {
      this.graphRecords.set(record.id, record);
    }
  }

  private restoreState(summary: SummaryRecord): void {
    this.state = {
      phase: summary.lifecycleStatus === "committed" ? "committed" : "failed",
      trigger: summary.reason,
      summaryId: summary.id,
      sourceEntries: summary.sourceEntryIds.length,
      validationStatus: summary.validationStatus,
      firstKeptEntryId: summary.firstKeptEntryId,
      tokensBefore: summary.tokensBefore,
      requestedAt: summary.createdAt,
      ...(summary.lifecycleStatus !== "prepared" ? { completedAt: summary.createdAt } : {}),
      ...(summary.lifecycleStatus === "failed" ? { lastError: "Prepared summary was not committed by Pi" } : {}),
    };
  }
}

export function defaultCompactionDiagnostics(config: Ds4ContextConfig): CompactionDiagnostics {
  return {
    enabled: config.compaction.enabled,
    validate: config.compaction.validate,
    preserveRecentVerbatim: config.compaction.preserveRecentVerbatim,
    segmentTargetTokens: config.compaction.segmentTargetTokens,
    phase: "idle",
    proactiveEligible: false,
  };
}

export function defaultSummaryGraphDiagnostics(): SummaryGraphDiagnostics {
  return {
    totalNodes: 0,
    committedNodes: 0,
    preparedNodes: 0,
    failedNodes: 0,
    segmentNodes: 0,
    aggregateNodes: 0,
    branchNodes: 0,
    maxGraphLevel: 0,
    rootSummaryIds: [],
    activePathIds: [],
    nodes: [],
  };
}
