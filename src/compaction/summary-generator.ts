import { randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  groundSummaryFileSections,
  pruneUnsupportedExactValueBullets,
  validateSummary,
  type SummaryValidationInput,
  type SummaryValidationResult,
} from "./summary-contract.ts";

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
  now: () => number;
}

export interface GeneratedSummary {
  content: string;
  validation: SummaryValidationResult;
  usage: Usage;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
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

export async function generateValidatedSummary(
  input: GenerateValidatedSummaryInput,
): Promise<GeneratedSummary> {
  const model = input.ctx.model;
  if (!model) throw new Error("Compaction summary generation requires an active model");
  const maxTokens = Math.max(1, Math.min(input.maxSummaryTokens, model.maxTokens ?? input.maxSummaryTokens));
  const response = await input.ctx.modelRegistry.complete(
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
    },
  );
  if (input.event.signal.aborted) throw new Error("Compaction summary generation aborted");
  const stopReason = responseStopReason(response);
  if (stopReason === "length") throw new Error("Compaction summary hit the model output limit");
  if (stopReason === "error" || stopReason === "aborted") {
    throw new Error(`Compaction summary stopped with ${stopReason}`);
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
  if (validation.status === "invalid") {
    const errors = validation.issues.filter((issue) => issue.severity === "error");
    const exactOnly = errors.length > 0
      && errors.every((issue) => issue.code === "unsupported-exact-value");
    const pruned = exactOnly
      ? pruneUnsupportedExactValueBullets(content, validationInput)
      : undefined;
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
      }
    }
  }
  if (validation.status === "invalid") {
    const codes = unique(validation.issues.map((issue) => issue.code)).join(", ");
    throw new Error(`Compaction ${input.stage} summary validation failed: ${codes}`);
  }
  return { content, validation, usage: response.usage };
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
