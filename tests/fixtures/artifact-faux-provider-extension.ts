import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NEEDLE = "DS4_E2E_ARTIFACT_NEEDLE";

export default function artifactFauxProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    models: [{ id: "faux-artifact", contextWindow: 32_000, maxTokens: 4_096 }],
    tokensPerSecond: 1_000_000,
  });
  const response = (context: { messages: unknown[] }) => {
    const serialized = JSON.stringify(context.messages);
    const searchRequested = serialized.includes("Search the stored artifact for the exact failure marker.");
    if (searchRequested) {
      if (serialized.includes("artifact-search-call") && serialized.includes(NEEDLE)) {
        return fauxAssistantMessage("ARTIFACT_SEARCH_FOUND=true");
      }
      const artifactId = serialized.match(/Artifact ID: ([a-f0-9]{64})/u)?.[1];
      if (!artifactId) return fauxAssistantMessage("ARTIFACT_ID_MISSING");
      return fauxAssistantMessage(
        fauxToolCall("context_artifact_search", { artifactId, query: NEEDLE, maxMatches: 3 }, { id: "artifact-search-call" }),
        { stopReason: "toolUse" },
      );
    }
    if (!serialized.includes("artifact-bash-call")) {
      const encodedNeedle = Buffer.from(NEEDLE).toString("base64");
      const command = `node -e "const n=Buffer.from('${encodedNeedle}','base64').toString();process.stdout.write('A'.repeat(25000)+'\\n'+n+'\\n'+'B'.repeat(25000))"`;
      return fauxAssistantMessage(
        fauxToolCall("bash", { command }, { id: "artifact-bash-call" }),
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage(
      `ARTIFACTIZED=${serialized.includes("DS4 LARGE TOOL OUTPUT OFFLOADED")};RAW_NEEDLE_LEAK=${serialized.includes(NEEDLE)}`,
    );
  };
  faux.setResponses(Array.from({ length: 8 }, () => response));
  pi.registerProvider(faux.provider);
}
