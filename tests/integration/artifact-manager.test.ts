import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactManager } from "ds4-context-core/artifacts/artifact-manager";
import { FileArtifactStore } from "ds4-context-core/artifacts/artifact-store";
import { DEFAULT_CONFIG, type ArtifactConfig } from "ds4-context-core/config/config";
import { ContextDatabase } from "ds4-context-core/persistence/sqlite";
import { PrivacyPolicyEngine } from "ds4-context-core/privacy/privacy-policy";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function setup(entryIds: string[], overrides: Partial<ArtifactConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), "ds4-artifact-manager-"));
  temporaryDirectories.push(root);
  const database = ContextDatabase.open(":memory:");
  const sessionId = "artifact-session";
  const sessionFile = join(root, "session.jsonl");
  const identity = { sessionId, sessionFile, projectPath: root, indexedAt: 1 };
  database.sessionIndex.rebuild(
    identity,
    entryIds.map((entryId, index) => ({
      entryKey: `${sessionId}:${entryId}`,
      entryId,
      sessionId,
      parentId: index === 0 ? null : entryIds[index - 1] ?? null,
      entryType: "message",
      role: "toolResult",
      createdAt: index + 1,
      contentHash: `hash-${entryId}`,
      searchableText: entryId,
      tokenEstimate: 1,
      indexedAt: 1,
    })),
    {
      sessionId,
      sessionFile,
      headerHash: "header",
      fileSize: 1,
      fileMtimeMs: 1,
      checkpointOffset: 1,
      checkpointHashStart: 0,
      checkpointHash: "checkpoint",
      malformedLines: 0,
      indexedAt: 1,
    },
  );
  let clock = 100;
  let ids = 0;
  const store = new FileArtifactStore(join(root, "objects"), () => clock++, () => `temp-${++ids}`);
  const config = {
    ...DEFAULT_CONFIG.artifacts,
    maxInlineToolResultChars: 2_000,
    excerptChars: 600,
    maxArtifactBytes: 1_000_000,
    maxSearchBytes: 1_000_000,
    ...overrides,
  };
  const manager = new ArtifactManager(store, database.artifacts, config, sessionId, () => clock++);
  return { root, database, sessionId, store, manager };
}

function result(id: string, text: string, isError = false) {
  return {
    role: "toolResult" as const,
    toolCallId: id,
    toolName: "bash",
    content: [
      { type: "text", text },
      { type: "image", data: "image-data", mimeType: "image/png" },
    ],
    details: { exitCode: isError ? 1 : 0 },
    isError,
    timestamp: 10,
  };
}

