import { createHash, type Hash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import {
  DatabaseProtocolError,
  acquireDatabaseMaintenanceLock,
  databasePathFingerprint,
  databaseProtocolPaths,
  type DatabaseMaintenanceLock,
  type ProcessProbe,
} from "./database-client-lease.ts";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, listAppliedMigrations } from "./migrations.ts";
import type { ManifestMaintenanceResult } from "./repositories/context-manifest-repository.ts";
import { ContextDatabase } from "./sqlite.ts";
import {
  collectStorageDiagnostics,
  type StorageDiagnostics,
} from "./storage-diagnostics.ts";
import { SqliteWriteCoordinator } from "./write-coordinator.ts";
import { HARD_PERSISTED_MANIFEST_BYTES } from "../manifest/context-manifest-storage.ts";
import { sha256 } from "../shared/hash.ts";
import { stableStringify } from "../shared/stable-json.ts";

const STATE_PROTOCOL = "ds4-context-storage-maintenance-state-v1";
const SAFETY_MARGIN_BYTES = 256 * 1024 * 1024;

export type StorageMaintenancePhase =
  | "candidate-validated"
  | "source-retired"
  | "candidate-installed"
  | "completed";

export interface StorageMaintenancePaths {
  source: string;
  backup: string;
  work: string;
  candidate: string;
  retired: string;
  state: string;
  maintenanceLock: string;
  clientsDirectory: string;
}

export interface StorageMaintenanceState {
  protocol: typeof STATE_PROTOCOL;
  phase: StorageMaintenancePhase;
  databaseFingerprint: string;
  source: string;
  candidate: string;
  backup: string;
  work: string;
  retired: string;
}

export interface StorageInspectResult {
  databasePath: string;
  diagnostics: StorageDiagnostics;
  quickCheck: "ok";
  foreignKeyViolations: 0;
  schemaVersion: number;
  manifestsToPrune: number;
  calibrationToPrune: number;
  availableBytes: number;
  requiredBytes: number;
  paths: StorageMaintenancePaths;
}

export interface StorageCompactionResult {
  databasePath: string;
  backupPath: string;
  beforeBytes: number;
  afterBytes: number;
  maintenance: ManifestMaintenanceResult;
  diagnostics: StorageDiagnostics;
}

export interface StorageRecoveryResult {
  databasePath: string;
  action: "source-restored" | "candidate-kept" | "staging-cleared";
}

export type StorageMaintenanceHook =
  | "before-backup"
  | "backup-created"
  | "before-work-copy"
  | "before-work-rewrite"
  | "work-rewritten"
  | "before-vacuum"
  | "before-candidate-validation"
  | "candidate-validated"
  | "before-source-rename"
  | "source-retired"
  | "before-candidate-rename"
  | "candidate-installed"
  | "before-final-validation"
  | "completed"
  | "before-cleanup";

export interface StorageMaintenanceOptions {
  now?: number;
  processProbe?: ProcessProbe;
  availableBytes?: number;
  /** Deterministic fault-injection seam used by temporary-database tests. */
  onPhase?: (phase: StorageMaintenanceHook) => void;
}

interface ValidationSnapshot {
  diagnostics: StorageDiagnostics;
  protectedCounts: Record<string, number>;
  protectedDigests: Record<string, string>;
  sourceExclusions: number;
  sourceExclusionDigest: string;
}

const PROTECTED_TABLES = [
  "sessions",
  "entries",
  "entries_fts",
  "summaries",
  "summary_sources",
  "summary_edges",
  "memory_items",
  "memory_sources",
  "memory_fts",
  "pins",
  "memory_mutations",
  "pin_mutations",
  "artifacts",
  "artifact_objects",
  "project_states",
  "project_files",
  "project_snippets",
  "project_snippets_fts",
  "project_memory_sessions",
  "project_memory_source_exclusions",
  "derived_embeddings",
  "context_quality_samples",
  "resource_leases",
  "session_index_state",
] as const;

export class StorageMaintenanceError extends Error {
  constructor(readonly category: string, readonly stage: string) {
    super(`Storage maintenance failed (stage=${stage}; category=${category})`);
    this.name = "StorageMaintenanceError";
  }
}

export function storageMaintenancePaths(databasePath: string): StorageMaintenancePaths {
  const source = resolve(databasePath);
  const protocol = databaseProtocolPaths(source);
  return {
    source,
    backup: `${source}.precompact.bak`,
    work: `${source}.maintenance-work`,
    candidate: `${source}.compact-ready`,
    retired: `${source}.swap-old`,
    state: protocol.maintenanceState,
    maintenanceLock: protocol.maintenanceLock,
    clientsDirectory: protocol.clientsDirectory,
  };
}

