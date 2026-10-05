import { describe, expect, it } from "vitest";
import { HISTORY_RESULT_SCHEMA, historyPrivacyClassification } from "ds4-context-core/retrieval/history-privacy";
import { validateHistoryQuery } from "ds4-context-core/retrieval/history-query";
import { DEFAULT_CONFIG } from "ds4-context-core/config/config";

const frame = { schema: HISTORY_RESULT_SCHEMA, quotedData: true, hits: [{ classification: "local-only", excerpt: "private" }] };
describe("quoted history classification propagation", () => {
  it("preserves strongest classifications through nested JSON and mixed markers", () => {
    expect(historyPrivacyClassification({ content: [{ text: JSON.stringify(frame) }] })).toBe("local-only");
    expect(historyPrivacyClassification(JSON.stringify({ messages: [{ content: JSON.stringify(frame) }] }))).toBe("local-only");
    expect(historyPrivacyClassification({ classification: "normal", content: "[ds4:sensitive]private[/ds4:sensitive]" })).toBe("sensitive");
    expect(historyPrivacyClassification({ role: "user", content: "ordinary text" })).toBeUndefined();
  });
  it("fails closed for malformed marked protocol data, excessive traversal and false quotedData", () => {
    expect(historyPrivacyClassification('{"schema":"ds4-history-result-v1",broken')).toBe("local-only");
    expect(historyPrivacyClassification({ schema: HISTORY_RESULT_SCHEMA, quotedData: false, classification: "normal" })).toBe("local-only");
    expect(historyPrivacyClassification(Array.from({ length: 10_001 }, () => "plain"))).toBe("local-only");
  });
  it("validates explicit query budgets/scope/filters without permitting default project expansion", () => {
    expect(validateHistoryQuery({ query: "LastExportUtc", scope: "current-session", roles: ["user"] }, DEFAULT_CONFIG.historyTools).scope).toBe("current-session");
    expect(() => validateHistoryQuery({ query: "x", maxOutputTokens: 255 }, DEFAULT_CONFIG.historyTools)).toThrow("invalid-budget");
    expect(() => validateHistoryQuery({ query: "x", roles: ["system"] }, DEFAULT_CONFIG.historyTools)).toThrow("invalid-role");
    expect(() => validateHistoryQuery({ query: "x", before: "2026-01-01T00:00:00Z", after: "2026-02-01T00:00:00Z" }, DEFAULT_CONFIG.historyTools)).toThrow("invalid-date-range");
    expect(() => validateHistoryQuery({ query: "x" }, { ...DEFAULT_CONFIG.historyTools, defaultScope: "project" } as unknown as typeof DEFAULT_CONFIG.historyTools)).toThrow("invalid-scope");
  });
});
