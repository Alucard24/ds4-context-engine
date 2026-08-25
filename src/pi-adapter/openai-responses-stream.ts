import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createGrammarToolInputProperties } from "@earendil-works/pi-ai/api/constrained-sampling";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import {
  continuationItemHashes,
  type NativeContinuationAttempt,
  type PreparedNativeContinuation,
} from "ds4-context-core/continuation/native-continuation";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

export type OpenAIResponsesStreamDelegate = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface NativeContinuationStreamController {
  prepare(
    payload: unknown,
    model: Model<Api>,
    requestSessionId: string | undefined,
    options: {
      forceManagedReplay: boolean;
      retryOfContinuation: boolean;
      fallbackReason?: string;
    },
  ): PreparedNativeContinuation;
  beginManagedReplayRetry(attempt: NativeContinuationAttempt): void;
  complete(
    attempt: NativeContinuationAttempt,
    message: AssistantMessage,
    responseItemHashes: readonly string[],
  ): void;
  fail(attempt: NativeContinuationAttempt, reason: string): void;
  shouldRetryManagedReplay(): boolean;
}

interface AttemptRun {
  stream: AssistantMessageEventStream;
  attempt: () => NativeContinuationAttempt | undefined;
}

function terminalMessage(event: AssistantMessageEvent): AssistantMessage | undefined {
  if (event.type === "done") return event.message;
  if (event.type === "error") return event.error;
  return undefined;
}

function retryableContinuationError(event: AssistantMessageEvent): boolean {
  if (event.type !== "error") return false;
  const message = event.error.errorMessage ?? "";
  return /previous[ _-]?response|previous_response_id|response(?:\s+with)?\s+id[^\n]{0,80}(?:not found|expired|invalid|unknown)|conversation(?:\s+with)?\s+id[^\n]{0,80}(?:not found|expired|invalid|unknown)/iu.test(message);
}

function outputItemHashes(
  model: Model<Api>,
  context: Context,
  message: AssistantMessage,
): string[] {
  try {
    const supportsGrammar = Boolean(
      model.compat
      && "supportsOpenAIGrammarTools" in model.compat
      && model.compat.supportsOpenAIGrammarTools === true,
    );
    const grammarToolInputProperties = createGrammarToolInputProperties(
      context.tools,
      supportsGrammar,
    );
    const items = convertResponsesMessages(
      model,
      { messages: [message] },
      OPENAI_TOOL_CALL_PROVIDERS,
      {
        includeSystemPrompt: false,
        grammarToolInputProperties,
      },
    ).filter((item) => item.type !== "function_call_output"
      && item.type !== "custom_tool_call_output");
    return continuationItemHashes(items);
  } catch {
    return [];
  }
}

function syntheticError(model: Model<Api>, error: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

export function createOpenAIResponsesContinuationStream(
  controller: NativeContinuationStreamController,
  delegate: OpenAIResponsesStreamDelegate = (model, context, options) =>
    openAIResponsesApi().streamSimple(model, context, options),
): OpenAIResponsesStreamDelegate {
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();

    const startAttempt = (
      forceManagedReplay: boolean,
      retryOfContinuation: boolean,
    ): AttemptRun => {
      let preparedAttempt: NativeContinuationAttempt | undefined;
      const stream = delegate(model, context, {
        ...options,
        onPayload: async (payload, payloadModel) => {
          const replacement = await options?.onPayload?.(payload, payloadModel);
          const finalPayload = replacement === undefined ? payload : replacement;
          const prepared = controller.prepare(
            finalPayload,
            model,
            options?.sessionId,
            {
              forceManagedReplay,
              retryOfContinuation,
              ...(retryOfContinuation
                ? { fallbackReason: "provider-rejected-continuation" }
                : {}),
            },
          );
          preparedAttempt = prepared.attempt;
          return prepared.payload;
        },
      });
      return { stream, attempt: () => preparedAttempt };
    };

    const consume = async (
      run: AttemptRun,
      allowRetry: boolean,
    ): Promise<"complete" | "retry"> => {
      let started = false;
      for await (const event of run.stream) {
        if (event.type === "start") started = true;
        const attempt = run.attempt();
        let retryEnabled = false;
        try {
          retryEnabled = controller.shouldRetryManagedReplay();
        } catch {
          retryEnabled = false;
        }
        if (event.type === "error"
          && allowRetry
          && !started
          && attempt?.usedContinuation
          && !options?.signal?.aborted
          && retryEnabled
          && retryableContinuationError(event)) {
          try {
            controller.beginManagedReplayRetry(attempt);
            return "retry";
          } catch {
            // Continuation bookkeeping must not replace the provider's original error.
          }
        }

        if (event.type === "done" && attempt) {
          try {
            controller.complete(attempt, event.message, outputItemHashes(model, context, event.message));
          } catch {
            // Provider output remains authoritative if optimization bookkeeping fails.
          }
        } else if (event.type === "error" && attempt) {
          try {
            controller.fail(attempt, started
              ? "provider-stream-failed-after-start"
              : "provider-request-failed");
          } catch {
            // Provider output remains authoritative if optimization bookkeeping fails.
          }
        }

        output.push(event);
        if (terminalMessage(event)) {
          output.end();
          return "complete";
        }
      }
      throw new Error("OpenAI Responses provider stream ended without a terminal event");
    };

    void (async () => {
      try {
        const first = startAttempt(false, false);
        const result = await consume(first, true);
        if (result === "retry") {
          const replay = startAttempt(true, true);
          await consume(replay, false);
        }
      } catch (error) {
        const message = syntheticError(model, error);
        output.push({ type: "error", reason: "error", error: message });
        output.end();
      }
    })();

    return output;
  };
}
