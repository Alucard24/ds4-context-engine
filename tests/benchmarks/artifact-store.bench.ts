import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, bench } from "vitest";
import { ArtifactManager } from "ds4-context-core/artifacts/artifact-manager";
import { FileArtifactStore } from "ds4-context-core/artifacts/artifact-store";
import { DEFAULT_CONFIG } from "ds4-context-core/config/config";
import { ContextDatabase } from "ds4-context-core/persistence/sqlite";

let root = "";
let database: ContextDatabase;
let manager: ArtifactManager;
let message: Record<string, unknown>;
let artifactId = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ds4-artifact-bench-"));
  database = ContextDatabase.open(":memory:");
  const sessionId = "artifact-bench";
  const sessionFile = join(root, "session.jsonl");
  database.sessionIndex.rebuild(
    { sessionId, sessionFile, projectPath: root, indexedAt: 1 },
    [{
      entryKey: `${sessionId}:result-1`,
      entryId: "result-1",
      sessionId,
      parentId: null,
      entryType: "message",
      role: "toolResult",
      createdAt: 1,
      contentHash: "hash",
      searchableText: "large result",
      tokenEstimate: 1,
      indexedAt: 1,
    }],
    {
      sessionId,
      sessionFile,
      headerHash: "header",
      fileSize: 1,
      fileMtimeMs: 1,
      checkpointOffset: 1,
      checkpointHashStart: 0,
      malformedLines: 0,
      indexedAt: 1,
    },
  );
  manager = new ArtifactManager(
    new FileArtifactStore(join(root, "objects")),
    database.artifacts,
    DEFAULT_CONFIG.artifacts,
    sessionId,
  );
  const text = `${"normal build output line\n".repeat(218_000)}\nBENCHMARK_NEEDLE failure at src/Target.ts:42\n`;
  message = {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: true,
    timestamp: 1,
  };
  artifactId = manager.transform([message], ["result-1"]).artifacts[0]?.artifactId ?? "";
});

afterAll(() => {
  database.close();
  rmSync(root, { recursive: true, force: true });
});

bench("deduplicated 5 MB artifact condensation", () => {
  manager.transform([message], ["result-1"]);
}, { time: 1_000, warmupTime: 250 });

bench("literal search in 5 MB artifact", () => {
  manager.search(artifactId, "BENCHMARK_NEEDLE", 4, new Set(["result-1"]));
}, { time: 1_000, warmupTime: 250 });
