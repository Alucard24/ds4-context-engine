import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ContextDatabase } from "ds4-context-core/persistence/sqlite";
import {
  STORAGE_MANIFEST_PAYLOAD_WARNING_BYTES,
  unavailableStorageDiagnostics,
} from "ds4-context-core/persistence/storage-diagnostics";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function pathForTest(): string {
  const directory = mkdtempSync(join(tmpdir(), "ds4-storage-diagnostics-"));
  temporaryDirectories.push(directory);
  return join(directory, "context.db");
}

describe("storage diagnostics", () => {
  it("reports bounded metadata without writing to the database", () => {
    const path = pathForTest();
    const database = ContextDatabase.open(path);
    database.upsertSession({ sessionId: "session", sessionFile: "session.jsonl", indexedAt: 1 });
    const observer = new DatabaseSync(path, { readOnly: true });
    const before = observer.prepare("PRAGMA data_version").get();

    const diagnostics = database.storageDiagnostics("/missing-project");
    const after = observer.prepare("PRAGMA data_version").get();

    expect(diagnostics).toMatchObject({
      status: "ok",
      schemaVersion: 15,
      journalMode: "wal",
      manifests: { rows: 0, retainedLimit: 128 },
      calibration: { rows: 0, retainedPerProfile: 200 },
      sessions: 1,
      retention: { manifestExcess: 0, calibrationExcess: 0, converged: true },
      maintenance: { recommended: false, reasons: [] },
    });
    expect(after).toEqual(before);
    observer.close();
    database.close();
  });

  it("warns when manifest retention has not converged", () => {
    const path = pathForTest();
    const database = ContextDatabase.open(path);
    database.upsertSession({ sessionId: "session", sessionFile: "session.jsonl", indexedAt: 1 });
    database.close();

    const raw = new DatabaseSync(path);
    const insert = raw.prepare(`
      INSERT INTO context_manifests(
        manifest_id, session_id, created_at, provider, model,
        estimated_tokens, manifest_json, policy_version, planner_version
      ) VALUES (?, 'session', ?, 'test', 'model', 1, ?, 'policy', 'planner')
    `);
    for (let index = 0; index < 129; index++) {
      insert.run(`manifest-${index}`, index, JSON.stringify({ id: `manifest-${index}` }));
    }
    raw.close();

    const reopened = ContextDatabase.open(path);
    const diagnostics = reopened.storageDiagnostics();
    expect(reopened.health().ok).toBe(true);
    expect(diagnostics.status).toBe("warning");
    expect(diagnostics.retention).toMatchObject({ manifestExcess: 1, converged: false });
    expect(diagnostics.maintenance.reasons).toContain("manifest-retention-excess");
    expect(diagnostics.manifests.serializedBytes).toBeLessThan(STORAGE_MANIFEST_PAYLOAD_WARNING_BYTES);
    reopened.close();
  });

  it("provides a fixed unavailable shape", () => {
    expect(unavailableStorageDiagnostics()).toMatchObject({
      status: "unavailable",
      retention: { converged: false },
      maintenance: { recommended: false, reasons: ["storage-diagnostics-unavailable"] },
    });
  });
});
