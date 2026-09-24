import type {
  ContextConfig,
  ModelAwarenessConfig,
  ModelProfileOverride,
  TokenEstimatorVersion,
} from "../config/config.ts";
import { calculateContextBudget } from "./budget-manager.ts";
import {
  createModelProfile,
  type ModelDescriptor,
  type ModelProfile,
} from "./model-profile.ts";

export interface TokenCalibrationSample {
  estimatedTokens: number;
  actualInputTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  createdAt: number;
}

export interface ProviderCacheMetrics {
  sampleCount: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalInputTokens: number;
  cacheReadShare: number;
  cacheWriteShare: number;
}

export interface ModelCalibrationAnalysis {
  enabled: boolean;
  estimator: TokenEstimatorVersion;
  windowSize: number;
  observedSamples: number;
  boundedSamples: number;
  acceptedSamples: number;
  rejectedSamples: number;
  outlierSamples: number;
  /** Valid observations outside configured ratio bounds (when nonzero). */
  hardBoundSamples?: number;
  minimumSamples: number;
  lowerRatioBound: number;
  upperRatioBound: number;
  medianRatio?: number;
  appliedRatio: number;
  calibrated: boolean;
  cache: ProviderCacheMetrics;
}

export interface AdaptiveModelLimits {
  nominalRecentTailTokens: number;
  nominalRetrievedHistoryTokens: number;
  nominalProjectTokens: number;
  recentTailTokens: number;
  maxRetrievedHistoryTokens: number;
  maxProjectTokens: number;
}

export interface TokenDriftWarning {
  code: "persistent-underestimate" | "persistent-overestimate" | "calibration-outliers";
  severity: "warning" | "critical";
  sampleCount: number;
  medianRatio?: number;
}

export interface AutoTuneDecision {
  status: "disabled" | "insufficient-samples" | "no-headroom" | "expanded";
  acceptedSamples: number;
  highWatermarkRatio?: number;
  boostFactor: number;
}

export interface ResolvedModelAwareness {
  profileKey: string;
  profile: ModelProfile;
  overrideKeys: string[];
  calibration: ModelCalibrationAnalysis;
  drift?: TokenDriftWarning;
  autoTune?: AutoTuneDecision;
  limits: AdaptiveModelLimits;
  contextConfig: ContextConfig;
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const current = sorted[middle];
  if (current === undefined) return undefined;
  if (sorted.length % 2 === 1) return current;
  const previous = sorted[middle - 1];
  return previous === undefined ? current : (previous + current) / 2;
}

function safeTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validSample(sample: TokenCalibrationSample): boolean {
  return Number.isSafeInteger(sample.estimatedTokens)
    && sample.estimatedTokens > 0
    && Number.isSafeInteger(sample.actualInputTokens)
    && sample.actualInputTokens > 0
    && safeTokenCount(sample.inputTokens)
    && safeTokenCount(sample.cacheReadTokens)
    && safeTokenCount(sample.cacheWriteTokens)
    && Number.isSafeInteger(sample.createdAt)
    && sample.createdAt >= 0;
}

function cacheMetrics(samples: readonly TokenCalibrationSample[]): ProviderCacheMetrics {
  const inputTokens = samples.reduce((total, sample) => total + sample.inputTokens, 0);
  const cacheReadTokens = samples.reduce((total, sample) => total + sample.cacheReadTokens, 0);
  const cacheWriteTokens = samples.reduce((total, sample) => total + sample.cacheWriteTokens, 0);
  const totalInputTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  return {
    sampleCount: samples.length,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalInputTokens,
    cacheReadShare: totalInputTokens > 0 ? rounded(cacheReadTokens / totalInputTokens) : 0,
    cacheWriteShare: totalInputTokens > 0 ? rounded(cacheWriteTokens / totalInputTokens) : 0,
  };
}

