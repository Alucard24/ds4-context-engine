import { createRequire } from "node:module";
import type { Tiktoken } from "js-tiktoken/lite";
import { createO200kEstimator } from "ds4-context-core/core/bpe-token-estimator";

const load = createRequire(import.meta.url);

let encoder: Tiktoken | undefined;

/**
 * Opt-in OpenAI o200k text estimator. Model-specific serializers, image tokens,
 * reasoning, and provider-specific wrappers are still estimated, not exact.
 * No remote vocabulary download or provider request is performed.
 */
export const O200K_ESTIMATOR = createO200kEstimator((text) => {
  if (!encoder) {
    // CJS exports are loaded on first opt-in use, not for every Pi session.
    const { Tiktoken: Encoder } = load("js-tiktoken/lite") as typeof import("js-tiktoken/lite");
    const ranks = load("js-tiktoken/ranks/o200k_base") as {
      pat_str: string; special_tokens: Record<string, number>; bpe_ranks: string;
    };
    encoder = new Encoder(ranks);
  }
  return encoder.encode(text).length;
});
