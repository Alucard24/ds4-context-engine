import type { ContextBudget } from "../core/budget-manager.ts";

/**
 * A summary carries no managed-context supplements or recent tail. It may use
 * the calibrated hard budget, but never the space required by its output or
 * safety margin. The full prompt estimate (including framing) is compared here.
 */
export function compactionInputBudget(
  budget: ContextBudget,
  maxOutputTokens: number,
  mode: "summary" | "context" = "summary",
): number {
  const ratio = budget.calibrationRatio ?? 1;
  const limit = mode === "context" ? budget.activeInputBudget : budget.hardInputLimit;
  if (![ratio, limit, budget.hardInputLimit, budget.contextWindow, budget.safetyMargin, maxOutputTokens].every(Number.isFinite)
    || ratio <= 0 || maxOutputTokens < 1 || budget.safetyMargin < 0) return 0;
  const outputSafeLimit = Math.floor((budget.contextWindow - budget.safetyMargin - maxOutputTokens) / ratio);
  return Math.max(0, Math.floor(Math.min(limit, budget.hardInputLimit, outputSafeLimit)));
}
