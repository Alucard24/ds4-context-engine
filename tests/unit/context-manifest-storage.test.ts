import { describe, expect, it } from "vitest";
import type { ContextManifest } from "ds4-context-core/manifest/context-manifest";
import {
  HARD_PERSISTED_MANIFEST_BYTES,
  MAX_RETAINED_EXCLUDED_DETAILS,
  PREFERRED_PERSISTED_MANIFEST_BYTES,
  buildPersistedManifestProjection,
  utf8ByteLength,
} from "ds4-context-core/manifest/context-manifest-storage";

function manifest(): ContextManifest {
  return {
    schemaVersion: 1,
    id: "manifest-storage",
    sessionId: "session-storage",
    provider: "test",
    model: "model",
    contextWindow: 128_000,
    outputReserve: 16_000,
    hardInputLimit: 110_000,
    targetInputTokens: 90_000,
    estimatedInputTokens: 1_000,
    included: [{ kind: "current", sourceId: "included", tokens: 100, reason: "required" }],
    excluded: [],
    summaryIds: [],
    retrievedEventIds: [],
    projectSnippets: [],
    composition: { systemTokens: 10, toolTokens: 20, messageTokens: 970, messageCount: 1, toolCount: 1 },
    policyVersion: "policy-v1",
    plannerVersion: "planner-v1",
    promptHash: "prompt-hash",
    createdAt: 1,
  };
}

describe("Context Manifest persisted projection", () => {
  it("counts UTF-8 bytes and leaves small payloads byte-for-byte unchanged", () => {
    expect(utf8ByteLength("a😀")).toBe(5);
    const source = manifest();
    const serialized = JSON.stringify(source);
    const result = buildPersistedManifestProjection(source);
    expect(result.status).toBe("stored");
    if (result.status !== "stored") return;
    expect(result.serialized).toBe(serialized);
    expect(result.storedBytes).toBeLessThan(PREFERRED_PERSISTED_MANIFEST_BYTES);
    expect(result.inventory.completeness).toBe("complete");
    expect(source).not.toHaveProperty("persistedInventory");
  });

  it("retains deterministic first/last excluded details and rolls up the complete inventory", () => {
    const source = manifest();
    source.excluded = Array.from({ length: 600 }, (_, index) => ({
      kind: index % 2 === 0 ? "history" as const : "retrieval" as const,
      sourceId: `excluded-${index}`,
      tokens: index + 1,
      classification: index % 3 === 0 ? "internal" as const : undefined,
      reason: `${index % 7}:${"x".repeat(600)}`,
    }));
    const before = structuredClone(source);
    const first = buildPersistedManifestProjection(source);
    const second = buildPersistedManifestProjection(structuredClone(source));
    expect(first.status).toBe("stored");
    expect(second.status).toBe("stored");
    if (first.status !== "stored" || second.status !== "stored") return;

    expect(first.inventory).toMatchObject({
      completeness: "excluded-rollup",
      included: { total: 1, retained: 1, complete: true },
      excluded: {
        total: 600,
        retained: MAX_RETAINED_EXCLUDED_DETAILS,
        omitted: 600 - MAX_RETAINED_EXCLUDED_DETAILS,
      },
    });
    expect(first.inventory.excluded.tokens).toBe(600 * 601 / 2);
    expect(first.inventory.excluded.byKind).toEqual({
      history: { items: 300, tokens: 90_000 },
      retrieval: { items: 300, tokens: 90_300 },
    });
    expect(first.inventory.excluded.byClassification).toEqual({ internal: 200, unspecified: 400 });
    expect(first.manifest.excluded).toHaveLength(MAX_RETAINED_EXCLUDED_DETAILS);
    expect(first.manifest.excluded[0]?.sourceId).toBe("excluded-0");
    expect(first.manifest.excluded[127]?.sourceId).toBe("excluded-127");
    expect(first.manifest.excluded[128]?.sourceId).toBe("excluded-472");
    expect(first.manifest.excluded.at(-1)?.sourceId).toBe("excluded-599");
    expect(first.manifest.included).toEqual(source.included);
    expect(first.inventory.excluded.digest).toBe(second.inventory.excluded.digest);
    expect(first.inventory.excluded.reasonDigest).toBe(second.inventory.excluded.reasonDigest);
    expect(first.storedBytes).toBeLessThan(HARD_PERSISTED_MANIFEST_BYTES);
    expect(source).toEqual(before);
  });

  it("changes the digest when excluded evidence changes", () => {
    const left = manifest();
    left.excluded = [{ kind: "history", sourceId: "left", tokens: 1, reason: "x".repeat(300_000) }];
    const right = structuredClone(left);
    right.excluded[0] = { ...right.excluded[0]!, sourceId: "right" };
    const first = buildPersistedManifestProjection(left);
    const second = buildPersistedManifestProjection(right);
    expect(first.status).toBe("stored");
    expect(second.status).toBe("stored");
    if (first.status === "stored" && second.status === "stored") {
      expect(first.inventory.excluded.digest).not.toBe(second.inventory.excluded.digest);
    }
  });

  it("skips persistence when non-excluded provenance alone exceeds the hard limit", () => {
    const source = manifest();
    source.included = [{
      kind: "current",
      sourceId: "required",
      tokens: 1,
      reason: "x".repeat(HARD_PERSISTED_MANIFEST_BYTES + 1),
    }];
    const result = buildPersistedManifestProjection(source);
    expect(result).toMatchObject({ status: "skipped-oversize" });
    if (result.status === "skipped-oversize") {
      expect(result.sourceBytes).toBeGreaterThan(HARD_PERSISTED_MANIFEST_BYTES);
      expect(result.projectedBytes).toBeGreaterThan(HARD_PERSISTED_MANIFEST_BYTES);
    }
  });
});
