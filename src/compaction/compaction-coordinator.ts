import { randomUUID } from "node:crypto";
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
import { prepareCompactionSource } from "../pi-adapter/compaction-adapter.ts";
import { adaptiveRecentTailLimit } from "../planner/context-planner.ts";
import type { Logger } from "../shared/logging.ts";
import {
  type CompactionTrigger,
  type Ds4CompactionDetails,
  type Ds4CompactionMetadata,
  parseDs4CompactionDetails,
  type SummaryRecord,
} from "./compaction-record.ts";
import {
  buildSummaryPrompt,
  SUMMARY_CONTRACT_VERSION,
  validateSummary,
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
}

type MutableCompactionState = Omit<
  CompactionDiagnostics,
  "enabled" | "validate" | "preserveRecentVerbatim" | "segmentTargetTokens" | "proactiveEligible"
>;

function responseText(response: unknown): string {
  if (!response || typeof response !== "object" || !("content" in response)) return "";
  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    if (!block || typeof block !== "object" || !("type" in block) || !("text" in block)) return [];
    return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n").trim();
}

function responseStopReason(response: unknown): string | undefined {
  if (!response || typeof response !== "object" || !("stopReason" in response)) return undefined;
  return typeof response.stopReason === "string" ? response.stopReason : undefined;
}

export class CompactionCoordinator {
  private state: MutableCompactionState = { phase: "idle" };
  private pendingSummaryId?: string;
  private proactiveRequested = false;
  private lastProactiveLeafId?: string;

  constructor(private readonly dependencies: CompactionCoordinatorDependencies) {}

