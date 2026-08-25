import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "ds4-context-core/config/config";
import {
  continuationItemHashes,
  NativeContinuationManager,
  type NativeContinuationAttempt,
} from "ds4-context-core/continuation/native-continuation";
import {
  createOpenAIResponsesContinuationStream,
  type NativeContinuationStreamController,
} from "../../src/pi-adapter/openai-responses-stream.ts";

const model: Model<Api> = {
  id: "gpt-test",
  name: "GPT Test",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
};

const context: Context = {
  messages: [{ role: "user", content: "second", timestamp: 2 }],
  tools: [],
};

function assistant(
  responseId: string | undefined,
  stopReason: AssistantMessage["stopReason"] = "stop",
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: stopReason === "error" ? [] : [{
      type: "text",
      text: "answer",
      textSignature: JSON.stringify({ v: 1, id: "msg_2" }),
    }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-test",
    ...(responseId ? { responseId } : {}),
    usage: {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: 3,
  };
}

function setupManager(): {
  manager: NativeContinuationManager;
  currentPayload: Record<string, unknown>;
} {
  const continuation = {
    ...createDefaultConfig().nativeContinuation,
    enabled: true,
    allowProviderStorage: true,
    profiles: ["openai/*"],
  };
  const manager = new NativeContinuationManager(continuation, () => 1_000);
  manager.registerProvider("openai");
  const initialInput = [{ role: "user", content: "first" }];
  const base = {
    model: "gpt-test",
    input: initialInput,
    tools: [],
    stream: true,
    prompt_cache_key: "session-1",
    store: false,
  };
  const initial = manager.prepare({
    payload: base,
    provider: "openai",
    model: "gpt-test",
    requestSessionId: "session-1",
    canonicalSessionId: "session-1",
    manifestId: "manifest-1",
    managed: true,
  });
  if (!initial.attempt) throw new Error("Expected initial attempt");
  const priorAssistant = {
    type: "message",
    role: "assistant",
    id: "msg_1",
    status: "completed",
    content: [{ type: "output_text", text: "first answer", annotations: [] }],
  };
  manager.complete(initial.attempt, "resp_1", continuationItemHashes([priorAssistant]));
  return {
    manager,
    currentPayload: {
      ...base,
      input: [
        ...initialInput,
        priorAssistant,
        { role: "user", content: "second" },
      ],
    },
  };
}

function controller(manager: NativeContinuationManager): NativeContinuationStreamController {
  return {
    prepare(payload, requestModel, requestSessionId, options) {
      return manager.prepare({
        payload,
        provider: requestModel.provider,
        model: requestModel.id,
        ...(requestSessionId ? { requestSessionId } : {}),
        canonicalSessionId: "session-1",
        manifestId: "manifest-2",
        managed: true,
        forceManagedReplay: options.forceManagedReplay,
        retryOfContinuation: options.retryOfContinuation,
        ...(options.fallbackReason ? { fallbackReason: options.fallbackReason } : {}),
      });
    },
    beginManagedReplayRetry(attempt: NativeContinuationAttempt) {
      manager.beginManagedReplayRetry(attempt);
    },
    complete(attempt, message, responseItemHashes) {
      manager.complete(attempt, message.responseId, responseItemHashes);
    },
    fail(attempt, reason) {
      manager.fail(attempt, reason);
    },
    shouldRetryManagedReplay() {
      return manager.shouldRetryManagedReplay();
    },
  };
}

describe("OpenAI Responses continuation stream wrapper", () => {
  it("retries a rejected previous_response_id once with the complete managed replay", async () => {
    const { manager, currentPayload } = setupManager();
    const payloads: unknown[] = [];
    let calls = 0;
    const delegate = (_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const replacement = await options?.onPayload?.(currentPayload, model);
        payloads.push(replacement ?? currentPayload);
        calls++;
        if (calls === 1) {
          const error = assistant(
            undefined,
            "error",
            "Previous response with id resp_1 was not found (previous_response_id invalid)",
          );
          stream.push({ type: "error", reason: "error", error });
          stream.end();
          return;
        }
        const done = assistant("resp_2");
        stream.push({ type: "start", partial: done });
        stream.push({ type: "done", reason: "stop", message: done });
        stream.end();
      })();
      return stream;
    };
    const wrapped = createOpenAIResponsesContinuationStream(controller(manager), delegate);
    const events: AssistantMessageEvent[] = [];
    for await (const event of wrapped(model, context, {
      sessionId: "session-1",
      onPayload: (value) => value,
    })) {
      events.push(event);
    }

    expect(calls).toBe(2);
    expect(payloads[0]).toMatchObject({
      previous_response_id: "resp_1",
      input: [{ role: "user", content: "second" }],
      store: true,
    });
    expect(payloads[1]).toMatchObject({
      input: (currentPayload.input as unknown[]),
      store: true,
    });
    expect(payloads[1]).not.toHaveProperty("previous_response_id");
    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
    expect(manager.diagnostics()).toMatchObject({
      retryAttempts: 1,
      retrySuccesses: 1,
      retryFailures: 0,
      stateAvailable: true,
      last: { retry: "succeeded", mode: "managed-replay" },
    });
  });

  it("does not retry unrelated provider failures", async () => {
    const { manager, currentPayload } = setupManager();
    let calls = 0;
    const delegate = (_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        await options?.onPayload?.(currentPayload, model);
        calls++;
        const error = assistant(undefined, "error", "Rate limit exceeded");
        stream.push({ type: "error", reason: "error", error });
        stream.end();
      })();
      return stream;
    };
    const wrapped = createOpenAIResponsesContinuationStream(controller(manager), delegate);
    const result = await wrapped(model, context, { sessionId: "session-1" }).result();

    expect(result.stopReason).toBe("error");
    expect(calls).toBe(1);
    expect(manager.diagnostics()).toMatchObject({
      retryAttempts: 0,
      stateAvailable: false,
    });
  });
});
