import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "../shared/logging.ts";
import { silentLogger } from "../shared/logging.ts";

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
export const DEFAULT_WRITE_RETRY_TIMEOUT_MS = 30_000;

export interface SqliteWriteCoordinatorOptions {
  /** Maximum time SQLite waits inside one lock acquisition. */
  busyTimeoutMs?: number;
  /** Total application-level retry window, including SQLite's waits. */
  retryTimeoutMs?: number;
  logger?: Logger;
  monotonicNow?: () => number;
  sleep?: (milliseconds: number) => void;
  random?: () => number;
}

interface SqliteErrorLike {
  errcode?: unknown;
  errstr?: unknown;
  message?: unknown;
}

const sleepBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function blockingSleep(milliseconds: number): void {
  if (milliseconds > 0) Atomics.wait(sleepBuffer, 0, 0, milliseconds);
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function sqlitePrimaryErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as SqliteErrorLike).errcode;
  return typeof code === "number" && Number.isInteger(code) ? code & 0xff : undefined;
}

export function isSqliteBusyError(error: unknown): boolean {
  const code = sqlitePrimaryErrorCode(error);
  if (code === 5 || code === 6) return true; // SQLITE_BUSY or SQLITE_LOCKED, including extended codes.
  if (!error || typeof error !== "object") return false;
  const sqlite = error as SqliteErrorLike;
  const text = `${String(sqlite.errstr ?? "")} ${String(sqlite.message ?? "")}`;
  return /(?:database|database table|schema) is locked|database is busy/iu.test(text);
}

/**
 * Serializes each local write with BEGIN IMMEDIATE and retries transient SQLite
 * lock contention. SQLite remains the cross-process arbiter; this class only
 * supplies bounded waiting, rollback, and whole-transaction replay.
 */
export class SqliteWriteCoordinator {
  readonly busyTimeoutMs: number;
  readonly retryTimeoutMs: number;
  private readonly logger: Logger;
  private readonly monotonicNow: () => number;
  private readonly sleep: (milliseconds: number) => void;
  private readonly random: () => number;

  constructor(
    private readonly database: DatabaseSync,
    options: SqliteWriteCoordinatorOptions = {},
  ) {
    this.busyTimeoutMs = boundedInteger(
      options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
      "busyTimeoutMs",
      1,
      60_000,
    );
    this.retryTimeoutMs = boundedInteger(
      options.retryTimeoutMs ?? DEFAULT_WRITE_RETRY_TIMEOUT_MS,
      "retryTimeoutMs",
      this.busyTimeoutMs,
      300_000,
    );
    this.logger = options.logger ?? silentLogger;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.sleep = options.sleep ?? blockingSleep;
    this.random = options.random ?? Math.random;
  }

  /** Retry one idempotent/autocommit write operation when SQLite is busy. */
  execute<T>(operationName: string, operation: () => T): T {
    if (this.database.isTransaction) return operation();
    return this.retry(operationName, operation);
  }

  /** Retry the complete callback in a fresh immediate transaction. */
  transaction<T>(operationName: string, operation: () => T): T {
    if (this.database.isTransaction) return operation();
    return this.retry(operationName, () => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        if (this.database.isTransaction) {
          try {
            this.database.exec("ROLLBACK");
          } catch (rollbackError) {
            this.logger.warn("database.write_rollback_failed", {
              operation: operationName,
              error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            });
            throw new Error(`Failed to roll back SQLite operation ${operationName}`, { cause: rollbackError });
          }
        }
        throw error;
      }
    });
  }

  private retry<T>(operationName: string, operation: () => T): T {
    const startedAt = this.monotonicNow();
    let attempt = 0;
    for (;;) {
      try {
        return operation();
      } catch (error) {
        const elapsedMs = Math.max(0, this.monotonicNow() - startedAt);
        if (!isSqliteBusyError(error) || elapsedMs >= this.retryTimeoutMs) throw error;

        attempt++;
        const exponentialMs = Math.min(250, 10 * (2 ** Math.min(attempt - 1, 5)));
        const jitteredMs = Math.max(1, Math.round(exponentialMs * (0.5 + this.random())));
        const remainingMs = this.retryTimeoutMs - elapsedMs;
        // Reserve one complete SQLite busy wait for the next attempt so the
        // configured total retry window remains a meaningful upper bound.
        const availableDelayMs = remainingMs - this.busyTimeoutMs;
        const delayMs = Math.min(jitteredMs, availableDelayMs);
        if (delayMs <= 0) throw error;
        this.logger.debug("database.write_retry", {
          operation: operationName,
          attempt,
          delayMs,
          elapsedMs: Math.round(elapsedMs),
          sqliteCode: sqlitePrimaryErrorCode(error),
        });
        this.sleep(delayMs);
      }
    }
  }
}
