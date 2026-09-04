import { randomUUID } from "node:crypto";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { CompactionThinkingLevel } from "ds4-context-core/config/config";
import {
  analyzeUnsupportedExactValueBullets,
  groundSummaryFileSections,
  validateSummary,
  type SummaryValidationInput,
  type SummaryValidationResult,
} from "ds4-context-core/compaction/summary-contract";

export const DEFAULT_COMPACTION_TRANSPORT_MAX_ATTEMPTS = 3;
export const DEFAULT_COMPACTION_TRANSPORT_BASE_DELAY_MS = 2000;
export const COMPACTION_TRANSPORT_MAX_DELAY_MS = 60_000;

/**
 * Transport retry policy for compaction summary requests. Defaults mirror Pi's
 * assistant retry settings (`retry.maxRetries` 3, `retry.baseDelayMs` 2000,
 * exponential backoff, abort-aware).
 */
export interface CompactionTransportPolicy {
  /** Total attempts for transport-classified failures. Default: 3. */
  maxAttempts?: number;
  /** Base backoff delay in ms, doubled per attempt. Default: 2000. */
  baseDelayMs?: number;
}

export function effectiveTransportPolicy(
  policy: CompactionTransportPolicy | undefined,
): { maxAttempts: number; baseDelayMs: number } {
  const maxAttempts = Math.min(
    10,
    Math.max(1, policy?.maxAttempts ?? DEFAULT_COMPACTION_TRANSPORT_MAX_ATTEMPTS),
  );
  const baseDelayMs = Math.min(
    COMPACTION_TRANSPORT_MAX_DELAY_MS,
    Math.max(0, policy?.baseDelayMs ?? DEFAULT_COMPACTION_TRANSPORT_BASE_DELAY_MS),
  );
  return { maxAttempts, baseDelayMs };
}

export function transportRetryDelayMs(baseDelayMs: number, failedAttempt: number): number {
  return Math.min(COMPACTION_TRANSPORT_MAX_DELAY_MS, baseDelayMs * 2 ** (failedAttempt - 1));
}

export interface CompactionTransportRetryDiagnostic {
  stage: "segment" | "aggregate";
  failedAttempt: number;
  nextAttempt: number;
  maxAttempts: number;
  delayMs: number;
}

export interface GenerateValidatedSummaryInput {
  stage: "segment" | "aggregate";
  prompt: string;
  validationSource: string;
  readFiles: readonly string[];
  modifiedFiles: readonly string[];
  validate: boolean;
  maxSummaryTokens: number;
  event: SessionBeforeCompactEvent;
  ctx: ExtensionContext;
  /** Dedicated compaction model; falls back to `ctx.model` when absent. */
  model?: Model<Api>;
  /** Reasoning level for the summary request; `off` (default) keeps the pre-existing request shape. */
  thinking?: CompactionThinkingLevel;
  /** Transport retry policy; defaults mirror Pi's assistant retry settings. */
  transport?: CompactionTransportPolicy;
  now: () => number;
  onTransportRetry?: (diagnostic: CompactionTransportRetryDiagnostic) => void;
}