  initialize(entries: readonly SessionEntry[]): void {
    if (!this.dependencies.database || !this.dependencies.persisted) return;
    this.dependencies.database.summaries.failPreparedForSession(this.dependencies.sessionId);
    this.reconcile(entries);
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
      const prompt = buildSummaryPrompt({
        conversationText: source.conversationText,
        ...(source.previousSummary ? { previousSummary: source.previousSummary } : {}),
        ...(event.customInstructions ? { customInstructions: event.customInstructions } : {}),
        readFiles: source.readFiles,
        modifiedFiles: source.modifiedFiles,
        isSplitTurn: event.preparation.isSplitTurn,
      });
      const maxTokens = Math.max(
        1,
        Math.min(config.context.maxSummaryTokens, ctx.model.maxTokens ?? config.context.maxSummaryTokens),
      );
      const response = await ctx.modelRegistry.complete(
        ctx.model,
        {
          messages: [{
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: this.dependencies.now(),
          }],
        },
        {
          maxTokens,
          signal: event.signal,
          cacheRetention: "none",
          sessionId: randomUUID(),
        },
      );
      if (event.signal.aborted) throw new Error("Compaction summary generation aborted");
      const stopReason = responseStopReason(response);
      if (stopReason === "length") throw new Error("Compaction summary hit the model output limit");
      if (stopReason === "error" || stopReason === "aborted") {
        throw new Error(`Compaction summary stopped with ${stopReason}`);
      }
      if (response.content.some((block) => block.type === "toolCall")) {
        throw new Error("Compaction summarizer attempted to call a tool");
      }
      const summary = responseText(response);
      if (!summary) throw new Error("Compaction summarizer returned empty text");

      const validation = config.compaction.validate
        ? validateSummary(summary, {
            sourceText: source.sourceText,
            readFiles: source.readFiles,
            modifiedFiles: source.modifiedFiles,
          })
        : {
            status: "warning" as const,
            issues: [{
              code: "validation-disabled",
              severity: "warning" as const,
              message: "Deterministic validation disabled by configuration",
            }],
          };
      if (validation.status === "invalid") {
        const codes = [...new Set(validation.issues.map((issue) => issue.code))].join(", ");
        throw new Error(`Compaction summary validation failed: ${codes}`);
      }

      const summaryId = this.dependencies.idGenerator();
      const generatedAt = this.dependencies.now();
      const metadata: Ds4CompactionMetadata = {
        schemaVersion: 1,
        contractVersion: SUMMARY_CONTRACT_VERSION,
        summaryId,
        sourceHash: source.sourceHash,
        sourceEntryIds: [...source.sourceEntryIds],
        validationStatus: validation.status,
        validationIssueCodes: [...new Set(validation.issues.map((issue) => issue.code))],
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        reason: trigger,
        isSplitTurn: event.preparation.isSplitTurn,
        messageCount: source.messages.length,
        generatedAt,
        provider: ctx.model.provider,
        model: ctx.model.id,
      };
      const details: Ds4CompactionDetails = {
        readFiles: source.readFiles,
        modifiedFiles: source.modifiedFiles,
        ds4ContextEngine: metadata,
      };
      const record: SummaryRecord = {
        id: summaryId,
        sessionId: this.dependencies.sessionId,
        kind: "segment",
        content: summary,
        sourceHash: source.sourceHash,
        sourceEntryIds: source.sourceEntryIds,
        createdAt: generatedAt,
        validationStatus: validation.status,
        provider: ctx.model.provider,
        model: ctx.model.id,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        reason: trigger,
        lifecycleStatus: "prepared",
        metadata,
      };
      if (this.dependencies.persisted) this.dependencies.database?.summaries.save(record);
      this.pendingSummaryId = summaryId;
      this.state = {
        phase: "prepared",
        trigger,
        summaryId,
        sourceEntries: source.sourceEntryIds.length,
        validationStatus: validation.status,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        requestedAt,
      };
      this.dependencies.logger.info("compaction.summary_prepared", {
        summaryId,
        trigger,
        sourceEntries: source.sourceEntryIds.length,
        validationStatus: validation.status,
        tokensBefore: event.preparation.tokensBefore,
      });
      return {
        compaction: {
          summary,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          usage: response.usage,
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
    const details = parseDs4CompactionDetails(event.compactionEntry.details);
    if (!details) {
      if (this.pendingSummaryId) this.dependencies.database?.summaries.markFailed(this.pendingSummaryId);
      const customError = this.state.lastError;
      this.pendingSummaryId = undefined;
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

    try {
      this.persistCommitted(event.compactionEntry, details);
    } catch (error) {
      this.dependencies.logger.warn("compaction.summary_commit_persist_failed", {
        summaryId: details.ds4ContextEngine.summaryId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.pendingSummaryId = undefined;
    this.state = {
      phase: "committed",
      trigger: details.ds4ContextEngine.reason,
      summaryId: details.ds4ContextEngine.summaryId,
      sourceEntries: details.ds4ContextEngine.sourceEntryIds.length,
      validationStatus: details.ds4ContextEngine.validationStatus,
      firstKeptEntryId: event.compactionEntry.firstKeptEntryId,
      tokensBefore: event.compactionEntry.tokensBefore,
      requestedAt: details.ds4ContextEngine.generatedAt,
      completedAt: this.dependencies.now(),
    };
    this.dependencies.logger.info("compaction.summary_committed", {
      summaryId: details.ds4ContextEngine.summaryId,
      compactionEntryId: event.compactionEntry.id,
      trigger: details.ds4ContextEngine.reason,
    });
  }

  compactionFailed(event: SessionCompactFailedLike): void {
    this.proactiveRequested = false;
    if (this.pendingSummaryId) this.dependencies.database?.summaries.markFailed(this.pendingSummaryId);
    const message = event.errorMessage ?? (event.aborted ? "Compaction aborted" : "Compaction failed");
    this.state = {
      ...this.state,
      phase: "failed",
      trigger: this.state.trigger ?? event.reason,
      completedAt: this.dependencies.now(),
      lastError: message,
    };
    this.pendingSummaryId = undefined;
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
    if (!this.dependencies.database || !this.dependencies.persisted) return;
    const metadata = details.ds4ContextEngine;
    this.dependencies.database.summaries.save({
      id: metadata.summaryId,
      sessionId: this.dependencies.sessionId,
      kind: "segment",
      content: entry.summary,
      sourceHash: metadata.sourceHash,
      sourceEntryIds: metadata.sourceEntryIds,
      createdAt: metadata.generatedAt,
      validationStatus: metadata.validationStatus,
      provider: metadata.provider,
      model: metadata.model,
      firstKeptEntryId: entry.firstKeptEntryId,
      tokensBefore: entry.tokensBefore,
      reason: metadata.reason,
      lifecycleStatus: "committed",
      piCompactionEntryId: entry.id,
      metadata,
    });
  }

  private reconcile(entries: readonly SessionEntry[]): void {
    for (const entry of entries) {
      if (entry.type !== "compaction") continue;
      const details = parseDs4CompactionDetails(entry.details);
      if (!details) continue;
      try {
        this.persistCommitted(entry, details);
      } catch (error) {
        this.dependencies.logger.warn("compaction.summary_reconcile_failed", {
          summaryId: details.ds4ContextEngine.summaryId,
          entryId: entry.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
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