function maintenanceError(error: unknown, category: string, stage: string): StorageMaintenanceError {
  return error instanceof StorageMaintenanceError
    ? error
    : new StorageMaintenanceError(category, stage);
}

function bestEffortChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "ENOSYS" && code !== "EPERM" && code !== "EINVAL") throw error;
  }
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
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

function reservePrivateFile(path: string): void {
  const descriptor = openSync(path, "wx", 0o600);
  closeSync(descriptor);
  bestEffortChmod(path, 0o600);
  fsyncDirectory(dirname(path));
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") throw error;
  }
}

function renameIfExists(source: string, target: string): void {
  if (existsSync(source)) renameSync(source, target);
}

function requireRegularDatabase(databasePath: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(resolve(databasePath));
  } catch {
    throw new StorageMaintenanceError("database-not-found", "path-preflight");
  }
  let stats;
  try {
    stats = lstatSync(canonical);
  } catch {
    throw new StorageMaintenanceError("database-not-readable", "path-preflight");
  }
  if (!stats.isFile()) throw new StorageMaintenanceError("database-not-regular-file", "path-preflight");
  return canonical;
}

function availableFilesystemBytes(path: string): number {
  const stats = statfsSync(dirname(path));
  const value = Number(stats.bavail) * Number(stats.bsize);
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
}

function requiredFilesystemBytes(path: string): number {
  const sourceBytes = statSync(path).size + (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0);
  const safety = Math.max(SAFETY_MARGIN_BYTES, Math.ceil(sourceBytes * 0.1));
  const required = sourceBytes * 3 + safety;
  return Number.isSafeInteger(required) ? required : Number.MAX_SAFE_INTEGER;
}

function migrationChecksum(version: number, name: string, sql: string): string {
  return sha256(`${version}\n${name}\n${sql}`);
}

function validateMigrations(database: DatabaseSync): void {
  const applied = listAppliedMigrations(database);
  if (applied.length !== MIGRATIONS.length) {
    throw new StorageMaintenanceError("migration-count-mismatch", "database-validation");
  }
  for (const migration of MIGRATIONS) {
    const actual = applied.find((item) => item.version === migration.version);
    if (!actual
      || actual.name !== migration.name
      || actual.checksum !== migrationChecksum(migration.version, migration.name, migration.sql)) {
      throw new StorageMaintenanceError("migration-checksum-mismatch", "database-validation");
    }
  }
}

function scalarNumber(database: DatabaseSync, sql: string, ...parameters: Array<string | number>): number {
  const row = database.prepare(sql).get(...parameters);
  if (!row || typeof row !== "object") throw new StorageMaintenanceError("missing-scalar", "database-validation");
  const value = Object.values(row)[0];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new StorageMaintenanceError("invalid-scalar", "database-validation");
  }
  return value;
}

interface TableColumnRow {
  name: string;
  pk: number;
}

function sqliteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function updateLengthPrefixedHash(hash: Hash, tag: string, value: string | Uint8Array): void {
  const length = typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
  hash.update(`${tag}${length}:`, "utf8");
  hash.update(value);
  hash.update(";", "utf8");
}

function updateSqliteValueHash(hash: Hash, value: unknown): void {
  if (value === null) {
    hash.update("n;", "utf8");
  } else if (typeof value === "string") {
    updateLengthPrefixedHash(hash, "s", value);
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new StorageMaintenanceError("invalid-protected-value", "database-validation");
    }
    updateLengthPrefixedHash(hash, "d", Object.is(value, -0) ? "-0" : String(value));
  } else if (typeof value === "bigint") {
    updateLengthPrefixedHash(hash, "i", value.toString());
  } else if (value instanceof Uint8Array) {
    updateLengthPrefixedHash(hash, "b", value);
  } else {
    throw new StorageMaintenanceError("invalid-protected-value", "database-validation");
  }
}

