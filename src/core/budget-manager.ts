import type { ContextConfig } from "../config/config.ts";
import type { ModelProfile } from "./model-profile.ts";

export interface ContextBudget {
  contextWindow: number;
  outputReserve: number;
  safetyMargin: number;
  modelInputHardLimit: number;
  hardInputLimit: number;
  softInputLimit: number;
  preferredInputTarget: number;
  activeInputBudget: number;
}

export function calculateContextBudget(profile: ModelProfile, config: ContextConfig): ContextBudget {
  const outputCeiling = profile.maxOutputTokens ?? config.preferredOutputReserve;
  const preferredReserve = Math.min(config.preferredOutputReserve, outputCeiling);
  const minimumReserve = Math.min(config.minimumOutputReserve, outputCeiling);
  const outputReserve = Math.max(minimumReserve, preferredReserve);
  const safetyMargin = Math.min(profile.safetyMarginTokens, Math.max(0, profile.contextWindow - outputReserve));

  const modelInputHardLimit = Math.max(0, profile.contextWindow - outputReserve - safetyMargin);
  const policyHardLimit = Math.floor(profile.contextWindow * config.hardLimitRatio);
  const hardInputLimit = Math.min(modelInputHardLimit, policyHardLimit);
  const softInputLimit = Math.min(hardInputLimit, Math.floor(profile.contextWindow * config.softLimitRatio));
  const preferredInputTarget = Math.floor(profile.contextWindow * config.targetFillRatio);
  const activeInputBudget = Math.min(hardInputLimit, preferredInputTarget);

  return {
    contextWindow: profile.contextWindow,
    outputReserve,
    safetyMargin,
    modelInputHardLimit,
    hardInputLimit,
    softInputLimit,
    preferredInputTarget,
    activeInputBudget,
  };
}