export interface GeneratedSummary {
  content: string;
  validation: SummaryValidationResult;
  usage: Usage;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Maps a compaction thinking level to provider-specific request options.
 * Unknown/unsupported APIs return an empty object so the request keeps the
 * pre-existing shape (no thinking fields). `off` also returns an empty object.
 */
export function compactionThinkingOptions(
  api: string,
  level: CompactionThinkingLevel | undefined,
): Record<string, unknown> {
  if (!level || level === "off") return {};
  if (api === "anthropic-messages") {
    const effort = level === "minimal" || level === "low" ? "low" : level;
    return { thinkingEnabled: true, effort };
  }
  if ([
    "openai-completions",
    "openai-responses",
    "azure-openai-responses",
    "openai-codex-responses",
  ].includes(api)) {
    const effort = level === "minimal" || level === "low"
      ? "low"
      : level === "xhigh" || level === "max"
        ? "high"
        : level;
    return { samplingParams: { reasoning_effort: effort } };
  }
  return {};
}

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

function responseErrorMessage(response: unknown): string | undefined {
  if (!response || typeof response !== "object" || !("errorMessage" in response)) return undefined;
  return typeof response.errorMessage === "string" ? response.errorMessage : undefined;
}

type ProviderFailureCategory =
  | "aborted"
  | "usage-limit"
  | "rate-limit"
  | "input-limit"
  | "authentication"
  | "transport"
  | "provider-error";

function providerFailureCategory(value: unknown): ProviderFailureCategory {
  const message = value instanceof Error
    ? value.message
    : typeof value === "string"
      ? value
      : "";
  if (value instanceof Error && value.name === "AbortError") return "aborted";
  if (/usage|quota|credit|billing/iu.test(message)) return "usage-limit";
  if (/rate|too many requests|429/iu.test(message)) return "rate-limit";
  if (/(?:context|prompt|input).{0,48}(?:exceed|limit|maximum|too (?:long|large)|tokens?)|tokens?.{0,48}(?:exceed|limit|maximum|too many)|maximum (?:context|input|prompt|length)/iu.test(message)) {
    return "input-limit";
  }
  if (/auth|credential|api.?key|permission|forbidden|401|403/iu.test(message)) return "authentication";
  if (/timeout|timed out|network|connection|socket|dns|fetch failed|econn(?:reset|refused|aborted)|etimedout|eai_again|enotfound|und_err/iu.test(message)) {
    return "transport";
  }
  if (/abort|cancel/iu.test(message)) return "aborted";
  return "provider-error";
}

function abortedError(): Error {
  return new Error("Compaction summary generation aborted");
}

async function waitForTransportRetry(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (signal.aborted) throw abortedError();
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortedError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function transportFailureSuffix(category: ProviderFailureCategory, attempts: number): string {
  return category === "transport"
    ? `category=${category}; attempts=${attempts}`
    : `category=${category}`;
}

export async function generateValidatedSummary(
  input: GenerateValidatedSummaryInput,
): Promise<GeneratedSummary> {
  const model = input.model ?? input.ctx.model;
  if (!model) throw new Error("Compaction summary generation requires an active model");
  const maxTokens = Math.max(1, Math.min(input.maxSummaryTokens, model.maxTokens ?? input.maxSummaryTokens));
  const { maxAttempts, baseDelayMs } = effectiveTransportPolicy(input.transport);
  const retryUsages: Usage[] = [];
  let response: Awaited<ReturnType<typeof input.ctx.modelRegistry.complete>>;
  let attempt = 0;
  for (;;) {
    if (input.event.signal.aborted) throw abortedError();
    attempt++;
    try {
      response = await input.ctx.modelRegistry.complete(
        model,
        {
          messages: [{
            role: "user",
            content: [{ type: "text", text: input.prompt }],
            timestamp: input.now(),
          }],
        },
        {
          maxTokens,
          signal: input.event.signal,
          cacheRetention: "none",
          sessionId: randomUUID(),
          ...compactionThinkingOptions(model.api, input.thinking),
        } as NonNullable<Parameters<typeof input.ctx.modelRegistry.complete>[2]>,
      );
    } catch (error) {
      if (input.event.signal.aborted) throw abortedError();
      const category = providerFailureCategory(error);
      if (category !== "transport" || attempt >= maxAttempts) {
        throw new Error(
          `Compaction ${input.stage} request failed (${transportFailureSuffix(category, attempt)})`,
        );
      }
      const delayMs = transportRetryDelayMs(baseDelayMs, attempt);
      await waitForTransportRetry(input.event.signal, delayMs);
      input.onTransportRetry?.({
        stage: input.stage,
        failedAttempt: attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs,
      });
      continue;
    }
    if (input.event.signal.aborted) throw abortedError();
    const stopReason = responseStopReason(response);
    if (stopReason === "error") {
      const category = providerFailureCategory(responseErrorMessage(response));
      if (category === "transport" && attempt < maxAttempts) {
        retryUsages.push(response.usage);
        const delayMs = transportRetryDelayMs(baseDelayMs, attempt);
        await waitForTransportRetry(input.event.signal, delayMs);
        input.onTransportRetry?.({
          stage: input.stage,
          failedAttempt: attempt,
          nextAttempt: attempt + 1,
          maxAttempts,
          delayMs,
        });
        continue;
      }
      throw new Error(
        `Compaction ${input.stage} summary stopped with error (${transportFailureSuffix(category, attempt)})`,
      );
    }
    if (stopReason === "aborted") {
      throw new Error(`Compaction ${input.stage} summary stopped with aborted (category=aborted)`);
    }
    if (stopReason === "length") throw new Error("Compaction summary hit the model output limit");
    break;
  }
  if (response.content.some((block) => block.type === "toolCall")) {
    throw new Error("Compaction summarizer attempted to call a tool");
  }
  const generatedContent = responseText(response);
  if (!generatedContent) throw new Error("Compaction summarizer returned empty text");
  let content = groundSummaryFileSections(generatedContent, {
    readFiles: input.readFiles,
    modifiedFiles: input.modifiedFiles,
  });
  const validationInput: SummaryValidationInput = {
    sourceText: input.validationSource,
    readFiles: input.readFiles,
    modifiedFiles: input.modifiedFiles,
  };
  let validation: SummaryValidationResult = input.validate
    ? validateSummary(content, validationInput)
    : {
        status: "warning",
        issues: [{
          code: "validation-disabled",
          severity: "warning",
          message: "Deterministic validation disabled by configuration",
        }],
      };
  let exactRepair: ReturnType<typeof analyzeUnsupportedExactValueBullets> | undefined;
  let exactRepairFailure: "post-prune-invalid" | undefined;
  if (validation.status === "invalid") {
    const errors = validation.issues.filter((issue) => issue.severity === "error");
    const exactOnly = errors.length > 0
      && errors.every((issue) => issue.code === "unsupported-exact-value");
    exactRepair = exactOnly
      ? analyzeUnsupportedExactValueBullets(content, validationInput)
      : undefined;
    const pruned = exactRepair?.result;
    if (pruned) {
      const repairedValidation = validateSummary(pruned.content, validationInput);
      if (repairedValidation.status !== "invalid") {
        content = pruned.content;
        validation = {
          status: "warning",
          issues: [
            ...repairedValidation.issues,
            {
              code: "unsupported-exact-bullets-pruned",
              severity: "warning",
              message: `Removed ${pruned.removedBullets} bullet(s) containing unsupported exact values`,
            },
          ],
        };
      } else {
        validation = repairedValidation;
        exactRepairFailure = "post-prune-invalid";
      }
    }
  }
  if (validation.status === "invalid") {
    const codes = unique(validation.issues.map((issue) => issue.code)).join(", ");
    const repairDiagnostics = exactRepair
      ? `; repair=${exactRepairFailure ?? exactRepair.status}; unsupportedSpans=${exactRepair.unsupportedSpans}; affectedBullets=${exactRepair.affectedBullets}`
      : "";
    throw new Error(`Compaction ${input.stage} summary validation failed: ${codes}${repairDiagnostics}`);
  }
  return { content, validation, usage: sumUsage([...retryUsages, response.usage]) };
}

export function sumUsage(usages: readonly Usage[]): Usage {
  const sum = (read: (usage: Usage) => number): number => usages.reduce((total, usage) => total + read(usage), 0);
  const hasReasoning = usages.some((usage) => usage.reasoning !== undefined);
  const hasCacheWrite1h = usages.some((usage) => usage.cacheWrite1h !== undefined);
  return {
    input: sum((usage) => usage.input),
    output: sum((usage) => usage.output),
    cacheRead: sum((usage) => usage.cacheRead),
    cacheWrite: sum((usage) => usage.cacheWrite),
    ...(hasCacheWrite1h ? { cacheWrite1h: sum((usage) => usage.cacheWrite1h ?? 0) } : {}),
    ...(hasReasoning ? { reasoning: sum((usage) => usage.reasoning ?? 0) } : {}),
    totalTokens: sum((usage) => usage.totalTokens),
    cost: {
      input: sum((usage) => usage.cost.input),
      output: sum((usage) => usage.cost.output),
      cacheRead: sum((usage) => usage.cost.cacheRead),
      cacheWrite: sum((usage) => usage.cost.cacheWrite),
      total: sum((usage) => usage.cost.total),
    },
  };
}
