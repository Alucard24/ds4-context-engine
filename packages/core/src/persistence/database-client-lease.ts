import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { sha256 } from "../shared/hash.ts";

const LEASE_PROTOCOL = "ds4-context-database-client-v1";
const MAINTENANCE_PROTOCOL = "ds4-context-database-maintenance-v1";

export type ProcessProbeResult = "alive" | "dead" | "ambiguous";
export type ProcessProbe = (pid: number) => ProcessProbeResult;

export interface DatabaseProtocolPaths {
  clientsDirectory: string;
  maintenanceLock: string;
  maintenanceState: string;
}

export interface DatabaseClientLeaseOptions {
  clientId?: string;
  pid?: number;
  createdAt?: number;
  processProbe?: ProcessProbe;
}

export interface DatabaseMaintenanceLockOptions {
  ownerId?: string;
  pid?: number;
  createdAt?: number;
  processProbe?: ProcessProbe;
  replaceStaleLock?: boolean;
}

interface ClientLeaseRecord {
  protocol: typeof LEASE_PROTOCOL;
  clientId: string;
  pid: number;
  createdAt: number;
  databaseFingerprint: string;
}

interface MaintenanceLockRecord {
  protocol: typeof MAINTENANCE_PROTOCOL;
  ownerId: string;
  pid: number;
  createdAt: number;
  databaseFingerprint: string;
}

export class DatabaseProtocolError extends Error {
  constructor(readonly category: string) {
    super(`Database protocol refused the operation (category=${category})`);
    this.name = "DatabaseProtocolError";
  }
}

export interface DatabaseClientScan {
  active: number;
  staleRemoved: number;
  ambiguous: number;
}

export interface DatabaseClientLease {
  readonly clientId: string;
  readonly path: string;
  release(): void;
}

export interface DatabaseMaintenanceLock {
  readonly ownerId: string;
  readonly path: string;
  readonly clients: DatabaseClientScan;
  release(): void;
}

export function databaseProtocolPaths(databasePath: string): DatabaseProtocolPaths {
  return {
    clientsDirectory: `${databasePath}.clients`,
    maintenanceLock: `${databasePath}.maintenance.lock`,
    maintenanceState: `${databasePath}.maintenance-state.json`,
  };
}

export function databasePathFingerprint(databasePath: string): string {
  return sha256(resolve(databasePath));
}

function bestEffortChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "ENOSYS" && code !== "EPERM" && code !== "EINVAL") throw error;
  }
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EBADF" && code !== "EPERM") throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeExclusiveJson(path: string, value: unknown): void {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  bestEffortChmod(path, 0o600);
  fsyncDirectory(dirname(path));
}

function parseJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function isSafePid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(value);
}

function parseClientLease(value: unknown): ClientLeaseRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<ClientLeaseRecord>;
  if (record.protocol !== LEASE_PROTOCOL
    || !isBoundedIdentifier(record.clientId)
    || !isSafePid(record.pid)
    || !Number.isSafeInteger(record.createdAt)
    || typeof record.databaseFingerprint !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.databaseFingerprint)) return undefined;
  return record as ClientLeaseRecord;
}

function parseMaintenanceLock(value: unknown): MaintenanceLockRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<MaintenanceLockRecord>;
  if (record.protocol !== MAINTENANCE_PROTOCOL
    || !isBoundedIdentifier(record.ownerId)
    || !isSafePid(record.pid)
    || !Number.isSafeInteger(record.createdAt)
    || typeof record.databaseFingerprint !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.databaseFingerprint)) return undefined;
  return record as MaintenanceLockRecord;
}

export function probeProcess(pid: number): ProcessProbeResult {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ESRCH") return "dead";
    return "ambiguous";
  }
}

function scanClientLeases(
  databasePath: string,
  processProbe: ProcessProbe,
): DatabaseClientScan {
  const paths = databaseProtocolPaths(databasePath);
  if (!existsSync(paths.clientsDirectory)) return { active: 0, staleRemoved: 0, ambiguous: 0 };
  const fingerprint = databasePathFingerprint(databasePath);
  let active = 0;
  let staleRemoved = 0;
  let ambiguous = 0;

  for (const name of readdirSync(paths.clientsDirectory).sort()) {
    if (!name.endsWith(".json")) {
      ambiguous++;
      continue;
    }
    const path = `${paths.clientsDirectory}/${name}`;
    let record: ClientLeaseRecord | undefined;
    try {
      record = parseClientLease(parseJsonFile(path));
    } catch {
      record = undefined;
    }
    if (!record || record.databaseFingerprint !== fingerprint) {
      ambiguous++;
      continue;
    }
    const status = processProbe(record.pid);
    if (status === "alive") {
      active++;
    } else if (status === "ambiguous") {
      ambiguous++;
    } else {
      try {
        unlinkSync(path);
        staleRemoved++;
      } catch {
        ambiguous++;
      }
    }
  }
  if (staleRemoved > 0) fsyncDirectory(paths.clientsDirectory);
  return { active, staleRemoved, ambiguous };
}

