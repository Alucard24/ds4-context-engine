import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Tool,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import {
  continuationItemHashes,
  type NativeContinuationAttempt,
  type PreparedNativeContinuation,
} from "ds4-context-core/continuation/native-continuation";

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

interface ParsedTextSignature {
  id: string;
  phase?: "commentary" | "final_answer";
}

function parseTextSignature(signature: string | undefined): ParsedTextSignature | undefined {
  if (!signature) return undefined;
  if (signature.startsWith("{")) {
    try {
      const parsed = JSON.parse(signature) as Record<string, unknown>;
      if (parsed.v === 1 && typeof parsed.id === "string") {
        return parsed.phase === "commentary" || parsed.phase === "final_answer"
          ? { id: parsed.id, phase: parsed.phase }
          : { id: parsed.id };
      }
    } catch {
      // Fall through to the legacy plain-string signature.
    }
  }
  return { id: signature };
}

function shortHash(value: string): string {
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507)
    ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507)
    ^ Math.imul(first ^ (first >>> 13), 3266489909);
  return (second >>> 0).toString(36) + (first >>> 0).toString(36);
}

function sanitizeSurrogates(value: string): string {
  return value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu,
    "",
  );
}

function grammarInputProperties(
  tools: Tool[] | undefined,
  supported: boolean,
): ReadonlyMap<string, string> {
  const properties = new Map<string, string>();
  if (!supported) return properties;

  for (const tool of tools ?? []) {
    const config = tool.constrainedSampling;
    if (!config || config.type !== "grammar") continue;
    const hasDefinition = [config.variants.openai_lark, config.variants.openai_regex]
      .some((value) => typeof value === "string" && value.trim().length > 0);
    if (!hasDefinition) throw new Error(`Grammar tool ${tool.name} has no OpenAI definition`);

    const schema = tool.parameters as {
      type?: unknown;
      required?: unknown;
      properties?: Record<string, { type?: unknown }>;
    };
    if (schema.type !== "object"
      || !Array.isArray(schema.required)
      || schema.required.length !== 1
      || typeof schema.required[0] !== "string") {
      throw new Error(`Grammar tool ${tool.name} requires one string property`);
    }
    const inputProperty = schema.required[0];
    if (schema.properties?.[inputProperty]?.type !== "string") {
      throw new Error(`Grammar tool ${tool.name} requires one string property`);
    }
    properties.set(tool.name, inputProperty);
  }
  return properties;
}

function responseItems(
  model: Model<Api>,
  context: Context,
  message: AssistantMessage,
): unknown[] {
  if (message.provider !== model.provider
    || message.api !== model.api
    || message.model !== model.id
    || message.stopReason === "error"
    || message.stopReason === "aborted") {
    return [];
  }

  const supportsGrammar = Boolean(
    model.compat
    && "supportsOpenAIGrammarTools" in model.compat
    && model.compat.supportsOpenAIGrammarTools === true,
  );
  const grammarProperties = grammarInputProperties(context.tools, supportsGrammar);
  const items: unknown[] = [];
  let textBlockIndex = 0;

  for (const block of message.content) {
    if (block.type === "thinking") {
      if (block.thinkingSignature) items.push(JSON.parse(block.thinkingSignature));
      continue;
    }
    if (block.type === "text") {
      const signature = parseTextSignature(block.textSignature);
      const fallbackId = textBlockIndex === 0 ? "msg_pi_0" : `msg_pi_0_${textBlockIndex}`;
      textBlockIndex++;
      const id = !signature?.id
        ? fallbackId
        : signature.id.length > 64
          ? `msg_${shortHash(signature.id)}`
          : signature.id;
      items.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: sanitizeSurrogates(block.text), annotations: [] }],
        status: "completed",
        id,
        phase: signature?.phase,
      });
      continue;
    }

    const [callId, rawItemId] = block.id.split("|");
    const grammarProperty = grammarProperties.get(block.name);
    let itemId = rawItemId;
    if (grammarProperty === undefined && !itemId?.startsWith("fc_")) itemId = undefined;
    const namespace = block.namespace === undefined ? {} : { namespace: block.namespace };
    if (grammarProperty !== undefined) {
      const input = block.arguments[grammarProperty];
      if (typeof input !== "string") {
        throw new Error(`Grammar tool ${block.name} requires string input`);
      }
      items.push({
        type: "custom_tool_call",
        id: itemId,
        call_id: callId,
        name: block.name,
        input: sanitizeSurrogates(input),
        ...namespace,
      });
    } else {
      items.push({
        type: "function_call",
        id: itemId,
        call_id: callId,
        name: block.name,
        arguments: JSON.stringify(block.arguments),
        ...namespace,
      });
    }
  }
  return items;
}

export function openAIResponseItemHashes(
  model: Model<Api>,
  context: Context,
  message: AssistantMessage,
): string[] {
  try {
    return continuationItemHashes(responseItems(model, context, message));
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
            controller.complete(
              attempt,
              event.message,
              openAIResponseItemHashes(model, context, event.message),
            );
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
