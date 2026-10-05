import type { HistoryToolsConfig } from "../config/config.ts";

export type HistoryScope = "current-branch" | "current-session" | "current-lineage" | "project";
export interface HistoryRecallRequest {
  query: string;
  scope?: HistoryScope;
  limit?: number;
  maxOutputTokens?: number;
  roles?: string[];
  before?: string;
  after?: string;
  includeSummaries?: boolean;
}
export interface ValidatedHistoryQuery {
  query: string;
  scope: HistoryScope;
  limit: number;
  maxOutputTokens: number;
  roles?: string[];
  before?: number;
  after?: number;
  includeSummaries: boolean;
}
export function validateHistoryQuery(request: HistoryRecallRequest, config: HistoryToolsConfig): ValidatedHistoryQuery {
  if (!request || typeof request.query !== "string" || !request.query.trim()
    || request.query.length > 2_000 || Buffer.byteLength(request.query) > 8_000) {
    throw new Error("invalid-query");
  }
  const scope = request.scope ?? config.defaultScope;
  if (request.scope === undefined && scope === "project") throw new Error("invalid-scope");
  if (!["current-branch", "current-session", "current-lineage", "project"].includes(scope)) throw new Error("invalid-scope");
  const integer = (value: number, max: number): number => {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error("invalid-budget");
    return value;
  };
  const limit = integer(request.limit ?? config.maxResults, 12);
  const maxOutputTokens = integer(request.maxOutputTokens ?? config.maxOutputTokens, 6_000);
  if (maxOutputTokens < 256) throw new Error("invalid-budget");
  const date = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/u.test(value)
      || !Number.isFinite(Date.parse(value))) throw new Error("invalid-date");
    return Date.parse(value);
  };
  const before = date(request.before), after = date(request.after);
  if (before !== undefined && after !== undefined && after >= before) throw new Error("invalid-date-range");
  if (request.roles !== undefined && (!Array.isArray(request.roles) || request.roles.length > 6
    || request.roles.some((role) => !["user", "assistant", "toolResult", "bashExecution", "custom", "summary"].includes(role)))) {
    throw new Error("invalid-role");
  }
  if (request.includeSummaries !== undefined && typeof request.includeSummaries !== "boolean") throw new Error("invalid-filter");
  return { query: request.query, scope, limit: Math.min(limit, config.maxResults),
    maxOutputTokens: Math.min(maxOutputTokens, config.maxOutputTokens),
    ...(request.roles ? { roles: request.roles } : {}), ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}), includeSummaries: request.includeSummaries ?? config.includeSummaries };
}
