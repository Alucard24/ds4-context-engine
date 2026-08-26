import {
  LOCAL_KV_DIAGNOSTICS_VERSION,
  LocalKvReuseController,
  deriveLocalKvEligibility,
  type LocalKvCompletionInput,
  type LocalKvRuntimePort,
  type LocalKvRuntimeRequest,
} from "ds4-context-core/adapter/local-kv";
import { describe, expect, it } from "vitest";

function request(overrides: Partial<LocalKvCompletionInput> = {}): LocalKvCompletionInput {
  return {
    enabled: true,
    capabilityEnabled: true,
    capabilityVersion: "llama-kv-v1",
    destination: "local",
    runtimeId: "local-test-runtime",
    runtimeRevision: "runtime-build-1",
    provider: "ollama",
    model: "codestral:latest",
    modelRevision: "sha256-model-a",
    privacyPolicyVersion: "privacy-policy-a",
    promptPrefix: "system\0tools\0stable-prefix",
    systemOptions: { temperature: 0, seed: 7 },
    toolOptions: [{ name: "read", schema: { type: "object" } }],
    prefixTokenCount: 120,
    contextTokenCount: 160,
    payload: { prompt: "sanitized-provider-payload" },
    ...overrides,
  };
}

class VolatileKvPort implements LocalKvRuntimePort {
  readonly cached = new Set<string>();
  reuseCalls = 0;
  fullReplayCalls = 0;
  nextStatus?: "rejected" | "unavailable" | "throw";

  async tryReuse(input: LocalKvRuntimeRequest) {
    this.reuseCalls += 1;
    const status = this.nextStatus;
    this.nextStatus = undefined;
    if (status === "throw") throw new Error("runtime restarted");
    if (status) return { status } as const;
    if (!this.cached.has(input.eligibility.fingerprint)) return { status: "miss" as const };
    return {
      status: "hit" as const,
      output: { mode: "cached" },
      savedPrefillTokens: input.prefixTokenCount,
      prefillLatencyMs: 0.25,
    };
  }

  async fullReplay(input: LocalKvRuntimeRequest) {
    this.fullReplayCalls += 1;
    this.cached.add(input.eligibility.fingerprint);
    return {
      output: { mode: "full" },
      prefillTokens: input.contextTokenCount,
      prefillLatencyMs: 8.5,
    };
  }
}

describe("local KV eligibility", () => {
  it("is byte-stable and invalidates every provider, model, option, privacy, and runtime change", () => {
    const baseline = deriveLocalKvEligibility(request());
    expect(baseline.eligible).toBe(true);
    if (!baseline.eligible) throw new Error("expected eligible baseline");
    expect(deriveLocalKvEligibility(request())).toEqual(baseline);
    expect(deriveLocalKvEligibility(request({
      systemOptions: { seed: 7, temperature: 0 },
    }))).toEqual(baseline);

    const changed = [
      request({ promptPrefix: "system\0tools\0stable-prefiy" }),
      request({ provider: "llama-cpp" }),
      request({ model: "codestral:22b" }),
      request({ modelRevision: "sha256-model-b" }),
      request({ systemOptions: { temperature: 0, seed: 8 } }),
      request({ toolOptions: [{ name: "read", schema: { type: "string" } }] }),
      request({ privacyPolicyVersion: "privacy-policy-b" }),
      request({ runtimeRevision: "runtime-build-2" }),
      request({ capabilityVersion: "llama-kv-v2" }),
    ];
    for (const candidate of changed) {
      const eligibility = deriveLocalKvEligibility(candidate);
      expect(eligibility.eligible).toBe(true);
      if (eligibility.eligible) expect(eligibility.key.fingerprint).not.toBe(baseline.key.fingerprint);
    }
  });

  it("rejects remote, disabled, malformed, or unserializable requests", () => {
    expect(deriveLocalKvEligibility(request({ enabled: false }))).toEqual({
      eligible: false,
      reason: "disabled",
    });
    expect(deriveLocalKvEligibility(request({ destination: "remote" }))).toEqual({
      eligible: false,
      reason: "non-local-destination",
    });
    expect(deriveLocalKvEligibility(request({ prefixTokenCount: 200 }))).toEqual({
      eligible: false,
      reason: "invalid-token-count",
    });
    expect(deriveLocalKvEligibility(request({ toolOptions: { callback: () => undefined } }))).toEqual({
      eligible: false,
      reason: "invalid-options",
    });
  });
});

