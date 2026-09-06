/**
 * Cache-aware planning policy (pure, portable).
 *
 * The provider-independent core never hardcodes prices. It receives pricing
 * from the runtime adapter (normally proxied from Pi model metadata) together
 * with observed cache shares, and decides whether an extended recent tail
 * is justified economically. All functions are deterministic and side-effect
 * free so they can be unit-tested without a provider.
 */

/**
 * Per-million-token prices. All values are plain numbers; absent values are
 * represented as `undefined` and treated as "unknown" (politely ignored).
 */
export interface CachePricing {
  /** Un-cached input tokens per million. */
  inputPerMillion?: number;
  /** Prefix cache read tokens per million. */
  cacheReadPerMillion?: number;
  /** Prefix cache write tokens per million. */
  cacheWritePerMillion?: number;
  /** Output tokens per million. */
  outputPerMillion?: number;
}

export interface CacheAwareConfig {
  /** Off preserves the previous planner behavior exactly. */
  mode: "off" | "auto";
  /**
   * Minimum number of observed samples before the policy may rely on the
   * cache share; below this the decision degrades to no-op.
   */
  minimumCacheSampleCount: number;
  /** Minimum observed cache-read share (0..1) before an extended tail is eligible. */
  minimumCacheReadShare: number;
  /** Minimum cache-miss / cache-hit price ratio before an extended tail is eligible. */
  minimumMissHitRatio: number;
  /**
   * Relative cost improvement (0..1) an alternative plan must show before the
   * planner switches to it; hysteresis against oscillation.
   */
  minimumImprovementRatio: number;
  /**
   * Fraction (0..1) of the available input budget a cache-aware tail may use.
   * The planner still enforces hard limits; this only bounds the request.
   */
  maxTailBudgetShare: number;
}

export const DEFAULT_CACHE_AWARE_CONFIG: CacheAwareConfig = {
  mode: "off",
  minimumCacheSampleCount: 3,
  minimumCacheReadShare: 0.5,
  minimumMissHitRatio: 20,
  minimumImprovementRatio: 0.1,
  maxTailBudgetShare: 0.5,
};

export interface CacheAwarePlanDecision {
  /** Whether the policy is active in this configuration. */
  eligible: boolean;
  /** Computed miss/hit price ratio, when both prices are known. */
  missHitRatio?: number;
  /** Observed cache-read share rounded to 6 decimals, when samples exist. */
  cacheReadShare?: number;
  /** Observed calibration sample count. */
  sampleCount: number;
  /** Requested recent-tail tokens (extended when eligible). */
  recentTailTokens: number;
  /**
   * True when the requested tail differs from the nominal configured tail,
   * i.e. the plan would change behavior.
   */
  tailExtended: boolean;
  /** Human-readable machine-parseable reason codes; never provider content. */
  reasons: string[];
}

/**
 * Index of the longest common prefix between two streams of message hashes.
 * `undefined` hashes are treated as distinct sentinels so callers can avoid
 * accidental prefix reuse across plan changes.
 */
export function commonMessagePrefixLength(
  previousHashes: readonly (string | undefined)[],
  currentHashes: readonly (string | undefined)[],
): number {
  let length = 0;
  const max = Math.min(previousHashes.length, currentHashes.length);
  for (let index = 0; index < max; index++) {
    const left = previousHashes[index];
    const right = currentHashes[index];
    if (left === undefined || right === undefined || left !== right) break;
    length++;
  }
  return length;
}

/**
 * Estimated reusable prefix tokens: the tokens of the common prefix only.
 * The caller supplies per-message token estimates aligned with the hashes.
 */
export function estimateReusablePrefixTokens(
  previousHashes: readonly (string | undefined)[],
  currentHashes: readonly (string | undefined)[],
  tokenEstimates: readonly number[],
): number {
  const prefixLength = commonMessagePrefixLength(previousHashes, currentHashes);
  let tokens = 0;
  for (let index = 0; index < prefixLength; index++) {
    const contribution = tokenEstimates[index];
    if (contribution !== undefined && Number.isFinite(contribution) && contribution > 0) {
      tokens += contribution;
    }
  }
  return tokens;
}

export interface EstimatedRequestCost {
  /** Estimated un-cached input tokens. */
  inputTokens: number;
  /** Estimated cached (prefix) input tokens. */
  cacheReadTokens: number;
  /** Estimated output tokens. */
  outputTokens: number;
  /** Estimated total cost in dollars; undefined when pricing is incomplete. */
  total?: number;
}

/**
 * Expected cost of one request given a reusable prefix. Costs are computed
 * with per-million rates; missing rates are treated as zero only when the
 * user explicitly wants a partial estimate, otherwise `total` stays
 * `undefined` if any rate that is actually consumed is missing.
 */
