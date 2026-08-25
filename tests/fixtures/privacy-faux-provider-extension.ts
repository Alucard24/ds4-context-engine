import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FORBIDDEN = [
  "NATIVE-LOCAL-E2E",
  "PROJECT-LOCAL-E2E",
  "PROVIDER-HOOK-LOCAL-E2E",
  "sk-e2ecredential12345",
];

export default function privacyFauxProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    provider: "privacy-faux",
    models: [{ id: "privacy-faux-1", contextWindow: 64_000, maxTokens: 4_096 }],
    tokensPerSecond: 1_000_000,
  });
  faux.setResponses([async (context, options, _state, model) => {
    const payload = {
      model: model.id,
      context,
      prompt: "[ds4:local-only]PROVIDER-HOOK-LOCAL-E2E[/ds4:local-only]",
    };
    const checked = await options?.onPayload?.(payload, model) ?? payload;
    const serializedContext = JSON.stringify(context);
    const serializedPayload = JSON.stringify(checked);
    const contextSafe = FORBIDDEN.filter((value) => value !== "PROVIDER-HOOK-LOCAL-E2E")
      .every((value) => !serializedContext.includes(value));
    const payloadSafe = FORBIDDEN.every((value) => !serializedPayload.includes(value));
    const protocolPreserved = serializedPayload.includes("privacy-faux-1");
    return fauxAssistantMessage(
      contextSafe && payloadSafe && protocolPreserved
        ? "PRIVACY_E2E_OK"
        : "PRIVACY_E2E_LEAK",
    );
  }]);
  pi.registerProvider(faux.provider);
}
