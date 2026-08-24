import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function fauxSmokeProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    models: [{ id: "faux-1", contextWindow: 32_000, maxTokens: 4_096 }],
    tokensPerSecond: 1_000_000,
  });
  faux.setResponses([fauxAssistantMessage("Faux provider response")]);
  pi.registerProvider(faux.provider);
}