export function estimateRequestCost(input: {
  totalInputTokens: number;
  reusablePrefixTokens: number;
  outputTokens?: number;
}, pricing: CachePricing): EstimatedRequestCost {
  const inputTokens = Math.max(0, input.totalInputTokens - input.reusablePrefixTokens);
  const cacheReadTokens = Math.min(input.totalInputTokens, input.reusablePrefixTokens);
  const outputTokens = Math.max(0, input.outputTokens ?? 0);
  const result: EstimatedRequestCost = { inputTokens, cacheReadTokens, outputTokens };

  const hasConsumedRates = (rate: number | undefined): rate is number =>
    rate !== undefined && Number.isFinite(rate) && rate >= 0;
  const inputRate = hasConsumedRates(pricing.inputPerMillion) ? pricing.inputPerMillion : undefined;
  const readRate = hasConsumedRates(pricing.cacheReadPerMillion) ? pricing.cacheReadPerMillion : undefined;

  if ((inputTokens > 0 && inputRate === undefined) || (cacheReadTokens > 0 && readRate === undefined)) {
    return result;
  }
  const outputRate = hasConsumedRates(pricing.outputPerMillion) ? pricing.outputPerMillion : undefined;
  if (outputTokens > 0 && outputRate === undefined) {
    return result;
  }

  const total = (inputTokens * (inputRate ?? 0)
    + cacheReadTokens * (readRate ?? 0)
    + outputTokens * (outputRate ?? 0)) / 1_000_000;
  return { ...result, total: rounded(total) };
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Cache-aware tail sizing decision.
 *
 * The policy is deliberately conservative:
 * - `mode: "off"` always returns the nominal tail and `eligible: false`;
 * - pricing or observation gaps disable eligibility;
 * - the miss/hit ratio and the observed cache-read share must both beat the
 *   configured minima;
 * - the extended tail is bounded by `maxTailBudgetShare` of the active input
 *   budget, so the tightest budget always wins.
 */
export function decideCacheAwareTail(input: {
  config: CacheAwareConfig;
  pricing?: CachePricing;
  observedCacheReadShare?: number;
  sampleCount: number;
  nominalRecentTailTokens: number;
  activeInputBudget: number;
}): CacheAwarePlanDecision {
  const reasons: string[] = [];
  const recentTailTokens = input.nominalRecentTailTokens;
  const baseline: CacheAwarePlanDecision = {
    eligible: false,
    sampleCount: input.sampleCount,
    recentTailTokens,
    tailExtended: false,
    reasons: ["off-or-insufficient-evidence"],
  };
  if (input.config.mode === "off") return baseline;

  const missRatio = ratio(input.pricing?.inputPerMillion, input.pricing?.cacheReadPerMillion);
  const share = input.observedCacheReadShare;
  if (missRatio !== undefined) {
    if (missRatio < input.config.minimumMissHitRatio) {
      reasons.push(`miss-hit-ratio-below-threshold:${missRatio.toFixed(2)}`);
    }
  } else {
    reasons.push("cache-pricing-incomplete");
  }
  if (share !== undefined) {
    if (share < input.config.minimumCacheReadShare) {
      reasons.push(`cache-read-share-below-threshold:${share.toFixed(4)}`);
    }
  } else {
    reasons.push("cache-share-unobserved");
  }
  if (input.sampleCount < input.config.minimumCacheSampleCount) {
    reasons.push(`insufficient-samples:${input.sampleCount}`);
  }
  if (missRatio !== undefined && missRatio < input.config.minimumMissHitRatio) {
    return {
      eligible: false,
      ...(missRatio !== undefined ? { missHitRatio: missRatio } : {}),
      ...(share !== undefined ? { cacheReadShare: share } : {}),
      sampleCount: input.sampleCount,
      recentTailTokens,
      tailExtended: false,
      reasons,
    };
  }
  if (share !== undefined && share < input.config.minimumCacheReadShare) {
    return {
      eligible: false,
      ...(missRatio !== undefined ? { missHitRatio: missRatio } : {}),
      ...(share !== undefined ? { cacheReadShare: share } : {}),
      sampleCount: input.sampleCount,
      recentTailTokens,
      tailExtended: false,
      reasons,
    };
  }
  if (share === undefined || missRatio === undefined || input.sampleCount < input.config.minimumCacheSampleCount) {
    return {
      eligible: false,
      ...(missRatio !== undefined ? { missHitRatio: missRatio } : {}),
      ...(share !== undefined ? { cacheReadShare: share } : {}),
      sampleCount: input.sampleCount,
      recentTailTokens,
      tailExtended: false,
      reasons,
    };
  }

  const budgetBased = Math.max(0, Math.floor(input.activeInputBudget * input.config.maxTailBudgetShare));
  const extended = Math.max(input.nominalRecentTailTokens, budgetBased);
  reasons.push(`cache-aware-tail:${extended}`);
  return {
    eligible: true,
    missHitRatio: rounded(missRatio),
    cacheReadShare: rounded(share),
    sampleCount: input.sampleCount,
    recentTailTokens: extended,
    tailExtended: extended !== input.nominalRecentTailTokens,
    reasons,
  };
}

function ratio(numerator: number | undefined, denominator: number | undefined): number | undefined {
  if (numerator === undefined || denominator === undefined) return undefined;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0 || numerator < 0) {
    return undefined;
  }
  return numerator / denominator;
}
