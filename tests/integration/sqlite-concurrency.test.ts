import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "ds4-context-core/persistence/migrations";

const temporaryDirectories: string[] = [];
const workerPath = fileURLToPath(new URL("../fixtures/sqlite-concurrency-worker.mjs", import.meta.url));

interface RunningWorker {
  child: ChildProcess;
  ready: Promise<void>;
  done: Promise<void>;
}

function startWorker(path: string, workerId: number, entryCount: number, manifestCount: number): RunningWorker {
  const child = fork(workerPath, [path, String(workerId), String(entryCount), String(manifestCount)], {
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });

  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let doneResolve: (() => void) | undefined;
  let doneReject: ((error: Error) => void) | undefined;
  const done = new Promise<void>((resolve, reject) => {
    doneResolve = resolve;
    doneReject = reject;
  });

  child.on("message", (message: unknown) => {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    if (message.type === "ready") readyResolve?.();
    if (message.type === "done") doneResolve?.();
    if (message.type === "error") {
      const detail = "message" in message ? String(message.message) : "unknown worker error";
      doneReject?.(new Error(detail));
    }
  });
  child.on("error", (error) => {
    readyReject?.(error);
    doneReject?.(error);
  });
  child.on("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`SQLite concurrency worker exited with ${String(code)}: ${stderr}`);
      readyReject?.(error);
      doneReject?.(error);
    }
  });
  return { child, ready, done };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("shared SQLite concurrency", () => {
  it("supports simultaneous migration and sustained writes from three Pi processes", { timeout: 30_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), "ds4-sqlite-concurrency-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "context.db");
    const workerCount = 3;
    const entryCount = 300;
    const manifestCount = 120;
    const workers = Array.from(
      { length: workerCount },
      (_, index) => startWorker(path, index, entryCount, manifestCount),
    );

    try {
      await Promise.all(workers.map((worker) => worker.ready));
      for (const worker of workers) worker.child.send({ type: "start" });
      await Promise.all(workers.map((worker) => worker.done));
      await Promise.all(workers.map((worker) => new Promise<void>((resolve) => {
        if (worker.child.exitCode !== null) resolve();
        else worker.child.once("exit", () => resolve());
      })));
    } finally {
      for (const worker of workers) {
        if (worker.child.exitCode === null) worker.child.kill();
      }
    }

    const database = new DatabaseSync(path, { readOnly: true });
    try {
      expect(database.prepare("PRAGMA quick_check").get()).toMatchObject({ quick_check: "ok" });
      expect(database.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: CURRENT_SCHEMA_VERSION });
      expect(database.prepare("SELECT count(*) AS count FROM schema_migrations").get())
        .toMatchObject({ count: CURRENT_SCHEMA_VERSION });
      expect(database.prepare("SELECT count(*) AS count FROM sessions").get())
        .toMatchObject({ count: workerCount });
      expect(database.prepare("SELECT count(*) AS count FROM entries").get())
        .toMatchObject({ count: workerCount * entryCount });
      expect(database.prepare("SELECT count(*) AS count FROM context_manifests").get())
        .toMatchObject({ count: workerCount * manifestCount });
    } finally {
      database.close();
    }
  });
});