export function analyzeModelCalibration(
  samples: readonly TokenCalibrationSample[],
  config: ModelAwarenessConfig,
  estimator: TokenEstimatorVersion = "chars-v1",
): ModelCalibrationAnalysis {
  const window = samples.slice(0, config.calibrationWindow);
  const valid = window.filter(validSample);
  const ratios = valid.map((sample) => ({
    sample,
    ratio: sample.actualInputTokens / sample.estimatedTokens,
  }));
  const bounded = ratios.filter(({ ratio }) =>
    Number.isFinite(ratio)
    && ratio >= config.calibrationRatioLowerBound
    && ratio <= config.calibrationRatioUpperBound
  );
  const center = median(bounded.map(({ ratio }) => ratio));
  const absoluteDeviations = center === undefined
    ? []
    : bounded.map(({ ratio }) => Math.abs(ratio - center));
  const mad = median(absoluteDeviations) ?? 0;
  const tolerance = center === undefined
    ? 0
    : Math.max(0.05, center * 0.1, mad * 3 * 1.4826);
  const accepted = center === undefined
    ? []
    : bounded.filter(({ ratio }) => Math.abs(ratio - center) <= tolerance);
  const acceptedMedian = median(accepted.map(({ ratio }) => ratio));
  const calibrated = config.enabled
    && acceptedMedian !== undefined
    && accepted.length >= config.minimumCalibrationSamples;
  const appliedRatio = calibrated
    ? Math.min(
        config.calibrationRatioUpperBound,
        Math.max(config.calibrationRatioLowerBound, acceptedMedian),
      )
    : 1;

  return {
    enabled: config.enabled,
    estimator,
    windowSize: config.calibrationWindow,
    observedSamples: window.length,
    boundedSamples: bounded.length,
    acceptedSamples: accepted.length,
    rejectedSamples: window.length - accepted.length,
    outlierSamples: bounded.length - accepted.length,
    ...(valid.length > bounded.length ? { hardBoundSamples: valid.length - bounded.length } : {}),
    minimumSamples: config.minimumCalibrationSamples,
    lowerRatioBound: config.calibrationRatioLowerBound,
    upperRatioBound: config.calibrationRatioUpperBound,
    ...(acceptedMedian !== undefined ? { medianRatio: rounded(acceptedMedian) } : {}),
    appliedRatio: rounded(appliedRatio),
    calibrated,
    cache: cacheMetrics(valid),
  };
}

export function modelProfileKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

function matchingOverrides(
  provider: string,
  modelId: string,
  overrides: Readonly<Record<string, ModelProfileOverride>>,
): { override: ModelProfileOverride; keys: string[] } {
  const keys = ["*", `${provider}/*`, modelProfileKey(provider, modelId)]
    .filter((key) => overrides[key] !== undefined);
  const override = keys.reduce<ModelProfileOverride>(
    (merged, key) => ({ ...merged, ...overrides[key] }),
    {},
  );
  return { override, keys };
}

export function automaticRecentTailCeiling(contextWindow: number): number {
  return contextWindow <= 40_000
    ? 12_000
    : contextWindow <= 131_072
      ? 24_000
      : contextWindow <= 262_144
        ? 32_000
        : 64_000;
}

export function automaticHistoryRetrievalCeiling(contextWindow: number): number {
  return contextWindow <= 40_000
    ? 4_000
    : contextWindow <= 131_072
      ? 8_000
      : contextWindow <= 262_144
        ? 16_000
        : 32_000;
}

export function automaticProjectRetrievalCeiling(contextWindow: number): number {
  return contextWindow <= 40_000
    ? 4_000
    : contextWindow <= 131_072
      ? 12_000
      : contextWindow <= 262_144
        ? 20_000
        : 32_000;
}

export function tokenEstimatorVersion(model: ModelDescriptor, config: ModelAwarenessConfig): TokenEstimatorVersion {
  if (!config.enabled) return "chars-v1";
  return matchingOverrides(model.provider, model.id, config.overrides).override.tokenEstimator ?? "chars-v1";
}

/** Warn only on persistent evidence; never flag a single noisy provider response. */
export function detectTokenDrift(calibration: ModelCalibrationAnalysis): TokenDriftWarning | undefined {
  if (!calibration.enabled) return undefined;
  const outlierCount = calibration.outlierSamples + (calibration.hardBoundSamples ?? 0);
  if (calibration.calibrated && calibration.medianRatio !== undefined) {
    const ratio = calibration.medianRatio;
    if (ratio >= 1.25) return {
      code: "persistent-underestimate",
      severity: ratio >= 1.6 ? "critical" : "warning",
      sampleCount: calibration.acceptedSamples,
      medianRatio: ratio,
    };
    if (ratio <= 0.8) return {
      code: "persistent-overestimate",
      severity: ratio <= 0.625 ? "critical" : "warning",
      sampleCount: calibration.acceptedSamples,
      medianRatio: ratio,
    };
  }
  return outlierCount >= calibration.minimumSamples
    ? { code: "calibration-outliers", severity: "warning", sampleCount: outlierCount }
    : undefined;
}

