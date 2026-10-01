import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { REQUIRED_SUMMARY_SECTIONS } from "ds4-context-core/compaction/summary-contract";
import { CompactionProviderError } from "../../src/pi-adapter/compaction-provider-error.ts";
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
    expect(DEFAULT_COMPACTION_TRANSPORT_MAX_ATTEMPTS).toBe(4);
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
  it("attributes output-limit failure to the bounded generation stage without retrying", async () => {
    for (const stage of ["segment", "aggregate", "update"] as const) {
      const { input, retries } = makeInput({ stage });
      const complete = vi.fn().mockResolvedValue({ ...successResponse(), stopReason: "length" });
      input.ctx.modelRegistry.complete = complete;
      await expect(generateValidatedSummary(input)).rejects.toThrow(
        `Compaction ${stage} summary hit the model output limit`,
      );
      expect(complete).toHaveBeenCalledTimes(1);
      expect(retries).toHaveLength(0);
    }
  });

  it.each(["response", "exception"] as const)("retries a stream missing finish_reason from a %s", async (kind) => {
    const { input } = makeInput({ transport: { maxAttempts: 4, baseDelayMs: 0 } });
    const complete = vi.fn();
    if (kind === "response") complete.mockResolvedValueOnce(errorResponse("Stream ended without finish_reason"));
    else complete.mockRejectedValueOnce(new Error("Stream ended without finish_reason"));
    complete.mockResolvedValueOnce(successResponse());
    input.ctx.modelRegistry.complete = complete;

    const generated = await generateValidatedSummary(input);

    expect(generated.content).toContain("> The agent completed the migration tasks.");
    expect(generated.content.match(/^## .+$/gmu)?.map((heading) => heading.slice(3))).toEqual([...REQUIRED_SUMMARY_SECTIONS]);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0]?.[2].sessionId).not.toBe(complete.mock.calls[1]?.[2].sessionId);
    expect(generated.usage.input).toBe(successResponse().usage.input * (kind === "response" ? 2 : 1));
  });

  it.each([1, 4])("bounds incomplete-stream attempts at %i", async (maxAttempts) => {
    const { input, retries } = makeInput({ transport: { maxAttempts, baseDelayMs: 0 } });
    const complete = vi.fn().mockResolvedValue(errorResponse("Stream ended without finish_reason"));
    input.ctx.modelRegistry.complete = complete;

    const error: unknown = await generateValidatedSummary(input).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CompactionProviderError);
    expect((error as CompactionProviderError).diagnostic).toEqual({ stage: "segment", category: "transport", reason: "stream-incomplete", attempts: maxAttempts, maxAttempts });
    expect(complete).toHaveBeenCalledTimes(maxAttempts);
    expect(retries).toHaveLength(maxAttempts - 1);
  });

  it.each([
    ["500: socket failure PRIVATE-ERROR", "http-server-error"],
    ["400: network failure PRIVATE-ERROR", "http-client-error"],
    ["Provider finish_reason: content_filter", "content-filter"],
    ["Provider finish_reason: unknown-network-private", "unknown-stop-reason"],
    ["PRIVATE-ERROR", "unclassified"],
  ])("does not retry non-transport provider failure %s", async (message, reason) => {
    const { input, retries } = makeInput({ transport: { maxAttempts: 4, baseDelayMs: 0 } });
    const complete = vi.fn().mockResolvedValue(errorResponse(message));
    input.ctx.modelRegistry.complete = complete;

    const error: unknown = await generateValidatedSummary(input).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CompactionProviderError);
    expect((error as CompactionProviderError).diagnostic).toMatchObject({ category: "provider-error", reason, attempts: 1 });
    expect((error as Error).message).not.toContain("PRIVATE-ERROR");
    expect(JSON.stringify(error)).not.toContain("unknown-network-private");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(retries).toHaveLength(0);
  });

  it("captures only numeric response status and resets it between retry attempts", async () => {
    const { input } = makeInput({ transport: { maxAttempts: 4, baseDelayMs: 0 } });
    const complete = vi.fn<GenerateValidatedSummaryInput["ctx"]["modelRegistry"]["complete"]>()
      .mockImplementationOnce(async (model, _context, options) => {
        await options?.onResponse?.({ status: 200, headers: { authorization: "PRIVATE-HEADER" } }, model);
        return errorResponse("Stream ended without finish_reason");
      })
      .mockResolvedValueOnce(errorResponse("PRIVATE-ERROR"));
    input.ctx.modelRegistry.complete = complete as typeof input.ctx.modelRegistry.complete;

    const error: unknown = await generateValidatedSummary(input).catch((caught: unknown) => caught);

    expect((error as CompactionProviderError).diagnostic).toEqual({ stage: "segment", category: "provider-error", reason: "unclassified", attempts: 2, maxAttempts: 4 });
    expect(JSON.stringify(error)).not.toContain("PRIVATE");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("aborts during incomplete-stream backoff without dispatching a replay", async () => {
    vi.useFakeTimers();
    const { input, controller, retries } = makeInput({ transport: { maxAttempts: 4, baseDelayMs: 1000 } });
    const complete = vi.fn().mockResolvedValue(errorResponse("Stream ended without finish_reason"));
    input.ctx.modelRegistry.complete = complete;
    const pending = generateValidatedSummary(input);
    const rejected = expect(pending).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(0);

    controller.abort();
    await rejected;
    await vi.runAllTimersAsync();

    expect(complete).toHaveBeenCalledTimes(1);
    expect(retries).toHaveLength(0);
  });

  it("invokes the attempt hook before dispatch and does not retry hook failures", async () => {
    const onAttempt = vi.fn(() => { throw new Error("operation budget exhausted"); });
    const { input } = makeInput({ onAttempt });

    await expect(generateValidatedSummary(input)).rejects.toThrow("operation budget exhausted");
    expect(onAttempt).toHaveBeenCalledWith({ stage: "segment", attempt: 1, maxAttempts: 4 });
    expect(input.ctx.modelRegistry.complete).not.toHaveBeenCalled();
  });

  it("uses the default policy (4 attempts, 2000/4000/8000 ms backoff) when transport is not configured", async () => {
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
    await vi.advanceTimersByTimeAsync(8000);
    await expect(promise).rejects.toThrow("attempts=4");
    expect(retries.map((retry) => retry.delayMs)).toEqual([2000, 4000, 8000]);
    expect(retries.every((retry) => retry.maxAttempts === 4)).toBe(true);
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

describe("generateValidatedSummary validation diagnostics", () => {
  const tick = String.fromCharCode(96);
  const badBullet = `- ${tick}compaction.model=deepseek/deepseek-flash${tick}`;
  const exactOnlySummary = REQUIRED_SUMMARY_SECTIONS
    .map((section) => {
      const content = section === "Objective"
        ? Array.from({ length: 9 }, () => badBullet).join("\n")
        : "- None";
      return `## ${section}\n${content}`;
    })
    .join("\n\n");

  it("downgrades unsupported exact values instead of failing closed", async () => {
    const { input } = makeInput({
      validate: true,
      validationSource: ["compaction.model", "deepseek/deepseek-flash"].join("\n\n"),
    });
    input.ctx.modelRegistry.complete = vi.fn(async () => ({
      ...successResponse(),
      content: [{ type: "text" as const, text: exactOnlySummary }],
    }));

    const generated = await generateValidatedSummary(input);

    expect(generated.content).toContain("- compaction.model=deepseek/deepseek-flash");
    expect(generated.content).not.toContain(`${tick}compaction.model=deepseek/deepseek-flash${tick}`);
    expect(generated.validation.status).toBe("warning");
    expect(generated.validation.issues.map((issue) => issue.code)).toEqual(["unsupported-exact-spans-unquoted"]);
  });

  it("repairs combined heading, order, duplicate, omission, and exact-value errors with counter-only diagnostics", async () => {
    const raw = [
      "# Next Actions\n- Continue the synthetic task.",
      "## Objective\n- First objective.",
      "## Objective\n- Second objective.",
      "## private-synthetic-heading\n- Use `deploy --unverified-mode`.",
    ].join("\n\n");
    const { input } = makeInput({ stage: "aggregate", validate: true });
    input.ctx.modelRegistry.complete = vi.fn(async () => ({
      ...successResponse(), content: [{ type: "text" as const, text: raw }],
    }));

    const generated = await generateValidatedSummary(input);

    expect(generated.validation.status).toBe("warning");
    expect(generated.content).toContain("- First objective.\n\n- Second objective.");
    expect(generated.content).toContain("> ## private-synthetic-heading\n> - Use deploy --unverified-mode.");
    expect(generated.content.match(/^## .+$/gmu)?.map((heading) => heading.slice(3))).toEqual([...REQUIRED_SUMMARY_SECTIONS]);
    expect(generated.validation.issues.map((issue) => issue.code)).toEqual([
      "summary-structure-normalized", "summary-sections-not-reported", "unsupported-exact-spans-unquoted",
    ]);
    expect(JSON.stringify(generated.validation.issues)).not.toContain("private-synthetic-heading");
    expect(JSON.stringify(generated.validation.issues)).not.toContain("deploy --unverified-mode");
    expect(input.ctx.modelRegistry.complete).toHaveBeenCalledTimes(1);
  });

  it.each(["", " \t\n", "```markdown\n```"])("still rejects empty output %j without a repair request", async (text) => {
    const { input } = makeInput({ validate: true });
    input.ctx.modelRegistry.complete = vi.fn(async () => ({
      ...successResponse(), content: [{ type: "text" as const, text }],
    }));
    await expect(generateValidatedSummary(input)).rejects.toThrow(/empty/u);
    expect(input.ctx.modelRegistry.complete).toHaveBeenCalledTimes(1);
  });

  it("still rejects a summary response that attempts to call a tool", async () => {
    const { input } = makeInput({ validate: true });
    input.ctx.modelRegistry.complete = vi.fn(async () => ({
      ...successResponse(), content: [{ type: "toolCall" as const, id: "synthetic-tool", name: "read", arguments: {} }],
    }));
    await expect(generateValidatedSummary(input)).rejects.toThrow("attempted to call a tool");
    expect(input.ctx.modelRegistry.complete).toHaveBeenCalledTimes(1);
  });

  it.each(["segment", "aggregate", "update"] as const)(
    "repairs missing-section plus unsupported-exact-value in %s without another provider call",
    async (stage) => {
      const summary = REQUIRED_SUMMARY_SECTIONS
        .filter((section) => section !== "User Constraints")
        .map((section) => {
          const content = section === "Objective"
            ? Array.from({ length: 9 }, () => badBullet).join("\n")
            : "- None";
          return `## ${section}\n${content}`;
        })
        .join("\n\n");
      const { input } = makeInput({
        stage,
        validate: true,
        validationSource: ["compaction.model", "deepseek/deepseek-flash"].join("\n\n"),
      });
      input.ctx.modelRegistry.complete = vi.fn(async () => ({
        ...successResponse(),
        content: [{ type: "text" as const, text: summary }],
      }));

      const generated = await generateValidatedSummary(input);

      expect(generated.content).toContain("## User Constraints\n- Not reported in the generated summary; absence of facts is not established.");
      expect(generated.content.match(/^- compaction\.model=deepseek\/deepseek-flash$/gmu)).toHaveLength(9);
      expect(generated.content).not.toContain(`${tick}compaction.model=deepseek/deepseek-flash${tick}`);
      expect(generated.validation.status).toBe("warning");
      expect(generated.validation.issues.map((issue) => issue.code)).toEqual([
        "summary-structure-normalized", "summary-sections-not-reported", "unsupported-exact-spans-unquoted",
      ]);
      expect(JSON.stringify(generated.validation.issues)).not.toContain("deepseek");
      expect(input.ctx.modelRegistry.complete).toHaveBeenCalledTimes(1);
      expect(generated.usage).toEqual(usage());
    },
  );
});