export function createDatabaseClientLease(
  databasePath: string,
  options: DatabaseClientLeaseOptions = {},
): DatabaseClientLease {
  const paths = databaseProtocolPaths(databasePath);
  if (existsSync(paths.maintenanceLock)) throw new DatabaseProtocolError("maintenance-active");
  mkdirSync(paths.clientsDirectory, { recursive: true, mode: 0o700 });
  bestEffortChmod(paths.clientsDirectory, 0o700);

  const clientId = options.clientId ?? randomUUID();
  if (!isBoundedIdentifier(clientId)) throw new DatabaseProtocolError("invalid-client-id");
  const record: ClientLeaseRecord = {
    protocol: LEASE_PROTOCOL,
    clientId,
    pid: options.pid ?? process.pid,
    createdAt: options.createdAt ?? Date.now(),
    databaseFingerprint: databasePathFingerprint(databasePath),
  };
  if (!isSafePid(record.pid) || !Number.isSafeInteger(record.createdAt)) {
    throw new DatabaseProtocolError("invalid-client-metadata");
  }
  const leasePath = `${paths.clientsDirectory}/${clientId}.json`;
  try {
    writeExclusiveJson(leasePath, record);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    throw new DatabaseProtocolError(code === "EEXIST" ? "client-id-conflict" : "lease-create-failed");
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      const current = parseClientLease(parseJsonFile(leasePath));
      if (current?.clientId === clientId) {
        unlinkSync(leasePath);
        fsyncDirectory(paths.clientsDirectory);
      }
    } catch {
      // Idempotent release never removes an unverified replacement lease.
    }
  };

  if (existsSync(paths.maintenanceLock)) {
    release();
    throw new DatabaseProtocolError("maintenance-active");
  }
  return { clientId, path: leasePath, release };
}

function removeVerifiedStaleMaintenanceLock(
  databasePath: string,
  processProbe: ProcessProbe,
): void {
  const path = databaseProtocolPaths(databasePath).maintenanceLock;
  let record: MaintenanceLockRecord | undefined;
  try {
    record = parseMaintenanceLock(parseJsonFile(path));
  } catch {
    record = undefined;
  }
  if (!record
    || record.databaseFingerprint !== databasePathFingerprint(databasePath)
    || processProbe(record.pid) !== "dead") {
    throw new DatabaseProtocolError("maintenance-lock-active-or-ambiguous");
  }
  unlinkSync(path);
  fsyncDirectory(dirname(path));
}

export function acquireDatabaseMaintenanceLock(
  databasePath: string,
  options: DatabaseMaintenanceLockOptions = {},
): DatabaseMaintenanceLock {
  const paths = databaseProtocolPaths(databasePath);
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const processProbe = options.processProbe ?? probeProcess;
  if (existsSync(paths.maintenanceLock)) {
    if (!options.replaceStaleLock) throw new DatabaseProtocolError("maintenance-lock-exists");
    removeVerifiedStaleMaintenanceLock(databasePath, processProbe);
  }

  const ownerId = options.ownerId ?? randomUUID();
  if (!isBoundedIdentifier(ownerId)) throw new DatabaseProtocolError("invalid-owner-id");
  const record: MaintenanceLockRecord = {
    protocol: MAINTENANCE_PROTOCOL,
    ownerId,
    pid: options.pid ?? process.pid,
    createdAt: options.createdAt ?? Date.now(),
    databaseFingerprint: databasePathFingerprint(databasePath),
  };
  if (!isSafePid(record.pid) || !Number.isSafeInteger(record.createdAt)) {
    throw new DatabaseProtocolError("invalid-owner-metadata");
  }
  try {
    writeExclusiveJson(paths.maintenanceLock, record);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    throw new DatabaseProtocolError(code === "EEXIST" ? "maintenance-lock-exists" : "maintenance-lock-create-failed");
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      const current = parseMaintenanceLock(parseJsonFile(paths.maintenanceLock));
      if (current?.ownerId === ownerId) {
        unlinkSync(paths.maintenanceLock);
        fsyncDirectory(dirname(paths.maintenanceLock));
      }
    } catch {
      // Never unlink an unverified lock owned by another process.
    }
  };

  const clients = scanClientLeases(databasePath, processProbe);
  if (clients.active > 0 || clients.ambiguous > 0) {
    release();
    throw new DatabaseProtocolError(
      clients.active > 0 ? "active-database-clients" : "ambiguous-database-clients",
    );
  }
  return { ownerId, path: paths.maintenanceLock, clients, release };
}
