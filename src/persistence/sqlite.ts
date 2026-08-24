import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Logger } from "../shared/logging.ts";
import { silentLogger } from "../shared/logging.ts";
import { applyMigrations, CURRENT_SCHEMA_VERSION, type AppliedMigration } from "./migrations.ts";
import { ContextManifestRepository } from "./repositories/context-manifest-repository.ts";
import { ProjectKnowledgeRepository } from "./repositories/project-knowledge-repository.ts";
import {
  SessionIndexRepository,
  type SessionIdentity,
  type SessionIndexStats,
} from "./repositories/session-index-repository.ts";
import { SummaryRepository } from "./repositories/summary-repository.ts";

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
  readonly manifests: ContextManifestRepository;
  readonly summaries: SummaryRepository;
  readonly projectKnowledge: ProjectKnowledgeRepository;
  private closed = false;

  private constructor(
    readonly path: string,
    private readonly database: DatabaseSync,
    private readonly logger: Logger,
    migrations: AppliedMigration[],
  ) {
    this.migrations = migrations;
    this.sessionIndex = new SessionIndexRepository(database);
    this.manifests = new ContextManifestRepository(database);
    this.summaries = new SummaryRepository(database);
    this.projectKnowledge = new ProjectKnowledgeRepository(database);
  }

  static open(path: string, options: OpenDatabaseOptions = {}): ContextDatabase {
    const logger = options.logger ?? silentLogger;
    const memory = path === ":memory:";

    if (!memory) {
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      bestEffortChmod(directory, 0o700);
    }

    const database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      timeout: 5000,
    });

    try {
      database.exec("PRAGMA foreign_keys = ON");
      database.exec("PRAGMA busy_timeout = 5000");
      database.exec("PRAGMA synchronous = NORMAL");
      database.exec("PRAGMA trusted_schema = OFF");
      database.exec("PRAGMA secure_delete = FAST");
      if (!memory) database.exec("PRAGMA journal_mode = WAL");

      const migrations = applyMigrations(database, options.now);
      if (!memory) bestEffortChmod(path, 0o600);

      logger.info("database.opened", {
        databasePath: path,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        migrations: migrations.length,
      });
      return new ContextDatabase(path, database, logger, migrations);
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
