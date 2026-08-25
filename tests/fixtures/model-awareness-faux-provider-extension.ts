import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PRIVATE = "MODEL-AWARENESS-LOCAL-ONLY";

function responses(expectedPrivate: boolean) {
  return Array.from({ length: 64 }, () => (
    context: { messages: unknown[] },
    _options: unknown,
    _state: unknown,
    model: { provider: string; id: string },
  ) => {
    const containsPrivate = JSON.stringify(context.messages).includes(PRIVATE);
    const privacySafe = containsPrivate === expectedPrivate;
    return fauxAssistantMessage(
      `MODEL_AWARENESS_E2E ${model.provider}/${model.id} privacy=${privacySafe ? "ok" : "leak"}`,
    );
  });
}

export default function modelAwarenessFauxProviders(pi: ExtensionAPI): void {
  const local = fauxProvider({
    provider: "model-aware-local",
    models: [{ id: "small-32k", contextWindow: 32_000, maxTokens: 4_096 }],
    tokensPerSecond: 1_000_000,
  });
  local.setResponses(responses(true));
  pi.registerProvider(local.provider);

  const remote = fauxProvider({
    provider: "model-aware-remote",
    models: [
      { id: "medium-128k", contextWindow: 128_000, maxTokens: 16_384 },
      { id: "large-200k", contextWindow: 200_000, maxTokens: 32_768 },
    ],
    tokensPerSecond: 1_000_000,
  });
  remote.setResponses(responses(false));
  pi.registerProvider(remote.provider);
}
