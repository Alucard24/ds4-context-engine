import { createTokenEstimator, type TokenEstimator } from "./token-estimator.ts";

/** Keep the portable core independent of any BPE implementation or agent runtime. */
export function createO200kEstimator(countText: (text: string) => number): TokenEstimator {
  return createTokenEstimator("o200k-base-v1", countText);
}
