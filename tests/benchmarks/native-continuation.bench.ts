import { bench, describe } from "vitest";
import { createDefaultConfig } from "ds4-context-core/config/config";
import {
  continuationItemHashes,
  NativeContinuationManager,
} from "ds4-context-core/continuation/native-continuation";

const continuationConfig = {
  ...createDefaultConfig().nativeContinuation,
  enabled: true,
  allowProviderStorage: true,
  profiles: ["openai/*"],
};
const manager = new NativeContinuationManager(continuationConfig, () => 1_000);
manager.registerProvider("openai");
const initialInput = Array.from({ length: 1_000 }, (_, index) => ({
  role: index % 3 === 0 ? "developer" : "user",
  content: [{ type: "input_text", text: `stable item ${index} ${"x".repeat(80)}` }],
}));
const body = {
  model: "gpt-bench",
  input: initialInput,
  tools: Array.from({ length: 20 }, (_, index) => ({
    type: "function",
    name: `tool_${index}`,
    parameters: { type: "object", properties: { value: { type: "string" } } },
  })),
  stream: true,
  prompt_cache_key: "bench-session",
  store: false,
};
const first = manager.prepare({
  payload: body,
  provider: "openai",
  model: "gpt-bench",
  api: "openai-responses",
  requestSessionId: "bench-session",
  canonicalSessionId: "bench-session",
  manifestId: "manifest-1",
  managed: true,
});
if (!first.attempt) throw new Error("Expected benchmark setup attempt");
const assistantItem = {
  type: "message",
  role: "assistant",
  id: "msg_bench",
  status: "completed",
  content: [{ type: "output_text", text: "ready", annotations: [] }],
};
manager.complete(first.attempt, "resp_bench", continuationItemHashes([assistantItem]));
const nextPayload = {
  ...body,
  input: [
    ...initialInput,
    assistantItem,
    { role: "user", content: [{ type: "input_text", text: "next request" }] },
  ],
};

describe("native continuation performance", () => {
  bench("verify a 1000-item managed prefix and derive its delta", () => {
    manager.prepare({
      payload: nextPayload,
      provider: "openai",
      model: "gpt-bench",
      api: "openai-responses",
      requestSessionId: "bench-session",
      canonicalSessionId: "bench-session",
      manifestId: "manifest-2",
      managed: true,
    });
  }, { time: 1_000 });
});
