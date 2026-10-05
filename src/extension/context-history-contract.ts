import type { PrivacyClassification } from "ds4-context-core/privacy/privacy-policy";
import type { HistoryScope } from "ds4-context-core/retrieval/history-query";

export const HISTORY_TOOL_NAMES = ["context_history_recall", "context_history_read", "context_history_status"] as const;
import { HISTORY_RESULT_SCHEMA } from "ds4-context-core/retrieval/history-privacy";
export { HISTORY_RESULT_SCHEMA };
export const HISTORY_OMISSION = "[DS4 history content omitted by current policy]";
export interface HistoryHit {
  sourceRef: string;
  projectId: string;
  sessionId: string;
  entryId: string;
  kind: string;
  role?: string;
  timestamp?: number;
  relation: "ancestor" | "lineage-ancestor" | "other-branch";
  classification: PrivacyClassification;
  excerpt: string;
  matchReasons: string[];
  score: number;
  truncated: boolean;
}
export interface HistoryResult {
  schema: typeof HISTORY_RESULT_SCHEMA;
  quotedData: true;
  status: "complete" | "partial" | "unavailable";
  effectiveScope?: HistoryScope;
  coverage: "complete" | "partial" | "unknown";
  warnings: string[];
  hits?: HistoryHit[];
  source?: Omit<HistoryHit, "excerpt" | "matchReasons" | "score" | "truncated">;
  text?: string;
  startLine?: number;
  nextLine?: number;
  truncated?: boolean;
  indexedEntries?: number;
}
export function historyUnavailable(code: string): HistoryResult {
  return { schema: HISTORY_RESULT_SCHEMA, quotedData: true, status: "unavailable", coverage: "unknown", warnings: [code] };
}
export function renderHistoryResult(result: HistoryResult): string {
  // JSON encodes embedded headings/newlines: historical bytes cannot become structural instructions.
  return JSON.stringify(result);
}
