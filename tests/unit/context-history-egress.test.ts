import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "ds4-context-core/config/config";
import { providerPrivacyPolicy, sanitizeClassifiedText, type PrivacyClassification } from "ds4-context-core/privacy/privacy-policy";
import { sanitizeHistoryEgress } from "../../src/extension/context-history-egress.ts";
import { HISTORY_RESULT_SCHEMA, renderHistoryResult } from "../../src/extension/context-history-contract.ts";

function sanitizer(local: boolean) {
  const config = structuredClone(DEFAULT_CONFIG.privacy);
  config.localProviders.push("local");
  return (text: string, classification?: PrivacyClassification) => {
    const result = sanitizeClassifiedText(text, providerPrivacyPolicy(config, local ? "local" : "openai"), classification ?? "normal", true);
    return { text: result.value, omitted: result.blockedBlocks > 0 };
  };
}
const text = renderHistoryResult({ schema: HISTORY_RESULT_SCHEMA, quotedData: true, status: "complete", coverage: "complete", warnings: [],
  hits: [{ sourceRef: "hist_" + "a".repeat(32), projectId: "p", sessionId: "s", entryId: "e", kind: "message", relation: "ancestor",
    classification: "local-only", excerpt: "secret-local-history", score: 1, matchReasons: ["lexical-match"], truncated: false }] });

describe("history egress revalidation", () => {
  it("rechecks provider switches and strips query/unknown details without touching unrelated tools or input", () => {
    const original = [
      { role: "assistant", content: [{ type: "toolCall", id: "h", name: "context_history_recall", arguments: { query: "query-secret" } }] },
      { role: "toolResult", toolName: "context_history_recall", toolCallId: "h", content: [{ type: "text", text }], details: { secret: "details-secret" } },
      { role: "toolResult", toolName: "read", toolCallId: "r", content: [{ type: "text", text: "unrelated-read" }] },
    ];
    const local = sanitizeHistoryEgress(original, sanitizer(true)).value;
    expect(JSON.stringify(local)).toContain("secret-local-history");
    const remote = sanitizeHistoryEgress(local, sanitizer(false)).value;
    expect(JSON.stringify(remote)).not.toContain("secret-local-history");
    expect(JSON.stringify(remote)).not.toContain("query-secret");
    expect(JSON.stringify(remote)).not.toContain("details-secret");
    expect(remote[2]).toEqual(original[2]);
    expect(JSON.stringify(original)).toContain("details-secret");
    expect(sanitizeHistoryEgress(remote, sanitizer(false)).value).toEqual(remote);
  });
  it.each(["openai", "anthropic", "google"])("sanitizes linked %s transport result shapes", (shape) => {
    const payload = shape === "openai" ? [
      { type: "function_call", call_id: "h", name: "context_history_read", arguments: JSON.stringify({ sourceRef: "query-secret" }) },
      { type: "function_call_output", call_id: "h", output: text },
    ] : shape === "anthropic" ? [
      { type: "tool_use", id: "h", name: "context_history_recall", input: { query: "query-secret" } },
      { type: "tool_result", tool_use_id: "h", content: [{ type: "text", text }] },
    ] : [{ functionCall: { name: "context_history_recall", args: { query: "query-secret" } } },
      { functionResponse: { name: "context_history_recall", response: { output: text } } }];
    const out = JSON.stringify(sanitizeHistoryEgress(payload, sanitizer(false)).value);
    expect(out).not.toContain("secret-local-history"); expect(out).not.toContain("query-secret");
  });
  it("rechecks marked rebase handoffs in provider payloads even without managed privacy", () => {
    const content = "[ds4:local-only][DS4 REBASE HANDOFF — QUOTED STATE]private-rebase-body[END DS4 REBASE HANDOFF][/ds4:local-only]";
    const payload = { messages: [{ role: "user", content }] };
    expect(JSON.stringify(sanitizeHistoryEgress(payload, sanitizer(true)).value)).toContain("private-rebase-body");
    expect(JSON.stringify(sanitizeHistoryEgress(payload, sanitizer(false)).value)).not.toContain("private-rebase-body");
  });
  it("fails closed for malformed text, missing classification, images and arbitrary extra fields", () => {
    for (const value of ["malformed-secret", JSON.stringify({ schema: HISTORY_RESULT_SCHEMA, quotedData: true, text: "unsafe-text" })]) {
      const payload = [{ role: "toolResult", toolName: "context_history_read", content: [{ type: "text", text: value }, { type: "image", data: "image-secret" }], details: { extra: "secret" } }];
      const out = JSON.stringify(sanitizeHistoryEgress(payload, sanitizer(false)).value);
      expect(out).not.toContain("unsafe-text"); expect(out).not.toContain("malformed-secret"); expect(out).not.toContain("image-secret");
    }
  });
});