function decideAutoTune(
  samples: readonly TokenCalibrationSample[],
  calibration: ModelCalibrationAnalysis,
  config: ModelAwarenessConfig,
  profile: ModelProfile,
  context: ContextConfig,
): AutoTuneDecision {
  if (!config.enabled || config.autoTune !== true) return { status: "disabled", acceptedSamples: 0, boostFactor: 1 };
  // Ratio outliers are excluded from calibration, but their provider-reported
  // occupancy still matters: ignoring a near-limit call would make an expansion unsafe.
  const observed = samples.slice(0, config.calibrationWindow).filter(validSample);
  const count = calibration.acceptedSamples;
  if (!calibration.calibrated || count < 8) {
    return { status: "insufficient-samples", acceptedSamples: count, boostFactor: 1 };
  }
  const budget = calculateContextBudget(profile, context);
  const target = Math.min(budget.preferredInputTarget, budget.hardInputLimit);
  const highWatermark = Math.max(...observed.map((sample) => sample.actualInputTokens));
  const rawRatio = target > 0 ? highWatermark / target : Number.POSITIVE_INFINITY;
  const expanded = rawRatio <= 0.6;
  return {
    status: expanded ? "expanded" : "no-headroom",
    acceptedSamples: count,
    ...(Number.isFinite(rawRatio) ? { highWatermarkRatio: rounded(rawRatio) } : {}),
    boostFactor: expanded ? 1.125 : 1,
  };
}

function calibratedLimit(value: number, calibrationRatio: number): number {
  if (value <= 0) return 0;
  return Math.max(1, Math.floor(value / Math.max(0.000001, calibrationRatio)));
}

export function resolveModelAwareness(
  model: ModelDescriptor,
  context: ContextConfig,
  config: ModelAwarenessConfig,
  samples: readonly TokenCalibrationSample[] = [],
): ResolvedModelAwareness {
  const { override, keys } = matchingOverrides(
    model.provider,
    model.id,
    config.enabled ? config.overrides : {},
  );
  const profile = createModelProfile(model, {
    ...(override.contextWindow !== undefined ? { contextWindow: override.contextWindow } : {}),
    ...(override.maxOutputTokens !== undefined ? { maxOutputTokens: override.maxOutputTokens } : {}),
    ...(override.safetyMarginTokens !== undefined ? { safetyMarginTokens: override.safetyMarginTokens } : {}),
  });
  const calibration = analyzeModelCalibration(samples, config, tokenEstimatorVersion(model, config));
  const drift = detectTokenDrift(calibration);
  const autoTune = decideAutoTune(samples, calibration, config, profile, context);
  const boosted = (nominal: number, cap: number, explicit: number | undefined): number =>
    explicit === undefined && autoTune.status === "expanded"
      ? Math.min(cap, Math.floor(nominal * autoTune.boostFactor))
      : nominal;
  const nominalRecentTailTokens = override.recentTailTokens
    ?? Math.min(context.recentTailTokens, automaticRecentTailCeiling(profile.contextWindow));
  const nominalRetrievedHistoryTokens = override.maxRetrievedHistoryTokens
    ?? (config.enabled
      ? Math.min(
          context.maxRetrievedHistoryTokens,
          automaticHistoryRetrievalCeiling(profile.contextWindow),
        )
      : context.maxRetrievedHistoryTokens);
  const nominalProjectTokens = override.maxProjectTokens
    ?? (config.enabled
      ? Math.min(context.maxProjectTokens, automaticProjectRetrievalCeiling(profile.contextWindow))
      : context.maxProjectTokens);
  // Calibration can expand estimator-unit ceilings on overestimation, but
  // configured context maxima remain hard caps after that conversion.
  const recentTailTokens = Math.min(context.recentTailTokens, calibratedLimit(
    boosted(nominalRecentTailTokens, context.recentTailTokens, override.recentTailTokens),
    calibration.appliedRatio,
  ));
  const maxRetrievedHistoryTokens = Math.min(context.maxRetrievedHistoryTokens, calibratedLimit(
    boosted(nominalRetrievedHistoryTokens, context.maxRetrievedHistoryTokens, override.maxRetrievedHistoryTokens),
    calibration.appliedRatio,
  ));
  const maxProjectTokens = Math.min(context.maxProjectTokens, calibratedLimit(
    boosted(nominalProjectTokens, context.maxProjectTokens, override.maxProjectTokens),
    calibration.appliedRatio,
  ));
  const contextConfig: ContextConfig = {
    ...context,
    recentTailTokens,
    maxRetrievedHistoryTokens,
    maxProjectTokens,
  };

  return {
    profileKey: modelProfileKey(model.provider, model.id),
    profile,
    overrideKeys: keys,
    calibration,
    ...(drift ? { drift } : {}),
    ...(config.autoTune === true ? { autoTune } : {}),
    limits: {
      nominalRecentTailTokens,
      nominalRetrievedHistoryTokens,
      nominalProjectTokens,
      recentTailTokens,
      maxRetrievedHistoryTokens,
      maxProjectTokens,
    },
    contextConfig,
  };
}
