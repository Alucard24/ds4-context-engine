import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { PrivacyPolicyEngine } from "../../src/privacy/privacy-policy.ts";

function buildContract() {
  const engine = new PrivacyPolicyEngine({
    ...structuredClone(DEFAULT_CONFIG.privacy),
    enabled: true,
    localProviders: [],
    remoteDefaultAllowed: ["normal", "internal"],
    remoteProviders: { "golden-remote": ["normal", "internal"] },
  });
  const policy = engine.policy("golden-remote");
  const sanitized = engine.sanitizeProviderPayload({
    model: "golden-model",
    system: "[ds4:internal]team context[/ds4:internal]",
    messages: [{
      role: "user",
      content: "normal [ds4:local-only]private value[/ds4:local-only] sk-goldensecret123",
    }],
  }, "golden-remote");
  return {
    policy,
    payload: sanitized.value,
    classification: sanitized.classification,
    changed: sanitized.changed,
    blockedBlocks: sanitized.blockedBlocks,
    secretRedactions: sanitized.secretRedactions,
    inspectedStrings: sanitized.inspectedStrings,
  };
}

describe("privacy provider policy golden contract", () => {
  it("keeps classification, redaction, and protocol shape deterministic", () => {
    const expected = JSON.parse(
      readFileSync(join(import.meta.dirname, "privacy-provider-policy.json"), "utf8"),
    ) as unknown;
    expect(buildContract()).toEqual(expected);
  });
});
