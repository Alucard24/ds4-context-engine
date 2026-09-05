import type { ArtifactConfig } from "../config/config.ts";
import { estimateMessageTokens } from "../core/token-estimator.ts";

export interface ArtifactInputBudget {
  /** Same calibrated local-estimator units as the context planner. */
  inputTokens: number;
  fixedTokens: number;
}

/** Pure, per-call caps. Never mutate configuration or enlarge static limits. */
export function adaptiveArtifactConfig(
  config: ArtifactConfig,
  messages: readonly unknown[],
  budget?: ArtifactInputBudget,
): ArtifactConfig {
  if (!config.adaptiveBudget || !budget
    || !Number.isFinite(budget.inputTokens) || budget.inputTokens < 0
    || !Number.isFinite(budget.fixedTokens) || budget.fixedTokens < 0) return config;
  const floor = Math.min(1600, config.maxInlineToolResultChars);
  let fixedTokens = budget.fixedTokens;
  let candidates = 0;
  for (const message of messages) {
    const record = message as { role?: string; content?: Array<{ type?: string; text?: string }> } | null;
    const content = Array.isArray(record?.content) ? record.content : [];
    const texts = content.filter((block) => block?.type === "text" && typeof block.text === "string");
    const chars = texts.reduce((sum, block) => sum + block.text!.length, 0);
    if (record?.role === "toolResult" && chars > floor) {
      candidates++;
      fixedTokens += estimateMessageTokens({ ...record, content: content.filter((block) => !texts.includes(block)) }) + 4;
    } else {
      fixedTokens += estimateMessageTokens(message);
    }
  }
  if (candidates === 0) return config;
  // Four chars/token is the core estimator's unit. Leave 25% of remaining
  // capacity unused; references have an irreducible metadata floor.
  const sharedChars = Math.floor(Math.max(0, budget.inputTokens - fixedTokens) * 4 * 0.75 / candidates);
  const maxInlineToolResultChars = Math.min(config.maxInlineToolResultChars, Math.max(floor, sharedChars));
  return {
    ...config,
    maxInlineToolResultChars,
    excerptChars: Math.min(config.excerptChars, Math.max(0, Math.floor((maxInlineToolResultChars - 1600) / 2))),
  };
}
