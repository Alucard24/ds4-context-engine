import { ContextDatabase } from "ds4-context-core/persistence/sqlite";

const [databasePath, workerId, entryCountValue, manifestCountValue] = process.argv.slice(2);
const entryCount = Number(entryCountValue);
const manifestCount = Number(manifestCountValue);

function run() {
  const database = ContextDatabase.open(databasePath, {
    busyTimeoutMs: 2,
    writeRetryTimeoutMs: 15_000,
  });
  try {
    const sessionId = `concurrent-session-${workerId}`;
    const indexedAt = 1_000 + Number(workerId);
    const identity = {
      sessionId,
      sessionFile: `/tmp/${sessionId}.jsonl`,
      projectPath: "/shared/project",
      indexedAt,
    };
    const entries = Array.from({ length: entryCount }, (_, index) => ({
      entryKey: `${sessionId}:entry-${index}`,
      entryId: `entry-${index}`,
      sessionId,
      parentId: index === 0 ? null : `entry-${index - 1}`,
      entryType: "message",
      role: index % 2 === 0 ? "user" : "assistant",
      createdAt: indexedAt + index,
      contentHash: `${workerId}-${index}`,
      searchableText: `worker ${workerId} concurrent entry ${index}`,
      tokenEstimate: 8,
      indexedAt,
    }));
    database.sessionIndex.rebuild(identity, entries, {
      sessionId,
      sessionFile: identity.sessionFile,
      headerHash: `header-${workerId}`,
      fileSize: entryCount * 100,
      fileMtimeMs: indexedAt,
      checkpointOffset: entryCount * 100,
      checkpointHashStart: 0,
      checkpointHash: `checkpoint-${workerId}`,
      malformedLines: 0,
      indexedAt,
    });

    for (let index = 0; index < manifestCount; index++) {
      const manifestId = `${sessionId}-manifest-${index}`;
      database.manifests.save({
        id: manifestId,
        sessionId,
        createdAt: indexedAt + index,
        provider: "test",
        model: "concurrency",
        estimatedInputTokens: 100 + index,
        promptHash: `${workerId}-${index}`,
        policyVersion: "test-v1",
        plannerVersion: "test-v1",
        contextWindow: 10_000,
        outputReserve: 1_000,
        hardInputLimit: 9_000,
        targetInputTokens: 8_000,
      });
      database.manifests.recordProviderUsage(manifestId, {
        inputTokens: 100 + index,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }, indexedAt + manifestCount + index, "chars-v1");
      if (index % 10 === 0) {
        database.projectKnowledge.saveState({
          projectPath: "/shared/project",
          dirty: true,
          changedFiles: [`worker-${workerId}-${index}.ts`],
          indexedAt: indexedAt + index,
        });
      }
    }
    database.storageDiagnostics("/shared/project");
  } finally {
    database.close();
  }
}

if (process.send) process.send({ type: "ready" });
process.once("message", (message) => {
  if (!message || message.type !== "start") return;
  try {
    run();
    if (process.send) process.send({ type: "done" });
  } catch (error) {
    if (process.send) {
      process.send({
        type: "error",
        message: error instanceof Error ? error.stack ?? error.message : String(error),
      });
    }
    process.exitCode = 1;
  }
});
