import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "ds4-context-core/config/config";
import {
  PrivacyPolicyEngine,
  providerPrivacyPolicy,
  redactSecrets,
} from "ds4-context-core/privacy/privacy-policy";

function config(overrides: Partial<typeof DEFAULT_CONFIG.privacy> = {}) {
  return {
    ...structuredClone(DEFAULT_CONFIG.privacy),
    enabled: true,
    localProviders: ["ollama"],
    ...overrides,
  };
}

describe("privacy policy", () => {
  it("treats backslash-escaped marker syntax as literal text", () => {
    const engine = new PrivacyPolicyEngine(config());
    const value = String.raw`\[ds4:local-only]documentation example\[/ds4:local-only]`;
    const result = engine.sanitizeText(value, "openai");

    expect(result.value).toBe(value);
    expect(result.classification).toBe("normal");
    expect(result.blockedBlocks).toBe(0);
  });

  it("blocks classified spans for remote providers and strips allowed markers", () => {
    const engine = new PrivacyPolicyEngine(config());
    const result = engine.sanitizeText(
      "public [ds4:internal]team[/ds4:internal] [ds4:local-only]vault-value[/ds4:local-only]",
      "anthropic",
    );

    expect(result.value).toContain("public team");
    expect(result.value).toContain("local-only content excluded");
    expect(result.value).not.toContain("vault-value");
    expect(result.classification).toBe("local-only");
    expect(result.blockedBlocks).toBe(1);
  });

  it("retains classified content for explicitly local providers", () => {
    const engine = new PrivacyPolicyEngine(config());
    const result = engine.sanitizeText(
      "[ds4:local-only]local model evidence[/ds4:local-only]",
      "ollama",
    );

    expect(result.value).toBe("local model evidence");
    expect(result.blockedBlocks).toBe(0);
    expect(result.changed).toBe(true);
  });

  it("fails closed for nested markers that could otherwise downgrade an inner span", () => {
    const engine = new PrivacyPolicyEngine(config());
    const result = engine.sanitizeMessage({
      role: "user",
      content: "[ds4:internal]allowed [ds4:local-only]NESTED-SECRET[/ds4:local-only][/ds4:internal]",
    }, "openai");

    expect(JSON.stringify(result.value)).not.toContain("NESTED-SECRET");
    expect(result.classification).toBe("local-only");
  });

  it("fails closed when classification markers are split across content blocks", () => {
    const engine = new PrivacyPolicyEngine(config());
    const result = engine.sanitizeMessage({
      role: "toolResult",
      content: [
        { type: "text", text: "[ds4:local-only]" },
        { type: "text", text: "SPLIT-MARKER-SECRET" },
        { type: "text", text: "[/ds4:local-only]" },
      ],
    }, "openai");

    expect(JSON.stringify(result.value)).not.toContain("SPLIT-MARKER-SECRET");
    expect(result.classification).toBe("local-only");
  });

  it("redacts dynamic object keys when an entire content object is prohibited", () => {
    const engine = new PrivacyPolicyEngine(config());
    const result = engine.sanitizeMessage({
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "call-1",
        name: "tool",
        arguments: { "DYNAMIC-LOCAL-KEY": "DYNAMIC-LOCAL-VALUE" },
      }],
    }, "openai", "local-only");

    expect(JSON.stringify(result.value)).not.toContain("DYNAMIC-LOCAL-KEY");
    expect(JSON.stringify(result.value)).not.toContain("DYNAMIC-LOCAL-VALUE");
    expect(JSON.stringify(result.value)).toContain("call-1");
  });

  it("does not let nested markers downgrade an explicit classification", () => {
    const engine = new PrivacyPolicyEngine(config());
    const result = engine.sanitizeMessage(
      { role: "user", content: "[ds4:normal]attempted downgrade[/ds4:normal]" },
      "openai",
      "local-only",
    );

    expect(result.value.content).not.toContain("attempted downgrade");
    expect(result.classification).toBe("local-only");
  });

  it("applies default classification and provider-specific allow rules", () => {
    const blocked = new PrivacyPolicyEngine(config({ defaultClassification: "sensitive" }));
    expect(blocked.sanitizeText("confidential", "openai").value).not.toContain("confidential");

    const allowedConfig = config({
      defaultClassification: "sensitive",
      remoteProviders: { openai: ["normal", "internal", "sensitive"] },
    });
    const allowed = new PrivacyPolicyEngine(allowedConfig);
    expect(allowed.sanitizeText("confidential", "openai").value).toBe("confidential");
    expect(providerPrivacyPolicy(allowedConfig, "openai").destination).toBe("remote");
  });

  it("sanitizes provider content while retaining protocol identifiers", () => {
    const engine = new PrivacyPolicyEngine(config());
    const payload = {
      model: "remote-model",
      messages: [{
        role: "user",
        content: "normal [ds4:local-only]DO-NOT-SEND[/ds4:local-only] sk-secret123456",
      }],
      tools: [{
        name: "read",
        description: "[ds4:sensitive]private tool notes[/ds4:sensitive]",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      }],
    };
    const result = engine.sanitizeProviderPayload(payload, "openai");

    expect(result.value.model).toBe("remote-model");
    expect(result.value.messages[0]?.role).toBe("user");
    expect(result.value.messages[0]?.content).not.toContain("DO-NOT-SEND");
    expect(result.value.messages[0]?.content).not.toContain("secret123456");
    expect(result.value.tools[0]?.name).toBe("read");
    expect(result.value.tools[0]?.description).not.toContain("private tool notes");
    expect(result.blockedBlocks).toBe(2);
    expect(result.secretRedactions).toBe(1);
  });

  it("redacts common credentials without recording their values", () => {
    const source = [
      "Authorization: Bearer abcdefghijklmnop",
      "api_key=super-secret-value",
      "ghp_abcdefghijklmnopqrstuvwxyz",
      "-----BEGIN PRIVATE KEY-----\nraw-private-material\n-----END PRIVATE KEY-----",
    ].join("\n");
    const result = redactSecrets(source);

    expect(result.count).toBeGreaterThanOrEqual(4);
    expect(result.value).not.toContain("abcdefghijklmnop");
    expect(result.value).not.toContain("super-secret-value");
    expect(result.value).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(result.value).not.toContain("raw-private-material");
  });

  it("preserves cyclic payload structure without leaking marked content", () => {
    const payload: Record<string, unknown> = { input: "[ds4:local-only]cycle-secret[/ds4:local-only]" };
    payload.self = payload;
    const result = new PrivacyPolicyEngine(config()).sanitizeProviderPayload(payload, "unknown-remote");

    expect(result.value.self).toBe(result.value);
    expect(String(result.value.input)).not.toContain("cycle-secret");
  });
});
