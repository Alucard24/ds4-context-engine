import type { ContextConfig } from "../config/config.ts";
import type { ModelProfile } from "./model-profile.ts";

export interface ContextBudget {
  contextWindow: number;
  outputReserve: number;
  safetyMargin: number;
  /** Provider-token capacity before estimator calibration. */
  modelInputHardLimit: number;
  nominalHardInputLimit?: number;
  nominalSoftInputLimit?: number;
  nominalPreferredInputTarget?: number;
  /** Limits below are expressed in local estimator units. */
  hardInputLimit: number;
  softInputLimit: number;
  preferredInputTarget: number;
  activeInputBudget: number;
  calibrationRatio?: number;
  calibrationSamples?: number;
}

export interface BudgetCalibration {
  appliedRatio: number;
  acceptedSamples: number;
  calibrated: boolean;
}

function estimatorLimit(providerTokens: number, ratio: number): number {
  if (providerTokens <= 0) return 0;
  return Math.max(0, Math.floor(providerTokens / ratio));
}

export function calculateContextBudget(
  profile: ModelProfile,
  config: ContextConfig,
  calibration?: BudgetCalibration,
): ContextBudget {
  const outputCeiling = profile.maxOutputTokens ?? config.preferredOutputReserve;
  const preferredReserve = Math.min(config.preferredOutputReserve, outputCeiling);
  const minimumReserve = Math.min(config.minimumOutputReserve, outputCeiling);
  const outputReserve = Math.max(minimumReserve, preferredReserve);
  const safetyMargin = Math.min(profile.safetyMarginTokens, Math.max(0, profile.contextWindow - outputReserve));

  const modelInputHardLimit = Math.max(0, profile.contextWindow - outputReserve - safetyMargin);
  const policyHardLimit = Math.floor(profile.contextWindow * config.hardLimitRatio);
  const nominalHardInputLimit = Math.min(modelInputHardLimit, policyHardLimit);
  const nominalSoftInputLimit = Math.min(
    nominalHardInputLimit,
    Math.floor(profile.contextWindow * config.softLimitRatio),
  );
  const nominalPreferredInputTarget = Math.floor(profile.contextWindow * config.targetFillRatio);
  const calibrationRatio = calibration?.calibrated
    && Number.isFinite(calibration.appliedRatio)
    && calibration.appliedRatio > 0
    ? calibration.appliedRatio
    : 1;
  const hardInputLimit = estimatorLimit(nominalHardInputLimit, calibrationRatio);
  const softInputLimit = Math.min(
    hardInputLimit,
    estimatorLimit(nominalSoftInputLimit, calibrationRatio),
  );
  const preferredInputTarget = estimatorLimit(nominalPreferredInputTarget, calibrationRatio);
  const activeInputBudget = Math.min(hardInputLimit, preferredInputTarget);

  return {
    contextWindow: profile.contextWindow,
    outputReserve,
    safetyMargin,
    modelInputHardLimit,
    nominalHardInputLimit,
    nominalSoftInputLimit,
    nominalPreferredInputTarget,
    hardInputLimit,
    softInputLimit,
    preferredInputTarget,
    activeInputBudget,
    calibrationRatio,
    calibrationSamples: calibration?.acceptedSamples ?? 0,
  };
}