function protectedTableSnapshot(
  database: DatabaseSync,
  table: typeof PROTECTED_TABLES[number],
): { count: number; digest: string } {
  const columns = database.prepare(
    "SELECT name, pk FROM pragma_table_info(?) ORDER BY cid",
  ).all(table) as unknown as TableColumnRow[];
  if (columns.length === 0 || columns.some((column) => typeof column.name !== "string")) {
    throw new StorageMaintenanceError("protected-table-schema-mismatch", "database-validation");
  }
  const primaryKey = columns
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk);
  const order = primaryKey.length > 0 ? primaryKey : columns;
  const selected = columns.map((column) => sqliteIdentifier(column.name)).join(", ");
  const ordered = order.map((column) => sqliteIdentifier(column.name)).join(", ");
  const statement = database.prepare(
    `SELECT ${selected} FROM ${sqliteIdentifier(table)} ORDER BY ${ordered}`,
  );
  const hash = createHash("sha256");
  updateLengthPrefixedHash(hash, "t", table);
  for (const column of columns) updateLengthPrefixedHash(hash, "c", column.name);
  let count = 0;
  for (const row of statement.iterate() as unknown as Iterable<Record<string, unknown>>) {
    hash.update("r;", "utf8");
    for (const column of columns) updateSqliteValueHash(hash, row[column.name]);
    count++;
  }
  return { count, digest: hash.digest("hex") };
}

function protectedSnapshot(database: DatabaseSync): Pick<
  ValidationSnapshot,
  "protectedCounts" | "protectedDigests" | "sourceExclusions" | "sourceExclusionDigest"
> {
  const protectedCounts: Record<string, number> = {};
  const protectedDigests: Record<string, string> = {};
  for (const table of PROTECTED_TABLES) {
    const snapshot = protectedTableSnapshot(database, table);
    protectedCounts[table] = snapshot.count;
    protectedDigests[table] = snapshot.digest;
  }
  const exclusions = database.prepare(`
    SELECT project_path, session_id
    FROM project_memory_source_exclusions
    ORDER BY project_path, session_id
  `).all() as unknown as Array<{ project_path: string; session_id: string }>;
  return {
    protectedCounts,
    protectedDigests,
    sourceExclusions: exclusions.length,
    sourceExclusionDigest: sha256(stableStringify(exclusions)),
  };
}

function validateOpenDatabase(database: DatabaseSync, path: string): ValidationSnapshot {
  const quickRow = database.prepare("PRAGMA quick_check").get();
  const quickCheck = quickRow && typeof quickRow === "object" ? String(Object.values(quickRow)[0]) : "";
  if (quickCheck !== "ok") throw new StorageMaintenanceError("quick-check-failed", "database-validation");
  if (scalarNumber(database, "PRAGMA foreign_keys") !== 1) {
    throw new StorageMaintenanceError("foreign-keys-disabled", "database-validation");
  }
  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length > 0) {
    throw new StorageMaintenanceError("foreign-key-check-failed", "database-validation");
  }
  const schemaVersion = scalarNumber(database, "PRAGMA user_version");
  if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new StorageMaintenanceError("unsupported-schema", "database-validation");
  }
  validateMigrations(database);
  return {
    diagnostics: collectStorageDiagnostics(database, path),
    ...protectedSnapshot(database),
  };
}

function validateDatabase(path: string): ValidationSnapshot {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, {
      readOnly: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      timeout: 5_000,
    });
    database.exec("PRAGMA trusted_schema = OFF");
    return validateOpenDatabase(database, path);
  } catch (error) {
    throw maintenanceError(error, "database-validation-failed", "database-validation");
  } finally {
    database?.close();
  }
}

function assertProtectedState(
  snapshot: ValidationSnapshot,
  sourceSnapshot: ValidationSnapshot,
  stage: string,
): void {
  for (const [table, count] of Object.entries(sourceSnapshot.protectedCounts)) {
    if (snapshot.protectedCounts[table] !== count) {
      throw new StorageMaintenanceError("protected-count-mismatch", stage);
    }
    if (snapshot.protectedDigests[table] !== sourceSnapshot.protectedDigests[table]) {
      throw new StorageMaintenanceError("protected-digest-mismatch", stage);
    }
  }
  if (snapshot.sourceExclusions !== sourceSnapshot.sourceExclusions
    || snapshot.sourceExclusionDigest !== sourceSnapshot.sourceExclusionDigest) {
    throw new StorageMaintenanceError("source-exclusion-mismatch", stage);
  }
}

