import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertRuntimeAdapterConformance,
  createRuntimeAdapterConformanceFixture,
  runRuntimeAdapterConformance,
  type RuntimeAdapterConformanceFactory,
} from "ds4-context-core/adapter/conformance";
import {
  JsonlReferenceRuntimeAdapter,
  appendReferenceHistoryMessage,
  createReferenceHistory,
} from "../../packages/reference-adapter/src/index.ts";
import { describe, expect, it } from "vitest";

function referenceFactory(): RuntimeAdapterConformanceFactory {
  return {
    name: "jsonl-reference-adapter",
    async create(fixture, transport) {
      const root = mkdtempSync(join(tmpdir(), "ds4-reference-adapter-"));
      const projectRoot = join(root, "project");
      const historyFile = join(root, "state", "session.jsonl");
      mkdirSync(projectRoot, { recursive: true });
      createReferenceHistory({
        historyFile,
        runtimeId: fixture.runtimeId,
        sessionId: fixture.sessionId,
        projectRoot,
        messages: fixture.messages,
      });
      return {
        adapter: new JsonlReferenceRuntimeAdapter({
          historyFile,
          runtimeId: fixture.runtimeId,
          projectRoot,
          model: fixture.model,
          transport,
        }),
        expectedProjectRoot: realpathSync.native(projectRoot),
        cleanup: () => rmSync(root, { recursive: true, force: true }),
      };
    },
  };
}

describe("JSONL reference runtime adapter", () => {
  it("passes the reusable runtime adapter conformance kit", async () => {
    const report = await runRuntimeAdapterConformance(referenceFactory());

    expect(report.passed).toBe(true);
    expect(report.cases).toHaveLength(7);
    expect(report.cases.every((item) => item.passed)).toBe(true);
    expect(JSON.stringify(report)).not.toContain("DS4_CONFORMANCE_PRIVATE_VALUE");
    expect(JSON.stringify(report)).not.toContain("sk-conformance-credential");
    expect(() => assertRuntimeAdapterConformance(report)).not.toThrow();
  });

  it("rejects truncated canonical history without rewriting it", async () => {
    const root = mkdtempSync(join(tmpdir(), "ds4-reference-corrupt-"));
    try {
      const projectRoot = join(root, "project");
      const historyFile = join(root, "session.jsonl");
      mkdirSync(projectRoot, { recursive: true });
      const fixture = createRuntimeAdapterConformanceFixture();
      createReferenceHistory({
        historyFile,
        runtimeId: fixture.runtimeId,
        sessionId: fixture.sessionId,
        projectRoot,
        messages: fixture.messages,
      });
      const raw = readFileSync(historyFile, "utf8");
      writeFileSync(historyFile, raw.slice(0, -1), "utf8");
      const adapter = new JsonlReferenceRuntimeAdapter({
        historyFile,
        runtimeId: fixture.runtimeId,
        projectRoot,
        model: fixture.model,
        transport: async () => ({ content: "unused" }),
      });

      await expect(adapter.snapshotHistory()).rejects.toThrow("canonical history is unavailable");
      expect(adapter.diagnostics()).toContainEqual(expect.objectContaining({
        code: "canonical-history-read-failed",
      }));
      expect(readFileSync(historyFile, "utf8")).toBe(raw.slice(0, -1));
      await adapter.shutdown();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("observes canonical appends and reproduces them on rebuild", async () => {
    const root = mkdtempSync(join(tmpdir(), "ds4-reference-append-"));
    try {
      const projectRoot = join(root, "project");
      const historyFile = join(root, "session.jsonl");
      mkdirSync(projectRoot, { recursive: true });
      const fixture = createRuntimeAdapterConformanceFixture();
      createReferenceHistory({
        historyFile,
        runtimeId: fixture.runtimeId,
        sessionId: fixture.sessionId,
        projectRoot,
        messages: fixture.messages,
      });
      const adapter = new JsonlReferenceRuntimeAdapter({
        historyFile,
        runtimeId: fixture.runtimeId,
        projectRoot,
        model: fixture.model,
        transport: async () => ({ content: "unused" }),
      });
      const initial = await adapter.snapshotHistory();
      appendReferenceHistoryMessage(historyFile, {
        id: `${fixture.sessionId}:entry-appended`,
        sourceEntryId: "entry-appended",
        role: "user",
        blocks: [{ type: "text", text: "Canonical append" }],
        provenance: {
          source: "runtime-session",
          runtimeId: fixture.runtimeId,
          sessionId: fixture.sessionId,
          entryId: "entry-appended",
        },
        flags: {},
      });

      const appended = await adapter.snapshotHistory();
      const rebuilt = await adapter.rebuildDerivedState();
      expect(appended.revision).not.toBe(initial.revision);
      expect(appended.messages.at(-1)?.sourceEntryId).toBe("entry-appended");
      expect(rebuilt).toEqual(appended);
      expect(() => appendReferenceHistoryMessage(historyFile, appended.messages.at(-1)!))
        .toThrow("history-message-id-duplicate");
      await adapter.shutdown();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