describe("LocalKvReuseController", () => {
  it("bypasses the runtime port when configuration or capability is disabled", async () => {
    const controller = new LocalKvReuseController();
    const port = new VolatileKvPort();

    await expect(controller.complete(request({ enabled: false }), port)).resolves.toEqual({
      status: "ineligible",
      reason: "disabled",
    });
    await expect(controller.complete(request({ capabilityEnabled: false }), port)).resolves.toEqual({
      status: "ineligible",
      reason: "capability-unsupported",
    });
    expect(port.reuseCalls).toBe(0);
    expect(port.fullReplayCalls).toBe(0);
    expect(controller.diagnostics()).toMatchObject({ requests: 2, bypassedRequests: 2 });
  });

  it("reuses only an identical eligible prefix and fully replays changed bytes or options", async () => {
    const controller = new LocalKvReuseController();
    const port = new VolatileKvPort();

    const cold = await controller.complete(request(), port);
    const warm = await controller.complete(request(), port);
    const changedByte = await controller.complete(request({ promptPrefix: "system\0tools\0changed-prefix" }), port);
    const changedOption = await controller.complete(request({ systemOptions: { temperature: 0.1, seed: 7 } }), port);

    expect(cold).toMatchObject({ status: "completed", metadata: { mode: "full-replay" } });
    expect(warm).toMatchObject({
      status: "completed",
      metadata: { mode: "hit", savedPrefillTokens: 120, contextTokens: 160 },
    });
    expect(changedByte).toMatchObject({ status: "completed", metadata: { mode: "full-replay" } });
    expect(changedOption).toMatchObject({ status: "completed", metadata: { mode: "full-replay" } });
    expect(port.fullReplayCalls).toBe(3);
    expect(controller.diagnostics()).toMatchObject({
      version: LOCAL_KV_DIAGNOSTICS_VERSION,
      requests: 4,
      eligibleRequests: 4,
      hits: 1,
      misses: 3,
      fullReplays: 3,
      savedPrefillTokens: 120,
      replayPrefillTokens: 480,
      contextTokens: 640,
    });
  });

  it("turns cache loss, stale rejection, and runtime unavailability into transparent full replay", async () => {
    const controller = new LocalKvReuseController();
    const port = new VolatileKvPort();
    await controller.complete(request(), port);

    port.nextStatus = "rejected";
    const stale = await controller.complete(request(), port);
    port.cached.clear();
    const lost = await controller.complete(request(), port);
    port.nextStatus = "throw";
    const restarted = await controller.complete(request({ runtimeRevision: "runtime-build-2" }), port);

    expect(stale).toMatchObject({ status: "completed", metadata: { mode: "full-replay" } });
    expect(lost).toMatchObject({ status: "completed", metadata: { mode: "full-replay" } });
    expect(restarted).toMatchObject({ status: "completed", metadata: { mode: "full-replay" } });
    expect(controller.diagnostics()).toMatchObject({
      rejected: 1,
      misses: 2,
      unavailable: 1,
      fullReplays: 4,
      transportFailures: 0,
    });
  });

  it("keeps diagnostics aggregate-only and never exposes payloads, fingerprints, or handles", async () => {
    const controller = new LocalKvReuseController();
    const port = new VolatileKvPort();
    await controller.complete(request({
      promptPrefix: "DS4_PRIVATE_PREFIX",
      payload: { secret: "DS4_PRIVATE_PAYLOAD", handle: "native-handle-42" },
    }), port);
    await controller.complete(request({
      promptPrefix: "DS4_PRIVATE_PREFIX",
      payload: { secret: "DS4_PRIVATE_PAYLOAD", handle: "native-handle-42" },
    }), port);

    const serialized = JSON.stringify(controller.diagnostics());
    expect(serialized).not.toContain("DS4_PRIVATE");
    expect(serialized).not.toContain("native-handle");
    expect(serialized).not.toContain([...port.cached][0]!);
    expect(Object.values(controller.diagnostics()).every((value) =>
      typeof value === "number" || typeof value === "string")).toBe(true);
  });
});