function assertCandidate(
  path: string,
  sourceSnapshot: ValidationSnapshot,
): ValidationSnapshot {
  const candidate = validateDatabase(path);
  assertProtectedState(candidate, sourceSnapshot, "candidate-validation");
  if (candidate.diagnostics.manifests.rows > candidate.diagnostics.manifests.retainedLimit) {
    throw new StorageMaintenanceError("manifest-retention-not-converged", "candidate-validation");
  }
  if (candidate.diagnostics.retention.calibrationExcess > 0) {
    throw new StorageMaintenanceError("calibration-retention-not-converged", "candidate-validation");
  }

  const database = new DatabaseSync(path, { readOnly: true, enableForeignKeyConstraints: true });
  try {
    const oversized = scalarNumber(
      database,
      "SELECT count(*) FROM context_manifests WHERE length(CAST(manifest_json AS BLOB)) > ?",
      HARD_PERSISTED_MANIFEST_BYTES,
    );
    if (oversized > 0) throw new StorageMaintenanceError("oversized-manifest", "candidate-validation");
  } finally {
    database.close();
  }
  return candidate;
}

function assertStagePathsAbsent(paths: StorageMaintenancePaths): void {
  for (const path of [paths.backup, paths.work, paths.candidate, paths.retired, paths.state]) {
    if (existsSync(path)) throw new StorageMaintenanceError("stage-path-exists", "path-preflight");
  }
}

