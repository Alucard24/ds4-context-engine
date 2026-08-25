import type {
  CompactionResult,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Ds4ContextConfig } from "../config/config.ts";
import { calculateContextBudget, type ContextBudget } from "../core/budget-manager.ts";
import { createModelProfile } from "../core/model-profile.ts";
import type { ContextManifest } from "../manifest/context-manifest.ts";
import type { ContextDatabase } from "../persistence/sqlite.ts";
import {
  highestClassification,
  type PrivacyClassification,
} from "../privacy/privacy-policy.ts";
import { prepareCompactionSource } from "../pi-adapter/compaction-adapter.ts";
import { adaptiveRecentTailLimit } from "../planner/context-planner.ts";
import type { Logger } from "../shared/logging.ts";
import {
  type CompactionTrigger,
  type Ds4CompactionDetails,
  type EmbeddedSummaryNode,
  parseDs4CompactionDetails,
  type SummaryRecord,
} from "./compaction-record.ts";
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
} from "./summary-graph.ts";
import {
  buildAggregateSummaryPrompt,
  buildSummaryPrompt,
  computeAggregateSourceHash,
  type SummaryValidationStatus,
} from "./summary-contract.ts";

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
    if (!config.compaction.enabled || !config.enabled || !ctx.model || config.context.maxSummaryTokens <= 0) {
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
      this.state.sourceEntries = source.sourceEntryIds.length;
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
        provider: ctx.model.provider,
        model: ctx.model.id,
      };
      const classifyContent = (text: string): { value: string; classification: PrivacyClassification } => {
        const classified = this.dependencies.classifyContent?.(text, ctx.model!.provider);
        if (classified) return classified;
        return {
          value: this.dependencies.sanitizeContent?.(text, ctx.model!.provider) ?? text,
          classification: "normal",
        };
      };
      const sourcePrivacy = classifyContent(source.conversationText);
      const validationPrivacy = classifyContent(source.sourceText);
      const instructionPrivacy = event.customInstructions
        ? classifyContent(event.customInstructions)
        : undefined;
      const readFilePrivacy = source.segmentReadFiles.map(classifyContent);
      const modifiedFilePrivacy = source.segmentModifiedFiles.map(classifyContent);
      const segmentClassification = [
        sourcePrivacy.classification,
        validationPrivacy.classification,
        ...(instructionPrivacy ? [instructionPrivacy.classification] : []),
        ...readFilePrivacy.map((item) => item.classification),
        ...modifiedFilePrivacy.map((item) => item.classification),
      ].reduce(highestClassification, "normal" as PrivacyClassification);
      const segmentGenerated = await this.generateSummary({
        prompt: buildSummaryPrompt({
          conversationText: sourcePrivacy.value,
          ...(instructionPrivacy ? { customInstructions: instructionPrivacy.value } : {}),
          readFiles: readFilePrivacy.map((item) => item.value),
          modifiedFiles: modifiedFilePrivacy.map((item) => item.value),
          isSplitTurn: event.preparation.isSplitTurn,
        }),
        validationSource: validationPrivacy.value,
        readFiles: readFilePrivacy.map((item) => item.value),
        modifiedFiles: modifiedFilePrivacy.map((item) => item.value),
        event,
        ctx,
      });
      const segmentId = nextId();
      const segmentNode: EmbeddedSummaryNode = {
        id: segmentId,
        kind: "segment",
        content: classifiedSummary(segmentGenerated.content, segmentClassification),
        sourceHash: source.sourceHash,
        sourceEntryIds: [...source.sourceEntryIds],
        childSummaryIds: [],
        graphLevel: 0,
        createdAt: this.dependencies.now(),
        validationStatus: segmentGenerated.validation.status,
        validationIssueCodes: unique(segmentGenerated.validation.issues.map((issue) => issue.code)),
        provider: ctx.model.provider,
        model: ctx.model.id,
      };

      const embeddedNodes: EmbeddedSummaryNode[] = [];
      let previousNode = source.previousNode;
      if (!previousNode && source.previousSummary) {
        previousNode = importUntrackedPreviousSummary({
          id: nextId(),
          content: source.previousSummary,
          createdAt: this.dependencies.now(),
          provider: ctx.model.provider,
          model: ctx.model.id,
        });
        embeddedNodes.push(previousNode);
      }

      const usages = [segmentGenerated.usage];
      let activeNode = segmentNode;
      if (previousNode) {
        const aggregateChildren = [previousNode, segmentNode];
        const classifiedChildren = aggregateChildren.map((child) => ({
          child,
          privacy: classifyContent(child.content),
        }));
        const promptChildren = classifiedChildren.map(({ child, privacy }) => ({
          ...child,
          content: privacy.value,
        }));
        const aggregateReadFiles = source.readFiles.map(classifyContent);
        const aggregateModifiedFiles = source.modifiedFiles.map(classifyContent);
        const aggregateInstruction = event.customInstructions
          ? classifyContent(event.customInstructions)
          : undefined;
        const aggregateClassification = [
          ...classifiedChildren.map((item) => item.privacy.classification),
          ...(aggregateInstruction ? [aggregateInstruction.classification] : []),
          ...aggregateReadFiles.map((item) => item.classification),
          ...aggregateModifiedFiles.map((item) => item.classification),
        ].reduce(highestClassification, "normal" as PrivacyClassification);
        const aggregateGenerated = await this.generateSummary({
          prompt: buildAggregateSummaryPrompt({
            children: promptChildren,
            ...(aggregateInstruction ? { customInstructions: aggregateInstruction.value } : {}),
            readFiles: aggregateReadFiles.map((item) => item.value),
            modifiedFiles: aggregateModifiedFiles.map((item) => item.value),
          }),
          validationSource: promptChildren.map((child) => child.content).join("\n\n"),
          readFiles: aggregateReadFiles.map((item) => item.value),
          modifiedFiles: aggregateModifiedFiles.map((item) => item.value),
          event,
          ctx,
        });
        usages.push(aggregateGenerated.usage);
        activeNode = {
          id: nextId(),
          kind: "aggregate",
          content: classifiedSummary(aggregateGenerated.content, aggregateClassification),
          sourceHash: computeAggregateSourceHash(aggregateChildren),
          sourceEntryIds: unique(aggregateChildren.flatMap((child) => child.sourceEntryIds)),
          childSummaryIds: aggregateChildren.map((child) => child.id),
          graphLevel: Math.max(...aggregateChildren.map((child) => child.graphLevel)) + 1,
          createdAt: this.dependencies.now(),
          validationStatus: aggregateGenerated.validation.status,
          validationIssueCodes: unique(aggregateGenerated.validation.issues.map((issue) => issue.code)),
          provider: ctx.model.provider,
          model: ctx.model.id,
        };
        embeddedNodes.push(segmentNode);
      }

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
      };
      this.dependencies.logger.info("compaction.summary_graph_prepared", {
        activeSummaryId: activeNode.id,
        segmentSummaryId: segmentId,
        graphLevel: activeNode.graphLevel,
        createdNodes: records.length,
        sourceEntries: activeNode.sourceEntryIds.length,
        validationStatus: activeNode.validationStatus,
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
      const customError = this.state.lastError;
      this.state = {
        phase: "pi-default",
        trigger: event.reason,
        firstKeptEntryId: event.compactionEntry.firstKeptEntryId,
        tokensBefore: event.compactionEntry.tokensBefore,
        completedAt: this.dependencies.now(),
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
    };
    this.dependencies.logger.info("compaction.summary_graph_committed", {
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
    const budget = calculateContextBudget(createModelProfile(ctx.model), config.context);
    const leafId = ctx.sessionManager.getLeafId() ?? "root";
    const threshold = this.proactiveThreshold(budget);
    if (usage.tokens < threshold || this.lastProactiveLeafId === leafId) return;

    this.proactiveRequested = true;
    this.lastProactiveLeafId = leafId;
    this.state = {
      phase: "requested",
      trigger: "proactive",
      requestedAt: this.dependencies.now(),
      contextTokens: usage.tokens,
      softLimitTokens: budget.softInputLimit,
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
    const budget = ctx.model ? calculateContextBudget(createModelProfile(ctx.model), config.context) : undefined;
    const contextTokens = usage?.tokens ?? undefined;
    const threshold = budget ? this.proactiveThreshold(budget) : undefined;
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
      ...(budget ? { softLimitTokens: budget.softInputLimit } : {}),
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

  private generateSummary(input: {
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

  private proactiveThreshold(budget: ContextBudget): number {
    const manifest = this.dependencies.latestManifest();
    const fixedTokens = (manifest?.composition.systemTokens ?? 0) + (manifest?.composition.toolTokens ?? 0);
    const recentTail = adaptiveRecentTailLimit(
      budget.contextWindow,
      this.dependencies.config.context.recentTailTokens,
    );
    const segmentThreshold = fixedTokens + recentTail + this.dependencies.config.compaction.segmentTargetTokens;
    return Math.min(budget.softInputLimit, segmentThreshold);
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
