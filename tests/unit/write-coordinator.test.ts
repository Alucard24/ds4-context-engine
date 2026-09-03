import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { StructuredLogger } from "ds4-context-core/shared/logging";
import {
  isSqliteBusyError,
  SqliteWriteCoordinator,
} from "ds4-context-core/persistence/write-coordinator";

describe("SqliteWriteCoordinator", () => {
  it("rolls back and replays the complete transaction after transient contention", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE values_table(id INTEGER PRIMARY KEY) STRICT");
    let clock = 0;
    let attempts = 0;
    const writes = new SqliteWriteCoordinator(database, {
      busyTimeoutMs: 1,
      retryTimeoutMs: 100,
      monotonicNow: () => clock,
      sleep: (milliseconds) => { clock += milliseconds; },
      random: () => 0.5,
    });

    writes.transaction("test-replay", () => {
      attempts++;
      database.prepare("INSERT INTO values_table(id) VALUES (1)").run();
      if (attempts === 1) {
        const busy = Object.assign(new Error("database is locked"), { errcode: 5 });
        throw busy;
      }
    });

    expect(attempts).toBe(2);
    expect(database.prepare("SELECT count(*) AS count FROM values_table").get()).toMatchObject({ count: 1 });
    database.close();
  });

  it("recognizes extended busy/locked codes without retrying unrelated errors", () => {
    expect(isSqliteBusyError({ errcode: 517 })).toBe(true);
    expect(isSqliteBusyError({ errcode: 262 })).toBe(true);
    expect(isSqliteBusyError(new Error("validation failed"))).toBe(false);

    const database = new DatabaseSync(":memory:");
    let sleeps = 0;
    const writes = new SqliteWriteCoordinator(database, {
      busyTimeoutMs: 1,
      retryTimeoutMs: 100,
      sleep: () => { sleeps++; },
    });
    expect(() => writes.execute("validation", () => { throw new Error("validation failed"); }))
      .toThrow("validation failed");
    expect(sleeps).toBe(0);
    database.close();
  });

  it("reports exhausted lock retries with the operation name and metadata only", () => {
    const database = new DatabaseSync(":memory:");
    const lines: string[] = [];
    let clock = 0;
    let attempts = 0;
    const writes = new SqliteWriteCoordinator(database, {
      busyTimeoutMs: 1,
      retryTimeoutMs: 12,
      monotonicNow: () => clock,
      sleep: (milliseconds) => { clock += milliseconds; },
      random: () => 0.5,
      logger: new StructuredLogger({
        level: "debug",
        sink: (line) => lines.push(line),
        now: () => new Date("2026-09-03T00:00:00.000Z"),
      }),
    });

    expect(() => writes.execute("context-manifest-save", () => {
      attempts++;
      throw Object.assign(new Error("database is locked PRIVATE-SQL-DETAIL"), { errcode: 5 });
    })).toThrow(/SQLite operation context-manifest-save remained locked/u);

    expect(attempts).toBe(3);
    expect(lines.join("\n")).not.toContain("PRIVATE-SQL-DETAIL");
    expect(lines.map((line) => JSON.parse(line)).at(-1)).toMatchObject({
      level: "warn",
      event: "database.write_lock_timeout",
      metadata: {
        operation: "context-manifest-save",
        category: "lock-timeout",
        attempts: 3,
        sqliteCode: 5,
      },
    });
    database.close();
  });
});
