import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "ds4-context-core/config/config";
import {
  continuationItemHashes,
  NativeContinuationManager,
  nativeContinuationProfileMatches,
  nativeContinuationProviderIds,
} from "ds4-context-core/continuation/native-continuation";

function manager(now: () => number = () => 1_000): NativeContinuationManager {
  const config = {
    ...createDefaultConfig().nativeContinuation,
    enabled: true,
    allowProviderStorage: true,
    profiles: ["openai/*", "proxy/special/model"],
  };
  const value = new NativeContinuationManager(config, now);
  value.registerProvider("openai");
  value.registerProvider("proxy");
  return value;
}

function request(payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    payload,
    provider: "openai",
    model: "gpt-test",
    requestSessionId: "session-1",
    canonicalSessionId: "session-1",
    manifestId: "manifest-1",
    branchLeafId: "leaf-1",
    managed: true,
    ...overrides,
  };
}

function payload(input: unknown[], extra: Record<string, unknown> = {}) {
  return {
    model: "gpt-test",
    input,
    tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
    stream: true,
    prompt_cache_key: "session-1",
    store: false,
    ...extra,
  };
}

describe("NativeContinuationManager", () => {
  it("matches only explicit exact or provider-wildcard profiles", () => {
    const profiles = ["openai/*", "proxy/vendor/model"];
    expect(nativeContinuationProfileMatches(profiles, "openai", "gpt-5")).toBe(true);
    expect(nativeContinuationProfileMatches(profiles, "proxy", "vendor/model")).toBe(true);
    expect(nativeContinuationProfileMatches(profiles, "proxy", "other")).toBe(false);
    expect(nativeContinuationProviderIds(profiles)).toEqual(["openai", "proxy"]);
  });

  it("establishes a stored response and sends only a verified suffix on the next call", () => {
    const value = manager();
    const initialInput = [
      { role: "developer", content: "stable system" },
      { role: "user", content: [{ type: "input_text", text: "first request" }] },
    ];
    const first = value.prepare(request(payload(initialInput)));
    expect(first.tracked).toBe(true);
    expect(first.decision).toMatchObject({
      mode: "managed-replay",
      attempted: false,
      fullInputItems: 2,
      sentInputItems: 2,
      omittedInputItems: 0,
      fallbackReason: "continuation-cold-start",
    });
    expect(first.payload).toMatchObject({ store: true, input: initialInput });
    expect(first.payload).not.toHaveProperty("previous_response_id");
    if (!first.attempt) throw new Error("Expected first continuation attempt");

    const assistantItem = {
      type: "message",
      role: "assistant",
      id: "msg_1",
      status: "completed",
      content: [{ type: "output_text", text: "first answer", annotations: [] }],
    };
    value.complete(first.attempt, "resp_private_1", continuationItemHashes([assistantItem]));

    const nextUser = { role: "user", content: [{ type: "input_text", text: "second request" }] };
    const second = value.prepare(request(payload([...initialInput, assistantItem, nextUser]), {
      manifestId: "manifest-2",
      branchLeafId: "leaf-2",
    }));
    expect(second.decision).toMatchObject({
      mode: "native-continuation",
      attempted: true,
      stateReused: true,
      fullInputItems: 4,
      sentInputItems: 1,
      omittedInputItems: 3,
    });
    expect(second.payload).toMatchObject({
      store: true,
      previous_response_id: "resp_private_1",
      input: [nextUser],
    });
    expect(JSON.stringify(value.diagnostics())).not.toContain("resp_private_1");
    expect(JSON.stringify(value.diagnostics())).not.toContain("first request");
  });

  it("invalidates state and replays the complete managed payload when the prefix or options change", () => {
    const value = manager();
    const firstInput = [{ role: "user", content: "one" }];
    const first = value.prepare(request(payload(firstInput)));
    if (!first.attempt) throw new Error("Expected first attempt");
    const assistant = { type: "message", role: "assistant", id: "msg_1", content: [] };
    value.complete(first.attempt, "resp_1", continuationItemHashes([assistant]));

    const changedPrefix = value.prepare(request(payload([
      { role: "user", content: "changed" },
      assistant,
      { role: "user", content: "two" },
    ])));
    expect(changedPrefix.decision).toMatchObject({
      mode: "managed-replay",
      fallbackReason: "managed-context-prefix-changed",
      invalidationReason: "managed-context-prefix-changed",
    });
    expect(changedPrefix.payload).not.toHaveProperty("previous_response_id");

    if (!changedPrefix.attempt) throw new Error("Expected replay attempt");
    value.complete(changedPrefix.attempt, "resp_2", continuationItemHashes([assistant]));
    const optionsChanged = value.prepare(request(payload([
      { role: "user", content: "changed" },
      assistant,
      { role: "user", content: "two" },
      assistant,
      { role: "user", content: "three" },
    ], { max_output_tokens: 123 })));
    expect(optionsChanged.decision?.fallbackReason).toBe("provider-request-options-changed");
    expect(optionsChanged.payload).not.toHaveProperty("previous_response_id");
    expect(value.diagnostics().invalidations).toBe(2);
  });

  it("expires volatile state conservatively", () => {
    let clock = 1_000;
    const config = {
      ...createDefaultConfig().nativeContinuation,
      enabled: true,
      allowProviderStorage: true,
      profiles: ["openai/*"],
      maxStateAgeMs: 10_000,
    };
    const value = new NativeContinuationManager(config, () => clock);
    value.registerProvider("openai");
    const input = [{ role: "user", content: "one" }];
    const first = value.prepare(request(payload(input)));
    if (!first.attempt) throw new Error("Expected first attempt");
    const assistant = { type: "message", role: "assistant", id: "msg_1", content: [] };
    value.complete(first.attempt, "resp_1", continuationItemHashes([assistant]));
    clock += 10_001;

    const expired = value.prepare(request(payload([
      ...input,
      assistant,
      { role: "user", content: "two" },
    ])));
    expect(expired.decision).toMatchObject({
      mode: "managed-replay",
      fallbackReason: "continuation-state-expired",
      invalidationReason: "continuation-state-expired",
      stateAgeMs: 10_001,
    });
  });

  it("does not opt nested, observer, unregistered, or externally continued requests into storage", () => {
    const value = manager();
    const original = payload([{ role: "user", content: "one" }]);

    expect(value.prepare(request(original, { requestSessionId: "nested" }))).toEqual({
      payload: original,
      tracked: false,
    });
    const rewrittenModel = { ...original, model: "rewritten-model" };
    const mismatchedModel = value.prepare(request(rewrittenModel));
    expect(mismatchedModel.payload).toBe(rewrittenModel);
    expect(mismatchedModel.decision?.fallbackReason).toBe("unsupported-provider-payload");
    expect(mismatchedModel.payload).toMatchObject({ store: false });

    const observer = value.prepare(request(original, { managed: false }));
    expect(observer.payload).toBe(original);
    expect(observer.decision).toMatchObject({
      eligible: false,
      providerStorage: "opt-in",
      fallbackReason: "managed-context-required",
    });
    expect(observer.payload).toMatchObject({ store: false });

    const external = payload([{ role: "user", content: "one" }], {
      previous_response_id: "external-id",
      store: false,
    });
    const preparedExternal = value.prepare(request(external));
    expect(preparedExternal.payload).toBe(external);
    expect(preparedExternal.decision?.mode).toBe("external-continuation");
    expect(preparedExternal.payload).toMatchObject({
      previous_response_id: "external-id",
      store: false,
    });
  });
});
