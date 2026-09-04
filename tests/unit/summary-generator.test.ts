import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  DEFAULT_COMPACTION_TRANSPORT_BASE_DELAY_MS,
  DEFAULT_COMPACTION_TRANSPORT_MAX_ATTEMPTS,
  generateValidatedSummary,
  type GenerateValidatedSummaryInput,
} from "../../src/pi-adapter/summary-generator.ts";
import {
  effectiveTransportPolicy,
  transportRetryDelayMs,
  type CompactionTransportRetryDiagnostic,
} from "../../src/pi-adapter/summary-generator.ts";

function usage(overrides: Partial<Record<string, number>> = {}) {
  return {
    input: 100,
    output: 100,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 200,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}

function successResponse(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "The agent completed the migration tasks." }],
    stopReason: "stop",
    usage: usage(),
    api: "openai-responses",
    provider: "test",
    model: "model-test",
    timestamp: 0,
  };
}

function errorResponse(message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: message,
    usage: usage(),
    api: "openai-responses",
    provider: "test",
    model: "model-test",
    timestamp: 0,
  };
}

function makeInput(overrides: Partial<GenerateValidatedSummaryInput> = {}): {
  input: GenerateValidatedSummaryInput;
  controller: AbortController;
  retries: CompactionTransportRetryDiagnostic[];
} {
  const controller = new AbortController();
  const retries: CompactionTransportRetryDiagnostic[] = [];
  const input: GenerateValidatedSummaryInput = {
    stage: "segment",
    prompt: "Summarize the conversation.",
    validationSource: "",
    readFiles: [],
    modifiedFiles: [],
    validate: false,
    maxSummaryTokens: 1000,
    event: { signal: controller.signal } as GenerateValidatedSummaryInput["event"],
    ctx: {
      modelRegistry: { complete: vi.fn() },
    } as unknown as GenerateValidatedSummaryInput["ctx"],
    model: {
      id: "model-test",
      api: "openai-responses",
      provider: "test",
      reasoning: false,
      input: ["text"],
      contextWindow: 32_000,
      maxTokens: 4096,
    } as GenerateValidatedSummaryInput["model"],
    now: () => 0,
    onTransportRetry: (diagnostic: CompactionTransportRetryDiagnostic) => retries.push(diagnostic),
    ...overrides,
  };
  return { input, controller, retries };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("effectiveTransportPolicy", () => {
  it("defaults to Pi's assistant retry policy", () => {
    expect(effectiveTransportPolicy(undefined)).toEqual({
      maxAttempts: DEFAULT_COMPACTION_TRANSPORT_MAX_ATTEMPTS,
      baseDelayMs: DEFAULT_COMPACTION_TRANSPORT_BASE_DELAY_MS,
    });
    expect(DEFAULT_COMPACTION_TRANSPORT_MAX_ATTEMPTS).toBe(3);
    expect(DEFAULT_COMPACTION_TRANSPORT_BASE_DELAY_MS).toBe(2000);
  });

  it("clamps attempts to [1, 10] and base delay to [0, 60000]", () => {
    expect(effectiveTransportPolicy({ maxAttempts: 0, baseDelayMs: -5 }))
      .toEqual({ maxAttempts: 1, baseDelayMs: 0 });
    expect(effectiveTransportPolicy({ maxAttempts: 99, baseDelayMs: 600_000 }))
      .toEqual({ maxAttempts: 10, baseDelayMs: 60_000 });
  });
});

describe("transportRetryDelayMs", () => {
  it("doubles the base delay per failed attempt", () => {
    expect(transportRetryDelayMs(2000, 1)).toBe(2000);
    expect(transportRetryDelayMs(2000, 2)).toBe(4000);
    expect(transportRetryDelayMs(2000, 3)).toBe(8000);
  });

  it("caps the delay at 60 seconds", () => {
    expect(transportRetryDelayMs(60_000, 4)).toBe(60_000);
  });
});

describe("generateValidatedSummary transport retry", () => {
  it("uses the default policy (3 attempts, 2000/4000 ms backoff) when transport is not configured", async () => {
    vi.useFakeTimers();
    const { input, retries } = makeInput({
      transport: undefined,
    });
    input.ctx.modelRegistry.complete = vi.fn(async () => {
      throw new Error("WebSocket error: connection reset");
    });
    const promise = generateValidatedSummary(input);
    // Pre-attach a handler so Node does not report the rejection as unhandled
    // while fake timers advance the backoff.
    promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(promise).rejects.toThrow("attempts=3");
    expect(retries.map((retry) => retry.delayMs)).toEqual([2000, 4000]);
    expect(retries.every((retry) => retry.maxAttempts === 3)).toBe(true);
  });

  it("honors a custom policy (attempts and delays)", async () => {
    const { input, retries } = makeInput({
      transport: { maxAttempts: 2, baseDelayMs: 5 },
    });
    input.ctx.modelRegistry.complete = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(generateValidatedSummary(input)).rejects.toThrow("attempts=2");
    expect(retries).toEqual([{
      stage: "segment",
      failedAttempt: 1,
      nextAttempt: 2,
      maxAttempts: 2,
      delayMs: 5,
    }]);
  });

  it("does not retry non-transport failures", async () => {
    const { input, retries } = makeInput({
      transport: { maxAttempts: 5, baseDelayMs: 0 },
    });
    input.ctx.modelRegistry.complete = vi.fn(async () => {
      throw new Error("429 rate limit exceeded");
    });
    await expect(generateValidatedSummary(input)).rejects.toThrow("category=rate-limit");
    expect(input.ctx.modelRegistry.complete).toHaveBeenCalledTimes(1);
    expect(retries).toEqual([]);
  });

  it("sums usage across retried error responses", async () => {
    const { input } = makeInput({
      transport: { maxAttempts: 3, baseDelayMs: 1 },
    });
    let calls = 0;
    input.ctx.modelRegistry.complete = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return errorResponse("socket closed");
      }
      return successResponse();
    });
    const result = await generateValidatedSummary(input);
    expect(input.ctx.modelRegistry.complete).toHaveBeenCalledTimes(2);
    expect(result.usage).toMatchObject({ input: 200, totalTokens: 400 });
  });

  it("stops retrying when the compaction is aborted during backoff", async () => {
    const { input, controller, retries } = makeInput({
      transport: { maxAttempts: 3, baseDelayMs: 1000 },
    });
    input.ctx.modelRegistry.complete = vi.fn(async () => {
      controller.abort();
      throw new Error("network timeout");
    });
    await expect(generateValidatedSummary(input)).rejects.toThrow("aborted");
    expect(input.ctx.modelRegistry.complete).toHaveBeenCalledTimes(1);
    expect(retries).toEqual([]);
  });
});