function writeState(paths: StorageMaintenancePaths, phase: StorageMaintenancePhase): void {
  const state: StorageMaintenanceState = {
    protocol: STATE_PROTOCOL,
    phase,
    databaseFingerprint: databasePathFingerprint(paths.source),
    source: paths.source,
    candidate: paths.candidate,
    backup: paths.backup,
    work: paths.work,
    retired: paths.retired,
  };
  writeFileSync(paths.state, `${JSON.stringify(state)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: existsSync(paths.state) ? "w" : "wx",
  });
  bestEffortChmod(paths.state, 0o600);
  fsyncPath(paths.state);
  fsyncDirectory(dirname(paths.state));
}

function parseState(path: string, expectedSource: string): StorageMaintenanceState {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new StorageMaintenanceError("maintenance-state-invalid", "recover");
  }
  if (!value || typeof value !== "object") {
    throw new StorageMaintenanceError("maintenance-state-invalid", "recover");
  }
  const state = value as Partial<StorageMaintenanceState>;
  const expectedPaths = storageMaintenancePaths(expectedSource);
  const validPhase = state.phase === "candidate-validated"
    || state.phase === "source-retired"
    || state.phase === "candidate-installed"
    || state.phase === "completed";
  if (state.protocol !== STATE_PROTOCOL
    || !validPhase
    || state.source !== expectedSource
    || state.databaseFingerprint !== databasePathFingerprint(expectedSource)
    || state.candidate !== expectedPaths.candidate
    || state.backup !== expectedPaths.backup
    || state.work !== expectedPaths.work
    || state.retired !== expectedPaths.retired) {
    throw new StorageMaintenanceError("maintenance-state-invalid", "recover");
  }
  return state as StorageMaintenanceState;
}

function cleanupWork(paths: StorageMaintenancePaths): void {
  for (const path of [
    paths.work,
    `${paths.work}-wal`,
    `${paths.work}-shm`,
  ]) removeFile(path);
}

function cleanupRetired(paths: StorageMaintenancePaths): void {
  for (const path of [
    paths.retired,
    `${paths.retired}-wal`,
    `${paths.retired}-shm`,
  ]) removeFile(path);
}

function restoreRetired(paths: StorageMaintenancePaths): void {
  if (existsSync(paths.source) || !existsSync(paths.retired)) {
    throw new StorageMaintenanceError("rollback-state-ambiguous", "swap-rollback");
  }
  renameSync(paths.retired, paths.source);
  renameIfExists(`${paths.retired}-wal`, `${paths.source}-wal`);
  renameIfExists(`${paths.retired}-shm`, `${paths.source}-shm`);
  fsyncDirectory(dirname(paths.source));
}

function restoreBackup(paths: StorageMaintenancePaths): void {
  if (existsSync(paths.source) || !existsSync(paths.backup)) {
    throw new StorageMaintenanceError("backup-restore-state-ambiguous", "recover");
  }
  validateDatabase(paths.backup);
  copyFileSync(paths.backup, paths.source, constants.COPYFILE_EXCL);
  bestEffortChmod(paths.source, 0o600);
  fsyncPath(paths.source);
  fsyncDirectory(dirname(paths.source));
}

export function inspectStorage(databasePath: string): StorageInspectResult {
  const source = requireRegularDatabase(databasePath);
  const paths = storageMaintenancePaths(source);
  const snapshot = validateDatabase(source);
  return {
    databasePath: source,
    diagnostics: snapshot.diagnostics,
    quickCheck: "ok",
    foreignKeyViolations: 0,
    schemaVersion: snapshot.diagnostics.schemaVersion ?? CURRENT_SCHEMA_VERSION,
    manifestsToPrune: snapshot.diagnostics.retention.manifestExcess,
    calibrationToPrune: snapshot.diagnostics.retention.calibrationExcess,
    availableBytes: availableFilesystemBytes(source),
    requiredBytes: requiredFilesystemBytes(source),
    paths,
  };
}

export async function compactStorage(
  databasePath: string,
  options: StorageMaintenanceOptions = {},
): Promise<StorageCompactionResult> {
  const source = requireRegularDatabase(databasePath);
  const paths = storageMaintenancePaths(source);
  assertStagePathsAbsent(paths);
  let lock: DatabaseMaintenanceLock | undefined;
  let sourceRetired = false;
  let candidateInstalled = false;
  let backupVerified = false;

  try {
    lock = acquireDatabaseMaintenanceLock(source, {
      ...(options.processProbe ? { processProbe: options.processProbe } : {}),
      ...(options.now !== undefined ? { createdAt: options.now } : {}),
    });
    const sourceSnapshot = validateDatabase(source);
    const requiredBytes = requiredFilesystemBytes(source);
    const availableBytes = options.availableBytes ?? availableFilesystemBytes(source);
    if (availableBytes < requiredBytes) {
      throw new StorageMaintenanceError("insufficient-disk-space", "disk-preflight");
    }

    options.onPhase?.("before-backup");
    reservePrivateFile(paths.backup);
    const sourceDatabase = new DatabaseSync(source, {
      readOnly: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      timeout: 5_000,
    });
    try {
      await backup(sourceDatabase, paths.backup);
    } catch (error) {
      throw maintenanceError(error, "backup-failed", "backup");
    } finally {
      sourceDatabase.close();
    }
    bestEffortChmod(paths.backup, 0o600);
    fsyncPath(paths.backup);
    const backupSnapshot = validateDatabase(paths.backup);
    assertProtectedState(backupSnapshot, sourceSnapshot, "backup-validation");
    if (backupSnapshot.diagnostics.manifests.rows !== sourceSnapshot.diagnostics.manifests.rows
      || backupSnapshot.diagnostics.calibration.rows !== sourceSnapshot.diagnostics.calibration.rows) {
      throw new StorageMaintenanceError("backup-count-mismatch", "backup-validation");
    }
    backupVerified = true;
    options.onPhase?.("backup-created");

    options.onPhase?.("before-work-copy");
    copyFileSync(paths.backup, paths.work, constants.COPYFILE_EXCL);
    bestEffortChmod(paths.work, 0o600);
    let workDatabase: ContextDatabase | undefined;
    let maintenance: ManifestMaintenanceResult;
    options.onPhase?.("before-work-rewrite");
    try {
      workDatabase = ContextDatabase.open(paths.work, {
        clientLease: false,
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
      maintenance = workDatabase.manifests.applyMaintenanceRetention();
      workDatabase.optimize();
      workDatabase.checkpoint("TRUNCATE");
    } catch (error) {
      throw maintenanceError(error, "working-copy-rewrite-failed", "working-copy");
    } finally {
      workDatabase?.close();
    }
    options.onPhase?.("work-rewritten");

    options.onPhase?.("before-vacuum");
    const vacuumDatabase = new DatabaseSync(paths.work, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      timeout: 5_000,
    });
    try {
      const writes = new SqliteWriteCoordinator(vacuumDatabase);
      writes.execute("storage-vacuum-candidate", () => {
        vacuumDatabase.prepare("VACUUM INTO ?").run(paths.candidate);
      });
    } catch (error) {
      throw maintenanceError(error, "vacuum-failed", "vacuum");
    } finally {
      vacuumDatabase.close();
    }
    bestEffortChmod(paths.candidate, 0o600);
    fsyncPath(paths.candidate);
    options.onPhase?.("before-candidate-validation");
    assertCandidate(paths.candidate, sourceSnapshot);
    writeState(paths, "candidate-validated");
    options.onPhase?.("candidate-validated");

    options.onPhase?.("before-source-rename");
    renameSync(paths.source, paths.retired);
    renameIfExists(`${paths.source}-wal`, `${paths.retired}-wal`);
    renameIfExists(`${paths.source}-shm`, `${paths.retired}-shm`);
    sourceRetired = true;
    writeState(paths, "source-retired");
    options.onPhase?.("source-retired");

    options.onPhase?.("before-candidate-rename");
    renameSync(paths.candidate, paths.source);
    candidateInstalled = true;
    bestEffortChmod(paths.source, 0o600);
    fsyncPath(paths.source);
    fsyncDirectory(dirname(paths.source));
    writeState(paths, "candidate-installed");
    options.onPhase?.("candidate-installed");

    options.onPhase?.("before-final-validation");
    const installed = assertCandidate(paths.source, sourceSnapshot);
    writeState(paths, "completed");
    options.onPhase?.("completed");
    options.onPhase?.("before-cleanup");
    cleanupRetired(paths);
    cleanupWork(paths);
    removeFile(paths.state);
    fsyncDirectory(dirname(paths.source));

    return {
      databasePath: paths.source,
      backupPath: paths.backup,
      beforeBytes: sourceSnapshot.diagnostics.databaseBytes ?? sourceSnapshot.diagnostics.allocatedBytes ?? 0,
      afterBytes: statSync(paths.source).size,
      maintenance,
      diagnostics: installed.diagnostics,
    };
  } catch (error) {
    if (sourceRetired) {
      try {
        if (candidateInstalled && existsSync(paths.source) && !existsSync(paths.candidate)) {
          renameSync(paths.source, paths.candidate);
        }
        restoreRetired(paths);
        sourceRetired = false;
        candidateInstalled = false;
        removeFile(paths.candidate);
        cleanupWork(paths);
        removeFile(paths.state);
      } catch {
        throw new StorageMaintenanceError("rollback-required", "swap-rollback");
      }
    } else {
      removeFile(paths.state);
      removeFile(paths.candidate);
      cleanupWork(paths);
      if (!backupVerified) removeFile(paths.backup);
    }
    if (error instanceof DatabaseProtocolError) throw error;
    throw maintenanceError(error, "maintenance-failed", "compact");
  } finally {
    lock?.release();
  }
}

export function recoverStorage(
  databasePath: string,
  options: StorageMaintenanceOptions = {},
): StorageRecoveryResult {
  const source = resolve(databasePath);
  const paths = storageMaintenancePaths(source);
  if (!existsSync(paths.state)) throw new StorageMaintenanceError("maintenance-state-missing", "recover");
  let lock: DatabaseMaintenanceLock | undefined;
  try {
    lock = acquireDatabaseMaintenanceLock(source, {
      replaceStaleLock: true,
      ...(options.processProbe ? { processProbe: options.processProbe } : {}),
      ...(options.now !== undefined ? { createdAt: options.now } : {}),
    });
    const state = parseState(paths.state, source);

    if (state.phase === "candidate-validated") {
      if (!existsSync(paths.source) || existsSync(paths.retired)) {
        throw new StorageMaintenanceError("recovery-state-ambiguous", "recover");
      }
      removeFile(paths.candidate);
      cleanupWork(paths);
      removeFile(paths.state);
      return { databasePath: source, action: "staging-cleared" };
    }

    if (state.phase === "source-retired") {
      if (existsSync(paths.retired)) restoreRetired(paths);
      else restoreBackup(paths);
      validateDatabase(paths.source);
      removeFile(paths.candidate);
      cleanupWork(paths);
      removeFile(paths.state);
      return { databasePath: source, action: "source-restored" };
    }

    if (!existsSync(paths.source)) {
      if (existsSync(paths.retired)) restoreRetired(paths);
      else restoreBackup(paths);
      validateDatabase(paths.source);
      cleanupWork(paths);
      removeFile(paths.state);
      return { databasePath: source, action: "source-restored" };
    }
    try {
      validateDatabase(paths.source);
      cleanupRetired(paths);
      cleanupWork(paths);
      removeFile(paths.candidate);
      removeFile(paths.state);
      return { databasePath: source, action: "candidate-kept" };
    } catch {
      if (existsSync(paths.candidate)) {
        throw new StorageMaintenanceError("recovery-state-ambiguous", "recover");
      }
      renameSync(paths.source, paths.candidate);
      if (existsSync(paths.retired)) restoreRetired(paths);
      else restoreBackup(paths);
      validateDatabase(paths.source);
      cleanupWork(paths);
      removeFile(paths.state);
      return { databasePath: source, action: "source-restored" };
    }
  } catch (error) {
    if (error instanceof DatabaseProtocolError) throw error;
    throw maintenanceError(error, "recovery-failed", "recover");
  } finally {
    lock?.release();
  }
}
