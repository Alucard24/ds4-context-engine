export type CompactionProviderFailureCategory =
  | "aborted"
  | "usage-limit"
  | "rate-limit"
  | "input-limit"
  | "authentication"
  | "transport"
  | "provider-error";

export type CompactionProviderFailureReason =
  | "aborted"
  | "usage-limit"
  | "rate-limit"
  | "input-limit"
  | "authentication"
  | "transport-error"
  | "stream-incomplete"
  | "content-filter"
  | "unknown-stop-reason"
  | "http-server-error"
  | "http-client-error"
  | "unclassified";

export interface CompactionProviderFailure {
  category: CompactionProviderFailureCategory;
  reason: CompactionProviderFailureReason;
  httpStatus?: number;
}

export interface CompactionProviderFailureDiagnostic extends CompactionProviderFailure {
  stage: "segment" | "aggregate" | "update";
  attempts: number;
  maxAttempts: number;
}

/** No raw exception, body, headers, arbitrary code or Error.cause escapes here. */
export class CompactionProviderError extends Error {
  readonly diagnostic: CompactionProviderFailureDiagnostic;

  constructor(
    stage: CompactionProviderFailureDiagnostic["stage"],
    kind: "request" | "response",
    failure: CompactionProviderFailure,
    attempts: number,
    maxAttempts: number,
  ) {
    const suffix = [
      `category=${failure.category}`,
      ...(failure.category === "transport" ? [`attempts=${attempts}`] : []),
      `reason=${failure.reason}`,
      ...(failure.httpStatus !== undefined ? [`httpStatus=${failure.httpStatus}`] : []),
    ].join("; ");
    super(`Compaction ${stage} ${kind === "request" ? "request failed" : "summary stopped with error"} (${suffix})`);
    this.name = "CompactionProviderError";
    this.diagnostic = { stage, ...failure, attempts, maxAttempts };
  }
}

export function compactionHttpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function errorHttpStatus(value: unknown, message: string): number | undefined {
  if (value && typeof value === "object") {
    const error = value as {
      status?: unknown;
      statusCode?: unknown;
      $metadata?: { httpStatusCode?: unknown };
      $response?: { statusCode?: unknown };
    };
    for (const candidate of [error.statusCode, error.status, error.$metadata?.httpStatusCode, error.$response?.statusCode]) {
      const status = compactionHttpStatus(candidate);
      if (status !== undefined) return status;
    }
  }
  // Pi's SDK can reduce HTTP failures to "500: <body>" or "500 <message>".
  // Parse only the leading protocol status, never arbitrary body numbers/codes.
  const match = /^\s*(?:HTTP(?:\/\d(?:\.\d)?)?\s+)?([45]\d{2})(?=[:\s]|$)/iu.exec(message);
  return match ? compactionHttpStatus(Number(match[1])) : undefined;
}

export function classifyCompactionProviderFailure(
  value: unknown,
  rawStopReason?: unknown,
  observedHttpStatus?: number,
): CompactionProviderFailure {
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  const httpStatus = compactionHttpStatus(observedHttpStatus) ?? errorHttpStatus(value, message);
  const failure = (
    category: CompactionProviderFailureCategory,
    reason: CompactionProviderFailureReason,
  ): CompactionProviderFailure => ({ category, reason, ...(httpStatus !== undefined ? { httpStatus } : {}) });
  const transportFailure = (reason: "stream-incomplete" | "transport-error"): CompactionProviderFailure =>
    httpStatus !== undefined && httpStatus >= 400
      ? failure("provider-error", "http-client-error")
      : failure("transport", reason);

  if (value instanceof Error && value.name === "AbortError") return failure("aborted", "aborted");
  if (rawStopReason === "content_filter" || /^Provider finish_reason: content_filter(?:\r?\n|$)/u.test(message)) {
    return failure("provider-error", "content-filter");
  }
  // Structured/leading HTTP failures outrank incidental words in the raw body.
  if (httpStatus === 401 || httpStatus === 403) return failure("authentication", "authentication");
  if (httpStatus === 402) return failure("usage-limit", "usage-limit");
  if (httpStatus === 429) return failure("rate-limit", "rate-limit");
  if (httpStatus === 413) return failure("input-limit", "input-limit");
  if (httpStatus !== undefined && httpStatus >= 500) return failure("provider-error", "http-server-error");
  if (/^Stream ended without finish_reason(?:\r?\n|$)/u.test(message)) {
    return transportFailure("stream-incomplete");
  }
  if (rawStopReason === "network_error" || /^Provider finish_reason: network_error(?:\r?\n|$)/u.test(message)) {
    return transportFailure("transport-error");
  }
  if (/^Provider finish_reason: /u.test(message)) return failure("provider-error", "unknown-stop-reason");
  if (/usage|quota|credit|billing/iu.test(message)) return failure("usage-limit", "usage-limit");
  if (/rate|too many requests|429/iu.test(message)) return failure("rate-limit", "rate-limit");
  if (/(?:context|prompt|input).{0,48}(?:exceed|limit|maximum|too (?:long|large)|tokens?)|tokens?.{0,48}(?:exceed|limit|maximum|too many)|maximum (?:context|input|prompt|length)/iu.test(message)) {
    return failure("input-limit", "input-limit");
  }
  if (/auth|credential|api.?key|permission|forbidden|401|403/iu.test(message)) return failure("authentication", "authentication");
  if (/timeout|timed out|network|connection|socket|dns|fetch failed|econn(?:reset|refused|aborted)|etimedout|eai_again|enotfound|und_err/iu.test(message)) {
    return transportFailure("transport-error");
  }
  if (/abort|cancel/iu.test(message)) return failure("aborted", "aborted");
  return failure("provider-error", httpStatus !== undefined && httpStatus >= 400 ? "http-client-error" : "unclassified");
}