describe("ArtifactManager", () => {
  it("adapts below the static threshold, preserves provenance and reconstructs the same searchable artifact", () => {
    const fixture = setup(["adaptive-result"], { adaptiveBudget: true, maxInlineToolResultChars: 12000 });
    try {
      const message = result("adaptive-call", "evidence ".repeat(500) + "ADAPTIVE_NEEDLE");
      const original = structuredClone(message);
      expect(fixture.manager.transform([message], ["adaptive-result"]).offloadedCount).toBe(0);
      const transformed = fixture.manager.transform([message], ["adaptive-result"], ["internal"], { inputTokens: 0, fixedTokens: 0 });
      expect(transformed.offloadedCount).toBe(1);
      expect(message).toEqual(original);
      expect(transformed.artifacts[0]).toMatchObject({ sourceEntryId: "adaptive-result", classification: "internal" });
      expect(transformed.messages[0]!.content[0]!.text!.length).toBeLessThanOrEqual(1600);
      expect(transformed.messages[0]!.content[1]).toEqual(message.content[1]);
      const rebuilt = fixture.manager.reconcile([message], ["adaptive-result"], ["internal"]);
      expect(rebuilt.artifactIds).toEqual(transformed.artifactIds);
      const search = fixture.manager.search(transformed.artifactIds[0]!, "ADAPTIVE_NEEDLE", 8, new Set(["adaptive-result"]));
      expect(search.text).toContain("ADAPTIVE_NEEDLE");
      expect(search.classification).toBe("internal");
      expect(fixture.manager.transform([message], [undefined], [], { inputTokens: 0, fixedTokens: 0 }).failedCount).toBe(1);
    } finally { fixture.database.close(); }
  });

  it("offloads large multi-tool results while preserving tool identity and safe excerpts", () => {
    const fixture = setup(["result-a", "result-b"]);
    const secret = ["ghp", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_");
    const firstText = `head\n${"normal output\n".repeat(300)}needle-one\ntail`;
    const secondText = `ERROR build failed password="super-secret-password"\n${secret}\n${"trace\n".repeat(500)}`;
    const messages = [result("call-a", firstText), result("call-b", secondText, true)];

    const transformed = fixture.manager.transform(messages, ["result-a", "result-b"]);

    expect(transformed.offloadedCount).toBe(2);
    expect(transformed.estimatedTokensSaved).toBeGreaterThan(0);
    expect(transformed.messages[0]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-a",
      toolName: "bash",
      isError: false,
      details: { exitCode: 0 },
    });
    expect(transformed.messages[1]).toMatchObject({ toolCallId: "call-b", isError: true });
    const condensed = JSON.stringify(transformed.messages);
    expect(condensed).toContain("DS4 LARGE TOOL OUTPUT OFFLOADED");
    expect(condensed).toContain("Errors/warnings JSON");
    expect(condensed).toContain("image-data");
    for (const message of transformed.messages) {
      const reference = message.content.find((block) => block.type === "text");
      const referenceText = reference && "text" in reference && typeof reference.text === "string"
        ? reference.text
        : "";
      expect(referenceText.length).toBeLessThanOrEqual(2_000);
    }
    expect(condensed).not.toContain("super-secret-password");
    expect(condensed).not.toContain(secret);
    expect(fixture.database.artifacts.stats(fixture.sessionId)).toMatchObject({ objects: 2, references: 2 });
    expect(transformed.artifacts.map((artifact) => artifact.sourceEntryId)).toEqual(["result-a", "result-b"]);
    const full = fixture.store.verify(transformed.artifacts[1]?.sha256 ?? "");
    expect(full.status === "available" ? full.content.toString("utf8") : "").toContain(secret);
    fixture.database.close();
  });

  it("deduplicates identical bytes while keeping source-specific references", () => {
    const fixture = setup(["result-a", "result-b"]);
    const text = `${"same output\n".repeat(400)}shared-needle`;

    const transformed = fixture.manager.transform(
      [result("call-a", text), result("call-b", text)],
      ["result-a", "result-b"],
    );

    expect(new Set(transformed.artifacts.map((artifact) => artifact.sha256)).size).toBe(1);
    expect(new Set(transformed.artifacts.map((artifact) => artifact.artifactId)).size).toBe(2);
    expect(fixture.database.artifacts.stats(fixture.sessionId)).toEqual({
      objects: 1,
      references: 2,
      bytes: Buffer.byteLength(text),
      missing: 0,
      corrupt: 0,
    });
    fixture.database.close();
  });

  it("searches only active-branch text artifacts and redacts returned secrets", () => {
    const fixture = setup(["result-a"]);
    const secret = ["glpat", "abcdefghijklmnopqrstuvwxyz1234567890"].join("-");
    const text = `${"prefix\n".repeat(400)}SEARCH_NEEDLE token="${secret}" suffix`;
    const transformed = fixture.manager.transform(
      [result("call-a", text)],
      ["result-a"],
      ["local-only"],
    );
    const artifactId = transformed.artifacts[0]?.artifactId ?? "";

    const found = fixture.manager.search(artifactId, "SEARCH_NEEDLE", 4, new Set(["result-a"]));
    expect(found.matches).toBe(1);
    expect(found.classification).toBe("local-only");
    expect(transformed.artifacts[0]?.classification).toBe("local-only");
    expect(fixture.manager.diagnostics().references[0]?.classification).toBe("local-only");
    expect(found.text).toContain("SEARCH_NEEDLE");
    expect(found.text).not.toContain(secret);
    const privacy = new PrivacyPolicyEngine({
      ...structuredClone(DEFAULT_CONFIG.privacy),
      enabled: true,
      localProviders: [],
    }).sanitizeText(found.text, "remote", found.classification);
    expect(privacy.value).not.toContain("SEARCH_NEEDLE");
    expect(found.text.length).toBeLessThanOrEqual(2_000);
    expect(() => fixture.manager.search(artifactId, "SEARCH_NEEDLE", 4, new Set(["sibling"])))
      .toThrow("active session branch");
    fixture.database.close();
  });

  it("derives classification from legacy artifact bytes when metadata is absent", () => {
    const fixture = setup(["result-a"]);
    const text = `${"prefix\n".repeat(400)}[ds4:local-only]LEGACY-LOCAL-NEEDLE[/ds4:local-only]`;
    const transformed = fixture.manager.transform([result("call-a", text)], ["result-a"]);
    const found = fixture.manager.search(
      transformed.artifacts[0]?.artifactId ?? "",
      "LEGACY-LOCAL-NEEDLE",
      2,
      new Set(["result-a"]),
    );

    expect(transformed.artifacts[0]?.classification).toBeUndefined();
    expect(found.classification).toBe("local-only");
    fixture.database.close();
  });

  it("fails open for oversized or source-less output", () => {
    const fixture = setup(["result-a"], { maxArtifactBytes: 100 });
    const message = result("call-a", "x".repeat(3_000));

    const oversized = fixture.manager.transform([message], ["result-a"]);
    const sourceLess = fixture.manager.transform([message], [undefined]);

    expect(oversized.messages).toEqual([message]);
    expect(oversized.failedCount).toBe(1);
    expect(sourceLess.messages).toEqual([message]);
    expect(sourceLess.failedCount).toBe(1);
    expect(fixture.database.artifacts.stats(fixture.sessionId).references).toBe(0);
    fixture.database.close();
  });

  it("rolls back object metadata and preserves provider input when provenance violates foreign keys", () => {
    const fixture = setup(["result-a"]);
    const message = result("call-a", "transactional output\n".repeat(300));

    const transformed = fixture.manager.transform([message], ["missing-entry"]);

    expect(transformed.messages).toEqual([message]);
    expect(transformed.failedCount).toBe(1);
    expect(fixture.database.artifacts.stats(fixture.sessionId)).toEqual({
      objects: 0,
      references: 0,
      bytes: 0,
      missing: 0,
      corrupt: 0,
    });
    fixture.database.close();
  });

  it("marks missing and corrupt objects and rejects binary search", () => {
    const fixture = setup(["result-a", "result-b"]);
    const text = `${"searchable\n".repeat(400)}needle`;
    const binary = `\0${"binary".repeat(500)}`;
    const transformed = fixture.manager.transform(
      [result("call-a", text), result("call-b", binary)],
      ["result-a", "result-b"],
    );
    const textArtifact = transformed.artifacts[0];
    const binaryArtifact = transformed.artifacts[1];
    if (!textArtifact || !binaryArtifact) throw new Error("Expected artifacts");
    expect(binaryArtifact.mimeType).toBe("application/octet-stream");
    expect(JSON.stringify(transformed.messages[1])).not.toContain("binarybinarybinary");

    fixture.store.remove(textArtifact.sha256);
    expect(() => fixture.manager.search(textArtifact.artifactId, "needle", 2, new Set(["result-a"])))
      .toThrow("missing");
    expect(() => fixture.manager.search(binaryArtifact.artifactId, "binary", 2, new Set(["result-b"])))
      .toThrow("not text-searchable");
    expect(fixture.database.artifacts.stats(fixture.sessionId).missing).toBe(1);
    fixture.database.close();
  });

  it("reconciles stale references and garbage-collects unreferenced objects", () => {
    const fixture = setup(["result-a", "result-b"]);
    const first = result("call-a", `${"first\n".repeat(400)}needle-a`);
    const second = result("call-b", `${"second\n".repeat(400)}needle-b`);
    const initial = fixture.manager.transform([first, second], ["result-a", "result-b"]);
    const removedObject = initial.artifacts[1];
    if (!removedObject) throw new Error("Expected second artifact");

    fixture.manager.reconcile([first, second], ["result-a", undefined]);
    expect(fixture.database.artifacts.stats(fixture.sessionId).references).toBe(2);
    expect(fixture.store.verify(removedObject.sha256).status).toBe("available");

    fixture.manager.reconcile([first], ["result-a"]);

    expect(fixture.database.artifacts.stats(fixture.sessionId).references).toBe(1);
    expect(fixture.store.verify(removedObject.sha256).status).toBe("missing");
    fixture.database.close();
  });
});
