import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DatabaseProtocolError,
  acquireDatabaseMaintenanceLock,
  createDatabaseClientLease,
  databaseProtocolPaths,
} from "ds4-context-core/persistence/database-client-lease";

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "ds4-client-lease-"));
  temporaryDirectories.push(directory);
  return join(directory, "context.db");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("database client lease protocol", () => {
  it("creates and releases an idempotent client lease", () => {
    const path = databasePath();
    const lease = createDatabaseClientLease(path, {
      clientId: "client-one",
      pid: 123,
      createdAt: 456,
    });
    expect(existsSync(lease.path)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(lease.path).mode & 0o777).toBe(0o600);
      expect(statSync(databaseProtocolPaths(path).clientsDirectory).mode & 0o777).toBe(0o700);
    }
    lease.release();
    lease.release();
    expect(existsSync(lease.path)).toBe(false);
  });

  it("refuses startup while a maintenance lock exists", () => {
    const path = databasePath();
    const maintenance = acquireDatabaseMaintenanceLock(path, {
      ownerId: "maintenance-one",
      pid: 100,
      createdAt: 1,
    });
    expect(() => createDatabaseClientLease(path, { clientId: "client-two", pid: 200 }))
      .toThrowError(expect.objectContaining<Partial<DatabaseProtocolError>>({ category: "maintenance-active" }));
    maintenance.release();
  });

  it("blocks maintenance for a live client and removes only verified dead leases", () => {
    const path = databasePath();
    const live = createDatabaseClientLease(path, { clientId: "live-client", pid: 111, createdAt: 1 });
    expect(() => acquireDatabaseMaintenanceLock(path, {
      ownerId: "maintenance-live",
      pid: 222,
      processProbe: () => "alive",
    })).toThrowError(expect.objectContaining<Partial<DatabaseProtocolError>>({ category: "active-database-clients" }));
    expect(existsSync(databaseProtocolPaths(path).maintenanceLock)).toBe(false);
    live.release();

    const stale = createDatabaseClientLease(path, { clientId: "stale-client", pid: 333, createdAt: 2 });
    const maintenance = acquireDatabaseMaintenanceLock(path, {
      ownerId: "maintenance-dead",
      pid: 444,
      processProbe: () => "dead",
    });
    expect(maintenance.clients).toEqual({ active: 0, staleRemoved: 1, ambiguous: 0 });
    expect(existsSync(stale.path)).toBe(false);
    maintenance.release();
  });

  it("fails closed for an ambiguous client PID and keeps its lease", () => {
    const path = databasePath();
    const client = createDatabaseClientLease(path, { clientId: "ambiguous-client", pid: 555, createdAt: 1 });
    expect(() => acquireDatabaseMaintenanceLock(path, {
      ownerId: "maintenance-ambiguous-pid",
      pid: 556,
      processProbe: () => "ambiguous",
    })).toThrowError(expect.objectContaining<Partial<DatabaseProtocolError>>({
      category: "ambiguous-database-clients",
    }));
    expect(existsSync(client.path)).toBe(true);
    expect(existsSync(databaseProtocolPaths(path).maintenanceLock)).toBe(false);
    client.release();
  });

  it("allows only one exclusive maintenance lock owner", () => {
    const path = databasePath();
    const first = acquireDatabaseMaintenanceLock(path, {
      ownerId: "maintenance-first",
      pid: 600,
      createdAt: 1,
    });
    expect(() => acquireDatabaseMaintenanceLock(path, {
      ownerId: "maintenance-second",
      pid: 601,
      createdAt: 2,
    })).toThrowError(expect.objectContaining<Partial<DatabaseProtocolError>>({
      category: "maintenance-lock-exists",
    }));
    first.release();
  });

  it("replaces a maintenance lock only when its owner PID is verified dead", () => {
    const path = databasePath();
    const stale = acquireDatabaseMaintenanceLock(path, {
      ownerId: "stale-maintenance",
      pid: 666,
      createdAt: 1,
    });
    const replacement = acquireDatabaseMaintenanceLock(path, {
      ownerId: "replacement-maintenance",
      pid: 777,
      createdAt: 2,
      replaceStaleLock: true,
      processProbe: () => "dead",
    });
    stale.release();
    expect(existsSync(replacement.path)).toBe(true);
    replacement.release();
    expect(existsSync(replacement.path)).toBe(false);
  });

  it("fails closed for a lease bound to a different database fingerprint", () => {
    const path = databasePath();
    const protocol = databaseProtocolPaths(path);
    mkdirSync(protocol.clientsDirectory, { recursive: true });
    const foreignLease = join(protocol.clientsDirectory, "foreign.json");
    writeFileSync(foreignLease, JSON.stringify({
      protocol: "ds4-context-database-client-v1",
      clientId: "foreign",
      pid: 700,
      createdAt: 1,
      databaseFingerprint: "0".repeat(64),
    }));
    expect(() => acquireDatabaseMaintenanceLock(path, {
      ownerId: "maintenance-foreign",
      pid: 701,
      processProbe: () => "dead",
    })).toThrowError(expect.objectContaining<Partial<DatabaseProtocolError>>({
      category: "ambiguous-database-clients",
    }));
    expect(existsSync(foreignLease)).toBe(true);
    expect(existsSync(protocol.maintenanceLock)).toBe(false);
  });

  it("fails closed for malformed or ambiguous leases", () => {
    const path = databasePath();
    const protocol = databaseProtocolPaths(path);
    mkdirSync(protocol.clientsDirectory, { recursive: true });
    writeFileSync(join(protocol.clientsDirectory, "malformed.json"), "not-json");
    expect(() => acquireDatabaseMaintenanceLock(path, {
      ownerId: "maintenance-ambiguous",
      pid: 555,
      processProbe: () => "dead",
    })).toThrowError(expect.objectContaining<Partial<DatabaseProtocolError>>({ category: "ambiguous-database-clients" }));
    expect(existsSync(join(protocol.clientsDirectory, "malformed.json"))).toBe(true);
    expect(existsSync(protocol.maintenanceLock)).toBe(false);
  });
});
