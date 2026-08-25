import { bench, describe } from "vitest";
import { DEFAULT_CONFIG } from "ds4-context-core/config/config";
import { PrivacyPolicyEngine } from "ds4-context-core/privacy/privacy-policy";

const engine = new PrivacyPolicyEngine({
  ...structuredClone(DEFAULT_CONFIG.privacy),
  enabled: true,
  localProviders: [],
});
const payload = {
  model: "benchmark-model",
  system: "Stable system prompt",
  messages: Array.from({ length: 1_000 }, (_, index) => ({
    role: index % 3 === 0 ? "assistant" : "user",
    content: index % 100 === 0
      ? `normal ${index} [ds4:local-only]private-${index}[/ds4:local-only]`
      : `ordinary context message ${index} with deterministic payload`,
  })),
  tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
};

describe("privacy policy performance", () => {
  bench("sanitize 1000-message provider payload", () => {
    engine.sanitizeProviderPayload(payload, "remote-benchmark");
  }, { time: 1_000 });
});
