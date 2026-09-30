import { describe, expect, it } from "vitest";
import {
  classifyCompactionProviderFailure,
  compactionHttpStatus,
  CompactionProviderError,
} from "../../src/pi-adapter/compaction-provider-error.ts";

const privateDetail = "PRIVATE-PAYLOAD /private/session.jsonl sk-private-example";

describe("compaction provider failure metadata", () => {
  it.each([
    ["Stream ended without finish_reason", "transport", "stream-incomplete"],
    ["Stream ended without finish_reason\n" + privateDetail, "transport", "stream-incomplete"],
    ["WebSocket error: connection reset", "transport", "transport-error"],
    ["Provider finish_reason: network_error", "transport", "transport-error"],
    ["Provider finish_reason: content_filter", "provider-error", "content-filter"],
    ["Provider finish_reason: private-network-stop", "provider-error", "unknown-stop-reason"],
    ["500: socket unavailable " + privateDetail, "provider-error", "http-server-error"],
    ["HTTP 503 Service Unavailable", "provider-error", "http-server-error"],
    ["400: " + privateDetail, "provider-error", "http-client-error"],
    ["400: network failure " + privateDetail, "provider-error", "http-client-error"],
    ["402: " + privateDetail, "usage-limit", "usage-limit"],
    ["403: " + privateDetail, "authentication", "authentication"],
    ["429: " + privateDetail, "rate-limit", "rate-limit"],
    ["413: " + privateDetail, "input-limit", "input-limit"],
    ["input tokens exceed maximum", "input-limit", "input-limit"],
    ["billing quota depleted", "usage-limit", "usage-limit"],
    ["arbitrary failure: " + privateDetail, "provider-error", "unclassified"],
    ["body quoted Stream ended without finish_reason", "provider-error", "unclassified"],
  ])("classifies %s into allowlisted metadata", (message, category, reason) => {
    const diagnostic = classifyCompactionProviderFailure(message);
    expect(diagnostic).toMatchObject({ category, reason });
    expect(JSON.stringify(diagnostic)).not.toContain(privateDetail);
    expect(JSON.stringify(diagnostic)).not.toContain("private-network-stop");
  });

  it("accepts structured HTTP status while discarding bodies and arbitrary fields", () => {
    const error = Object.assign(new Error(privateDetail), { status: 502, code: privateDetail, body: privateDetail });
    expect(classifyCompactionProviderFailure(error)).toEqual({ category: "provider-error", reason: "http-server-error", httpStatus: 502 });
    expect(classifyCompactionProviderFailure({ statusCode: 401, body: privateDetail })).toEqual({ category: "authentication", reason: "authentication", httpStatus: 401 });
    expect(classifyCompactionProviderFailure({ $metadata: { httpStatusCode: 503 } }).httpStatus).toBe(503);
    expect(classifyCompactionProviderFailure({ $response: { statusCode: 400 } }).httpStatus).toBe(400);
  });

  it("retains a numeric observed response status without parsing an arbitrary body", () => {
    expect(classifyCompactionProviderFailure(privateDetail, undefined, 200)).toEqual({ category: "provider-error", reason: "unclassified", httpStatus: 200 });
    expect(classifyCompactionProviderFailure("Stream ended without finish_reason", undefined, 200)).toEqual({ category: "transport", reason: "stream-incomplete", httpStatus: 200 });
    expect(classifyCompactionProviderFailure(privateDetail, "content_filter").reason).toBe("content-filter");
    expect(classifyCompactionProviderFailure(privateDetail, "network_error").category).toBe("transport");
    expect(classifyCompactionProviderFailure(privateDetail, privateDetail).reason).toBe("unclassified");
  });

  it("does not infer a status from body numbers or malformed status fields", () => {
    expect(classifyCompactionProviderFailure("body includes 500 failures").httpStatus).toBeUndefined();
    expect(classifyCompactionProviderFailure({ status: "500", code: 503 }).httpStatus).toBeUndefined();
    for (const value of [0, 99, 600, 200.5, Number.NaN, Number.POSITIVE_INFINITY, "500", privateDetail]) {
      expect(compactionHttpStatus(value)).toBeUndefined();
    }
  });

  it("preserves an AbortError without leaking its message", () => {
    expect(classifyCompactionProviderFailure(Object.assign(new Error(privateDetail), { name: "AbortError" })))
      .toEqual({ category: "aborted", reason: "aborted" });
  });

  it("carries only safe metadata in the final error, without a raw cause", () => {
    const error = new CompactionProviderError("aggregate", "response", classifyCompactionProviderFailure("500: " + privateDetail), 1, 4);
    expect(error.diagnostic).toEqual({ stage: "aggregate", category: "provider-error", reason: "http-server-error", httpStatus: 500, attempts: 1, maxAttempts: 4 });
    expect(error.message).toContain("reason=http-server-error; httpStatus=500");
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(privateDetail);
    expect(error.stack).not.toContain(privateDetail);
  });
});
