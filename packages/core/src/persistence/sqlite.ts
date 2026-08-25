import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Logger } from "../shared/logging.ts";
import { silentLogger } from "../shared/logging.ts";
import { applyMigrations, CURRENT_SCHEMA_VERSION, type AppliedMigration } from "./migrations.ts";
import { ArtifactRepository } from "./repositories/artifact-repository.ts";
import { ContextManifestRepository } from "./repositories/context-manifest-repository.ts";
import { ContextQualityRepository } from "./repositories/context-quality-repository.ts";
import { EmbeddingRepository } from "./repositories/embedding-repository.ts";
import { LeaseRepository } from "./repositories/lease-repository.ts";
import { MemoryRepository } from "./repositories/memory-repository.ts";
import { ProjectKnowledgeRepository } from "./repositories/project-knowledge-repository.ts";
import {
  SessionIndexRepository,
  type SessionIdentity,
  type SessionIndexStats,
} from "./repositories/session-index-repository.ts";
import { SummaryRepository } from "./repositories/summary-repository.ts";
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  DEFAULT_WRITE_RETRY_TIMEOUT_MS,
  SqliteWriteCoordinator,
} from "./write-coordinator.ts";

export type SessionRecord = SessionIdentity;
export type { SessionIndexStats } from "./repositories/session-index-repository.ts";

export interface DatabaseHealth {
  ok: boolean;
  quickCheck: string;
  journalMode: string;
  foreignKeys: boolean;
  schemaVersion: number;
  appliedMigrations: number;
}

export interface OpenDatabaseOptions {
  logger?: Logger;
  now?: number;
  busyTimeoutMs?: number;
  writeRetryTimeoutMs?: number;
}

function firstColumn(row: unknown): string | number {
  if (!row || typeof row !== "object") throw new Error("SQLite PRAGMA returned no row");
  const value = Object.values(row)[0];
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("SQLite PRAGMA returned an unexpected value");
  }
  return value;
}

function bestEffortChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "ENOSYS" && code !== "EPERM" && code !== "EINVAL") throw error;
  }
}

export class ContextDatabase {
  readonly schemaVersion = CURRENT_SCHEMA_VERSION;
  readonly migrations: readonly AppliedMigration[];
  readonly sessionIndex: SessionIndexRepository;
  readonly artifacts: ArtifactRepository;
  readonly manifests: ContextManifestRepository;
  readonly quality: ContextQualityRepository;
  readonly embeddings: EmbeddingRepository;
  readonly leases: LeaseRepository;
  readonly memory: MemoryRepository;
  readonly summaries: SummaryRepository;
  readonly projectKnowledge: ProjectKnowledgeRepository;
  private closed = false;

  private constructor(
    readonly path: string,
    private readonly database: DatabaseSync,
    private readonly logger: Logger,
    readonly writes: SqliteWriteCoordinator,
    migrations: AppliedMigration[],
  ) {
    this.migrations = migrations;
    this.sessionIndex = new SessionIndexRepository(database, writes);
    this.artifacts = new ArtifactRepository(database, writes);
    this.manifests = new ContextManifestRepository(database, writes);
    this.quality = new ContextQualityRepository(database, writes);
    this.embeddings = new EmbeddingRepository(database, writes);
    this.leases = new LeaseRepository(database, writes);
    this.memory = new MemoryRepository(database, writes);
    this.summaries = new SummaryRepository(database, writes);
    this.projectKnowledge = new ProjectKnowledgeRepository(database, writes);
  }

  static open(path: string, options: OpenDatabaseOptions = {}): ContextDatabase {
    const logger = options.logger ?? silentLogger;
    const memory = path === ":memory:";
    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    const writeRetryTimeoutMs = options.writeRetryTimeoutMs ?? DEFAULT_WRITE_RETRY_TIMEOUT_MS;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60_000) {
      throw new Error("busyTimeoutMs must be an integer between 1 and 60000");
    }
    if (!Number.isSafeInteger(writeRetryTimeoutMs)
      || writeRetryTimeoutMs < busyTimeoutMs
      || writeRetryTimeoutMs > 300_000) {
      throw new Error("writeRetryTimeoutMs must be an integer between busyTimeoutMs and 300000");
    }

    if (!memory) {
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      bestEffortChmod(directory, 0o700);
    }

    const database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      timeout: busyTimeoutMs,
    });
    const writes = new SqliteWriteCoordinator(database, {
      busyTimeoutMs,
      retryTimeoutMs: writeRetryTimeoutMs,
      logger,
    });

    try {
      database.exec("PRAGMA foreign_keys = ON");
      database.exec(`PRAGMA busy_timeout = ${writes.busyTimeoutMs}`);
      database.exec("PRAGMA synchronous = NORMAL");
      database.exec("PRAGMA trusted_schema = OFF");
      database.exec("PRAGMA secure_delete = FAST");
      if (!memory) writes.execute("enable-wal", () => database.exec("PRAGMA journal_mode = WAL"));

      const migrations = applyMigrations(database, options.now, writes);
      if (!memory) bestEffortChmod(path, 0o600);

      logger.info("database.opened", {
        databasePath: path,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        migrations: migrations.length,
        busyTimeoutMs: writes.busyTimeoutMs,
        writeRetryTimeoutMs: writes.retryTimeoutMs,
      });
      return new ContextDatabase(path, database, logger, writes, migrations);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  upsertSession(record: SessionIdentity): void {
    this.assertOpen();
    this.sessionIndex.upsertSession(record);
  }

  getSessionStats(sessionId: string): SessionIndexStats {
    this.assertOpen();
    return this.sessionIndex.getStats(sessionId);
  }

  listTables(): string[] {
    this.assertOpen();
    const rows = this.database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as unknown as Array<{ name: string }>;
    return rows.map((row) => row.name);
  }

  health(): DatabaseHealth {
    this.assertOpen();
    const quickCheck = String(firstColumn(this.database.prepare("PRAGMA quick_check").get()));
    const journalMode = String(firstColumn(this.database.prepare("PRAGMA journal_mode").get()));
    const foreignKeys = Number(firstColumn(this.database.prepare("PRAGMA foreign_keys").get())) === 1;
    const schemaVersion = Number(firstColumn(this.database.prepare("PRAGMA user_version").get()));

    return {
      ok: quickCheck === "ok" && foreignKeys && schemaVersion === CURRENT_SCHEMA_VERSION,
      quickCheck,
      journalMode,
      foreignKeys,
      schemaVersion,
      appliedMigrations: this.migrations.length,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
    this.logger.info("database.closed", { databasePath: this.path });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Context database is closed");
  }
}
