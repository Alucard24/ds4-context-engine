import { bench, describe } from "vitest";
import {
  LocalKvReuseController,
  deriveLocalKvEligibility,
  type LocalKvCompletionInput,
  type LocalKvRuntimePort,
} from "ds4-context-core/adapter/local-kv";

const CONTEXT_OCCUPANCY_TOKENS = 40_000;
const REUSABLE_PREFIX_TOKENS = 32_000;
const prefix = Array.from({ length: 2_000 }, (_, index) =>
  `message:${index}:${"x".repeat(96)}`).join("\n");
const input: LocalKvCompletionInput = {
  enabled: true,
  capabilityEnabled: true,
  capabilityVersion: "benchmark-kv-v1",
  destination: "local",
  runtimeId: "benchmark-runtime",
  runtimeRevision: "runtime-build-1",
  provider: "ollama",
  model: "benchmark-model",
  modelRevision: "model-checksum-1",
  privacyPolicyVersion: "privacy-policy-1",
  promptPrefix: prefix,
  systemOptions: { seed: 1, temperature: 0 },
  toolOptions: Array.from({ length: 20 }, (_, index) => ({ name: `tool-${index}`, schema: "v1" })),
  prefixTokenCount: REUSABLE_PREFIX_TOKENS,
  contextTokenCount: CONTEXT_OCCUPANCY_TOKENS,
  payload: { prefix, suffix: "current request" },
};
const port: LocalKvRuntimePort = {
  async tryReuse() {
    return {
      status: "hit",
      output: "ok",
      savedPrefillTokens: REUSABLE_PREFIX_TOKENS,
      prefillLatencyMs: 0.5,
    };
  },
  async fullReplay() {
    return {
      output: "ok",
      prefillTokens: CONTEXT_OCCUPANCY_TOKENS,
      prefillLatencyMs: 18,
    };
  },
};
const controller = new LocalKvReuseController();

describe("local KV eligibility performance", () => {
  bench("hash exact 32k-token prefix independently of 40k-token context occupancy", () => {
    deriveLocalKvEligibility(input);
  }, { time: 1_000 });

  bench("complete warm reuse reporting 32k saved prefill tokens and 0.5ms runtime prefill", async () => {
    await controller.complete(input, port);
  }, { time: 1_000 });
});
