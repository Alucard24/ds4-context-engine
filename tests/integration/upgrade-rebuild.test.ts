import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "ds4-context-core/config/config-loader";
import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
} from "ds4-context-core/persistence/migrations";
import { ContextDatabase } from "ds4-context-core/persistence/sqlite";
import { registerDs4ContextEngine } from "../../src/extension/index.ts";

class RebuildPi {
  readonly handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();

  on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  registerCommand(): void {}
  registerTool(): void {}
  getActiveTools(): string[] { return []; }
  getAllTools(): unknown[] { return []; }
}

const V0_1_SCHEMA_VERSION = 10;
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "ds4-v010-upgrade-"));
  temporaryDirectories.push(directory);
  return directory;
}

function checksum(migration: (typeof MIGRATIONS)[number]): string {
  return createHash("sha256")
    .update(`${migration.version}\n${migration.name}\n${migration.sql}`)
    .digest("hex");
}

function createV010Database(path: string): void {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);
  const insertMigration = database.prepare(
    "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
  );
  for (const migration of MIGRATIONS.filter((item) => item.version <= V0_1_SCHEMA_VERSION)) {
    database.exec(migration.sql);
    insertMigration.run(migration.version, migration.name, checksum(migration), 100 + migration.version);
    database.exec(`PRAGMA user_version = ${migration.version}`);
  }

  database.prepare(`
    INSERT INTO sessions(session_id, session_file, project_path, indexed_at)
    VALUES (?, ?, ?, ?)
  `).run("legacy-session", "/canonical/legacy.jsonl", "/canonical/project", 1_000);
  database.prepare(`
    INSERT INTO entries(
      entry_key, entry_id, session_id, parent_id, entry_type, role,
      created_at, content_hash, searchable_text, token_estimate, indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "legacy-session:legacy-entry",
    "legacy-entry",
    "legacy-session",
    null,
    "message",
    "user",
    1_001,
    "a".repeat(64),
    "canonical legacy decision",
    6,
    1_002,
  );
  database.prepare(`
    INSERT INTO entries_fts(searchable_text, entry_key, entry_id, session_id)
    VALUES (?, ?, ?, ?)
  `).run(
    "canonical legacy decision",
    "legacy-session:legacy-entry",
    "legacy-entry",
    "legacy-session",
  );
  database.prepare(`
    INSERT INTO project_states(project_path, dirty, changed_files_json, indexed_at)
    VALUES (?, 0, '[]', ?)
  `).run("/canonical/project", 1_003);
  database.prepare(`
    INSERT INTO project_files(
      project_path, file_path, content_hash, size_bytes, mtime_ms,
      language, modified, tracked, status, indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 1, 'current', ?)
  `).run("/canonical/project", "src/Legacy.ts", "b".repeat(64), 24, 1_004, "typescript", 1_005);
  database.prepare(`
    INSERT INTO project_snippets(
      snippet_id, project_path, file_path, file_hash, start_line, end_line,
      content, symbols, token_estimate, stale, indexed_at
    ) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, 0, ?)
  `).run(
    "legacy-snippet",
    "/canonical/project",
    "src/Legacy.ts",
    "b".repeat(64),
    "export class Legacy {}",
    '["Legacy"]',
    6,
    1_006,
  );
  database.close();
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("0.1 to 0.2 upgrade and rebuild compatibility", () => {
  it("loads a 0.1 configuration with every new behavior still opt-in", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      context: {
        mode: "managed",
        targetFillRatio: 0.65,
        softLimitRatio: 0.75,
        hardLimitRatio: 0.85,
        recentTailTokens: 32000,
      },
      retrieval: { exact: true, fts: true, semantic: false, maxResults: 9 },
      memory: { enabled: true, maxPinChars: 3000, maxClaimChars: 1500, maxResults: 8 },
      diagnostics: { storeContextManifest: true, storeFullRenderedContext: false, logLevel: "warn" },
      storage: { databasePath: "legacy/context.db" },
    }));

    const loaded = loadConfig({
      agentDir,
      cwd: project,
      configDirName: ".pi",
      projectTrusted: true,
      homeDir: root,
    });

    expect(loaded.loadedFiles).toEqual([join(agentDir, "ds4-context.json")]);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.config.context).toMatchObject({
      targetFillRatio: 0.65,
      softLimitRatio: 0.75,
      hardLimitRatio: 0.85,
      recentTailTokens: 32000,
    });
    expect(loaded.config.retrieval).toMatchObject({
      exact: true,
      fts: true,
      semantic: false,
      maxResults: 9,
      embedding: { mode: "local" },
    });
    expect(loaded.config.memory).toMatchObject({ crossSession: false, maxProjectSessions: 250 });
    expect(loaded.config.quality.enabled).toBe(false);
    expect(loaded.config.ranking.mode).toBe("off");
    expect(loaded.config.localKvReuse.enabled).toBe(false);
    expect(loaded.config.storage).toMatchObject({
      databasePath: "legacy/context.db",
      busyTimeoutMs: 5_000,
      writeRetryTimeoutMs: 30_000,
      projectIndexLeaseMs: 120_000,
    });
  });

  it("upgrades an exact schema-v10 database without changing legacy projections", () => {
    const root = temporaryDirectory();
    const path = join(root, "context.db");
    createV010Database(path);

    const upgraded = ContextDatabase.open(path, { now: 2_000 });
    expect(upgraded.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(upgraded.migrations).toHaveLength(CURRENT_SCHEMA_VERSION);
    expect(upgraded.migrations.slice(0, V0_1_SCHEMA_VERSION)).toEqual(
      MIGRATIONS.slice(0, V0_1_SCHEMA_VERSION).map((migration) => ({
        version: migration.version,
        name: migration.name,
        checksum: checksum(migration),
        appliedAt: 100 + migration.version,
      })),
    );
    expect(upgraded.getSessionStats("legacy-session")).toEqual({ entries: 1, estimatedTokens: 6 });
    expect(upgraded.sessionIndex.searchExact("legacy-session", "legacy decision", 5))
      .toEqual([expect.objectContaining({ entryId: "legacy-entry", searchableText: "canonical legacy decision" })]);
    expect(upgraded.projectKnowledge.searchExact("/canonical/project", "Legacy", 5))
      .toEqual([expect.objectContaining({ snippetId: "legacy-snippet", filePath: "src/Legacy.ts" })]);
    expect(upgraded.health()).toMatchObject({ ok: true, schemaVersion: CURRENT_SCHEMA_VERSION });
    upgraded.close();

    const raw = new DatabaseSync(path, { readOnly: true });
    expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
    expect(raw.prepare("SELECT content, chunk_kind, parser_id FROM project_snippets WHERE snippet_id = ?")
      .get("legacy-snippet")).toMatchObject({
        content: "export class Legacy {}",
        chunk_kind: "text",
        parser_id: null,
      });
    expect(raw.prepare("SELECT count(*) AS count FROM derived_embeddings").get()).toEqual({ count: 0 });
    expect(raw.prepare("SELECT count(*) AS count FROM resource_leases").get()).toEqual({ count: 0 });
    expect(raw.prepare("SELECT count(*) AS count FROM project_memory_sessions").get()).toEqual({ count: 0 });
    raw.close();
  });

  it("rebuilds session, project, and semantic projections after complete database deletion", async () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    mkdirSync(join(project, "src"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      retrieval: { semantic: true },
      memory: { enabled: false },
      artifacts: { enabled: false },
      compaction: { enabled: false },
      diagnostics: { storeContextManifest: false },
    }));
    const projectFile = join(project, "src", "Rebuild.ts");
    writeFileSync(projectFile, "export class RebuildMarker { readonly canonical = true; }\n");
    const entry = {
      type: "message" as const,
      id: "rebuild-request",
      parentId: null,
      timestamp: "2026-08-26T00:00:01.000Z",
      message: {
        role: "user" as const,
        content: "Inspect RebuildMarker in src/Rebuild.ts",
        timestamp: 1,
      },
    };
    const sessionFile = join(root, "session.jsonl");
    writeFileSync(sessionFile, [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "rebuild-session",
        timestamp: "2026-08-26T00:00:00.000Z",
        cwd: project,
      }),
      JSON.stringify(entry),
    ].join("\n") + "\n");
    const canonicalSession = readFileSync(sessionFile);
    const canonicalProject = readFileSync(projectFile);
    const context = {
      cwd: project,
      mode: "tui",
      hasUI: false,
      ui: { notify: () => {}, setStatus: () => {} },
      sessionManager: {
        getSessionId: () => "rebuild-session",
        getSessionFile: () => sessionFile,
        getLeafId: () => entry.id,
        getEntries: () => [entry],
        getBranch: () => [entry],
        buildContextEntries: () => [entry],
      },
      model: {
        id: "rebuild-model",
        name: "Rebuild Model",
        api: "openai-responses",
        provider: "faux",
        baseUrl: "http://localhost",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_000,
        maxTokens: 4_096,
      },
      scopedModels: [],
      modelRegistry: {},
      isProjectTrusted: () => true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      getContextUsage: () => undefined,
      getSystemPrompt: () => "rebuild-system",
      waitForIdle: async () => {},
    } as unknown as ExtensionContext;
    const databasePath = join(agentDir, "ds4-context", "context.db");

    const run = async (prefix: string): Promise<{ messages?: unknown[] }> => {
      const pi = new RebuildPi();
      let sequence = 0;
      const runtime = registerDs4ContextEngine(pi as unknown as ExtensionAPI, {
        agentDir,
        configDirName: ".pi",
        homeDir: root,
        idGenerator: () => `${prefix}-${++sequence}`,
        logSink: () => {},
      });
      await pi.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, context);
      const result = await pi.handlers.get("context")?.[0]?.({
        type: "context",
        messages: [entry.message],
      }, context) as { messages?: unknown[] };
      expect(runtime.diagnostics(context).project.semantic).toMatchObject({
        enabled: true,
        destination: "local",
        indexFresh: true,
      });
      await pi.handlers.get("session_shutdown")?.[0]?.(
        { type: "session_shutdown", reason: "quit" },
        context,
      );
      return result;
    };
    const projectionCounts = (): Record<string, number> => {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      const counts = Object.fromEntries([
        "entries",
        "project_files",
        "project_snippets",
        "derived_embeddings",
      ].map((table) => [
        table,
        (database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as unknown as { count: number }).count,
      ]));
      database.close();
      return counts;
    };

    const first = await run("first");
    const firstCounts = projectionCounts();
    expect(JSON.stringify(first.messages)).toContain("RebuildMarker");
    expect(firstCounts).toMatchObject({ entries: 1, project_files: 1 });
    expect(firstCounts.project_snippets).toBeGreaterThan(0);
    expect(firstCounts.derived_embeddings).toBeGreaterThanOrEqual(firstCounts.project_snippets ?? 0);

    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });

    const rebuilt = await run("rebuilt");
    expect(JSON.stringify(rebuilt.messages)).toContain("RebuildMarker");
    expect(projectionCounts()).toEqual(firstCounts);
    expect(readFileSync(sessionFile)).toEqual(canonicalSession);
    expect(readFileSync(projectFile)).toEqual(canonicalProject);
  });
});
