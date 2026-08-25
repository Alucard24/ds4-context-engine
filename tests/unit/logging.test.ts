import { describe, expect, it } from "vitest";
import { StructuredLogger } from "../../src/shared/logging.ts";

describe("StructuredLogger", () => {
  it("redacts sensitive metadata and filters levels", () => {
    const lines: string[] = [];
    const logger = new StructuredLogger({
      level: "info",
      sink: (line) => lines.push(line),
      now: () => new Date("2026-08-24T00:00:00.000Z"),
    });

    logger.debug("hidden", { value: 1 });
    logger.info("request", {
      apiKey: "secret",
      prompt: "private",
      estimatedTokens: 42,
      error: "[ds4:local-only]LOCAL-LOG-SECRET[/ds4:local-only] sk-logcredential123",
    });

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "{}") as { metadata: Record<string, unknown> };
    expect(record.metadata.apiKey).toBe("[redacted]");
    expect(record.metadata.prompt).toBe("[redacted]");
    expect(record.metadata.estimatedTokens).toBe(42);
    expect(String(record.metadata.error)).not.toContain("LOCAL-LOG-SECRET");
    expect(String(record.metadata.error)).not.toContain("logcredential123");
  });
});
