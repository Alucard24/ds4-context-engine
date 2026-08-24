import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const COMPACTION_SUMMARY = [
  "## Objective\n- Preserve the discarded conversation state.",
  "## User Constraints\n- None",
  "## Durable Decisions\n- None",
  "## Completed Work\n- None",
  "## Current State\n- Conversation can continue from the retained turn.",
  "## Files Read\n- None",
  "## Files Modified\n- None",
  "## Commands / Tests\n- None",
  "## Errors / Risks\n- None",
  "## Open Questions\n- None",
  "## Next Actions\n- Continue with the retained request.",
  "## Critical Exact Values\n- None",
].join("\n\n");

export default function fauxSmokeProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    models: [{ id: "faux-1", contextWindow: 32_000, maxTokens: 4_096 }],
    tokensPerSecond: 1_000_000,
  });
  faux.setResponses([({ messages }) => {
    const serialized = JSON.stringify(messages);
    return fauxAssistantMessage(
      serialized.includes("DS4 non-destructive compaction summarizer")
        ? COMPACTION_SUMMARY
        : "Faux provider response",
    );
  }]);
  pi.registerProvider(faux.provider);
}
