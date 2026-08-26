import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryMutation, PinMutation } from "ds4-context-core/memory/memory-types";
import { ContextDatabase } from "ds4-context-core/persistence/sqlite";
import { MEMORY_CUSTOM_ENTRY_TYPE, PIN_CUSTOM_ENTRY_TYPE } from "ds4-context-core/memory/memory-types";
import { projectSessionFileMutations } from "../../src/pi-adapter/memory-adapter.ts";
import { ProjectMemorySynchronizer } from "../../src/pi-adapter/project-memory-sync.ts";
import { PiSessionIndexer } from "../../src/pi-adapter/session-indexer.ts";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

interface SessionFixture {
  sessionId: string;
  sessionFile: string;
  entries: Array<Record<string, unknown>>;
}

function customEntry(
  id: string,
  parentId: string | null,
  customType: string,
  data: MemoryMutation | PinMutation,
  timestamp = "2026-08-25T00:00:02.000Z",
): Record<string, unknown> {
  return { type: "custom", id, parentId, timestamp, customType, data };
}

function memoryAdd(input: {
  mutationId: string;
  memoryId: string;
  projectPath: string;
  claim: string;
  key?: string;
  createdAt?: number;
}): MemoryMutation {
  const createdAt = input.createdAt ?? 1_780_000_002_000;
  return {
    schemaVersion: 1,
    mutationId: input.mutationId,
    operation: "add",
    createdAt,
    item: {
      id: input.memoryId,
      scope: "project",
      projectPath: input.projectPath,
      ...(input.key ? { key: input.key } : {}),
      classification: "sensitive",
      claim: input.claim,
      createdAt,
      sourceEntryIds: ["user-1"],
    },
  };
}

function sessionMemoryAdd(input: {
  mutationId: string;
  memoryId: string;
  claim: string;
}): MemoryMutation {
  return {
    schemaVersion: 1,
    mutationId: input.mutationId,
    operation: "add",
    createdAt: 1_780_000_003_000,
    item: {
      id: input.memoryId,
      scope: "session",
      classification: "internal",
      claim: input.claim,
      createdAt: 1_780_000_003_000,
      sourceEntryIds: ["user-1"],
    },
  };
}

function pinAdd(input: {
  mutationId: string;
  pinId: string;
  projectPath: string;
  content: string;
}): PinMutation {
  return {
    schemaVersion: 1,
    mutationId: input.mutationId,
    operation: "add",
    createdAt: 1_780_000_004_000,
    item: {
      id: input.pinId,
      scope: "project",
      projectPath: input.projectPath,
      classification: "local-only",
      content: input.content,
      createdAt: 1_780_000_004_000,
      sourceEntryId: "user-1",
    },
  };
}

function createSession(
  directory: string,
  projectPath: string,
  sessionId: string,
  fileName: string,
  entries: Array<Record<string, unknown>> = [],
): SessionFixture {
  const sessionFile = join(directory, fileName);
  writeFileSync(sessionFile, [
    JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-08-25T00:00:00.000Z",
      cwd: projectPath,
    }),
    ...entries.map((entry) => JSON.stringify(entry)),
  ].join("\n") + "\n");
  return { sessionId, sessionFile, entries };
}

function fixture(maxSessions = 20) {
  const root = mkdtempSync(join(tmpdir(), "ds4-cross-session-memory-"));
  temporaryDirectories.push(root);
  const projectPath = resolve(root, "project");
  const otherProjectPath = resolve(root, "other-project");
  const sessions = join(root, "sessions", "project");
  mkdirSync(projectPath, { recursive: true });
  mkdirSync(otherProjectPath, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  const current = createSession(sessions, projectPath, "current-session", "300-current.jsonl");
  const database = ContextDatabase.open(join(root, "context.db"), { now: 1 });
  const indexer = new PiSessionIndexer(database.sessionIndex, { now: () => 1_780_000_100_000 });
  const synchronizer = new ProjectMemorySynchronizer(database.memory, indexer, {
    projectPath,
    activeSessionId: current.sessionId,
    activeSessionFile: current.sessionFile,
    maxSessions,
    now: (() => { let value = 1_780_000_200_000; return () => value++; })(),
  });
  return { root, projectPath, otherProjectPath, sessions, current, database, synchronizer };
}

function projectMemories(data: ReturnType<typeof fixture>, activeOnly = false) {
  return data.database.memory.listMemories({
    sessionId: data.current.sessionId,
    projectPath: data.projectPath,
    includeProject: true,
    includeCrossSessionProject: true,
    activeOnly,
  });
}

describe("cross-session project memory", () => {
  it("discovers only exact canonical project sessions and preserves mutation provenance", () => {
    const data = fixture();
    const user = {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-08-25T00:00:01.000Z",
      message: { role: "user", content: "Remember the database choice.", timestamp: 1 },
    };
    createSession(data.sessions, data.projectPath, "source-session", "200-source.jsonl", [
      user,
      customEntry(
        "memory-entry",
        "user-1",
        MEMORY_CUSTOM_ENTRY_TYPE,
        memoryAdd({
          mutationId: "mutation-memory",
          memoryId: "memory-sqlite",
          projectPath: data.projectPath,
          key: "database",
          claim: "Project database is SQLite.",
        }),
      ),
      customEntry(
        "tampered-memory-entry",
        "memory-entry",
        MEMORY_CUSTOM_ENTRY_TYPE,
        memoryAdd({
          mutationId: "tampered-mutation",
          memoryId: "tampered-memory",
          projectPath: data.otherProjectPath,
          claim: "Cross-project payload must not materialize.",
        }),
      ),
      customEntry(
        "tampered-supersede-entry",
        "tampered-memory-entry",
        MEMORY_CUSTOM_ENTRY_TYPE,
        {
          schemaVersion: 1,
          mutationId: "tampered-supersede-mutation",
          operation: "supersede",
          previousId: "memory-sqlite",
          createdAt: 1_780_000_003_000,
          item: {
            id: "tampered-replacement",
            scope: "project",
            projectPath: data.otherProjectPath,
            claim: "Cross-project replacement must not materialize.",
            createdAt: 1_780_000_003_000,
            sourceEntryIds: ["user-1"],
          },
        },
      ),
      customEntry(
        "pin-entry",
        "tampered-supersede-entry",
        PIN_CUSTOM_ENTRY_TYPE,
        pinAdd({
          mutationId: "mutation-pin",
          pinId: "pin-canonical",
          projectPath: data.projectPath,
          content: "Keep project decisions explicit.",
        }),
      ),
    ]);
    createSession(data.sessions, data.otherProjectPath, "foreign-session", "100-foreign.jsonl", [
      user,
      customEntry(
        "foreign-memory-entry",
        "user-1",
        MEMORY_CUSTOM_ENTRY_TYPE,
        memoryAdd({
          mutationId: "foreign-mutation",
          memoryId: "foreign-memory",
          projectPath: data.otherProjectPath,
          claim: "Foreign project secret.",
        }),
      ),
    ]);

    const result = data.synchronizer.sync();
    const memory = projectMemories(data, true)[0];

    expect(result.discoveredSessions).toBe(1);
    expect(result.contributingSessions).toBe(1);
    expect(memory).toMatchObject({
      id: "memory-sqlite",
      classification: "sensitive",
      originSessionId: "source-session",
      sourceEntryIds: expect.arrayContaining(["user-1", "memory-entry"]),
      provenance: {
        sourceSessionId: "source-session",
        mutationEntryId: "memory-entry",
        sourceBranchEntryId: "user-1",
        sourceEntryIds: expect.arrayContaining(["user-1", "memory-entry"]),
        contradicts: [],
      },
    });
    expect(memory?.provenance.sourceSessionFile).toContain("200-source.jsonl");
    expect(data.database.memory.listPins({
      sessionId: data.current.sessionId,
      projectPath: data.projectPath,
      includeProject: true,
      includeCrossSessionProject: true,
      activeOnly: true,
    })).toEqual([
      expect.objectContaining({
        id: "pin-canonical",
        classification: "local-only",
        provenance: expect.objectContaining({
          sourceSessionId: "source-session",
          mutationEntryId: "pin-entry",
          sourceBranchEntryId: "tampered-supersede-entry",
        }),
      }),
    ]);
    expect(projectMemories(data).map((item) => item.claim).join("\n"))
      .not.toContain("Foreign project secret");
    expect(data.database.memory.getMemory("tampered-memory")).toBeUndefined();
    expect(data.database.memory.getMemory("tampered-replacement")).toBeUndefined();
    expect(result.warnings.join("\n")).toContain("has no valid replacement tampered-replacement");
    data.database.close();
  });

  it("applies the discovery cap to sibling sessions without consuming it on the active session", () => {
    const data = fixture(1);
    const sourceEntries = (memoryId: string, mutationId: string) => [
      customEntry(
        `${memoryId}-entry`,
        null,
        MEMORY_CUSTOM_ENTRY_TYPE,
        memoryAdd({
          mutationId,
          memoryId,
          projectPath: data.projectPath,
          claim: `${memoryId} claim.`,
        }),
      ),
    ];
    createSession(
      data.sessions,
      data.projectPath,
      "newer-session",
      "200-newer.jsonl",
      sourceEntries("newer-memory", "newer-mutation"),
    );
    createSession(
      data.sessions,
      data.projectPath,
      "older-session",
      "100-older.jsonl",
      sourceEntries("older-memory", "older-mutation"),
    );

    const result = data.synchronizer.sync();
    expect(result).toMatchObject({ discoveredSessions: 1, contributingSessions: 1 });
    expect(result.warnings.join("\n")).toContain("memory.maxProjectSessions (1)");
    expect(projectMemories(data, true).map((memory) => memory.id)).toEqual(["newer-memory"]);
    data.database.close();
  });

  it("retains the active session projection when its source refresh fails", () => {
    const data = fixture();
    createSession(data.sessions, data.projectPath, data.current.sessionId, "300-current.jsonl", [
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-08-25T00:00:01.000Z",
        message: { role: "user", content: "Keep current memory.", timestamp: 1 },
      },
      customEntry(
        "current-memory-entry",
        "user-1",
        MEMORY_CUSTOM_ENTRY_TYPE,
        memoryAdd({
          mutationId: "current-mutation",
          memoryId: "current-memory",
          projectPath: data.projectPath,
          claim: "Current project decision.",
        }),
      ),
    ]);
    expect(data.synchronizer.sync().contributingSessions).toBe(0);
    expect(projectMemories(data, true).map((memory) => memory.id)).toEqual(["current-memory"]);

    writeFileSync(data.current.sessionFile, "{corrupt header}\n");
    const failed = data.synchronizer.sync();
    expect(failed.warnings.join("\n")).toContain("invalid header");
    expect(projectMemories(data, true).map((memory) => memory.id)).toEqual(["current-memory"]);
    data.database.close();
  });

  it("excludes only project contributions while preserving source-session memory", () => {
    const data = fixture();
    const source = createSession(data.sessions, data.projectPath, "source-session", "200-source.jsonl", [
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-08-25T00:00:01.000Z",
        message: { role: "user", content: "Remember both scopes.", timestamp: 1 },
      },
      customEntry(
        "project-memory-entry",
        "user-1",
        MEMORY_CUSTOM_ENTRY_TYPE,
        memoryAdd({
          mutationId: "project-mutation",
          memoryId: "project-memory",
          projectPath: data.projectPath,
          claim: "Shared project decision.",
        }),
      ),
      customEntry(
        "session-memory-entry",
        "project-memory-entry",
        MEMORY_CUSTOM_ENTRY_TYPE,
        sessionMemoryAdd({
          mutationId: "session-mutation",
          memoryId: "session-memory",
          claim: "Private session note.",
        }),
      ),
    ]);
    data.synchronizer.sync();

    const sourceSessionMemories = () => data.database.memory.listMemories({
      sessionId: source.sessionId,
      projectPath: data.projectPath,
      includeProject: false,
      activeOnly: true,
    });
    expect(projectMemories(data, true).map((memory) => memory.id)).toEqual(["project-memory"]);
    expect(sourceSessionMemories().map((memory) => memory.id)).toEqual(["session-memory"]);

    data.synchronizer.setExcluded(source.sessionId, true, "ignore project branch");
    expect(projectMemories(data, true)).toHaveLength(0);
    expect(sourceSessionMemories().map((memory) => memory.id)).toEqual(["session-memory"]);

    const activeProjection = projectSessionFileMutations(source.sessionFile, source.sessionId);
    data.database.memory.reconcileSession(
      source.sessionId,
      activeProjection.memoryMutations,
      activeProjection.pinMutations,
    );
    expect(projectMemories(data, true)).toHaveLength(0);
    data.synchronizer.setExcluded(source.sessionId, false);
    expect(projectMemories(data, true).map((memory) => memory.id)).toEqual(["project-memory"]);

    writeFileSync(source.sessionFile, "{corrupt header}\n");
    expect(data.synchronizer.sync().unavailableSessions).toBe(1);
    expect(projectMemories(data, true)).toHaveLength(0);
    expect(sourceSessionMemories().map((memory) => memory.id)).toEqual(["session-memory"]);

    createSession(
      data.sessions,
      data.projectPath,
      source.sessionId,
      "200-source.jsonl",
      source.entries,
    );
    const restoredProjection = projectSessionFileMutations(source.sessionFile, source.sessionId);
    data.database.memory.reconcileSession(
      source.sessionId,
      restoredProjection.memoryMutations,
      restoredProjection.pinMutations,
    );
    expect(data.database.memory.getProjectSourceState(data.projectPath, source.sessionId))
      .toBeUndefined();
    expect(projectMemories(data, true).map((memory) => memory.id)).toEqual(["project-memory"]);
    data.database.close();
  });

  it("reports only final replay warnings when a later-discovered source satisfies supersession", () => {
    const data = fixture();
    createSession(data.sessions, data.projectPath, "base-session", "100-base.jsonl", [
      customEntry(
        "base-memory-entry",
        null,
        MEMORY_CUSTOM_ENTRY_TYPE,
        memoryAdd({
          mutationId: "base-mutation",
          memoryId: "base-memory",
          projectPath: data.projectPath,
          claim: "Initial project database is SQLite.",
        }),
      ),
    ]);
    const replacement: MemoryMutation = {
      schemaVersion: 1,
      mutationId: "replacement-mutation",
      operation: "supersede",
      previousId: "base-memory",
      createdAt: 1_780_000_003_000,
      item: {
        id: "replacement-memory",
        scope: "project",
        projectPath: data.projectPath,
        claim: "Project database is PostgreSQL.",
        createdAt: 1_780_000_003_000,
        sourceEntryIds: [],
      },
    };
    createSession(data.sessions, data.projectPath, "replacement-session", "300-replacement.jsonl", [
      customEntry(
        "replacement-memory-entry",
        null,
        MEMORY_CUSTOM_ENTRY_TYPE,
        replacement,
        "2026-08-25T00:00:03.000Z",
      ),
    ]);

    const result = data.synchronizer.sync();
    expect(result.warnings.join("\n")).not.toContain("references missing base-memory");
    expect(projectMemories(data, true).map((memory) => memory.id)).toEqual(["replacement-memory"]);
    data.database.close();
  });

  it("indexes appended mutations incrementally and applies explicit cross-session supersession", () => {
    const data = fixture();
    const source = createSession(data.sessions, data.projectPath, "source-session", "200-source.jsonl", [
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-08-25T00:00:01.000Z",
        message: { role: "user", content: "Choose SQLite.", timestamp: 1 },
      },
      customEntry(
        "memory-entry-1",
        "user-1",
        MEMORY_CUSTOM_ENTRY_TYPE,
        memoryAdd({
          mutationId: "mutation-1",
          memoryId: "memory-1",
          projectPath: data.projectPath,
          key: "database",
          claim: "Project database is SQLite.",
        }),
      ),
    ]);
    expect(data.synchronizer.sync().rebuiltSessions).toBe(1);

    const replacement: MemoryMutation = {
      schemaVersion: 1,
      mutationId: "mutation-2",
      operation: "supersede",
      previousId: "memory-1",
      createdAt: 1_780_000_003_000,
      item: {
        id: "memory-2",
        scope: "project",
        projectPath: data.projectPath,
        key: "database",
        claim: "Project database is PostgreSQL.",
        createdAt: 1_780_000_003_000,
        sourceEntryIds: ["user-1"],
      },
    };
    appendFileSync(
      source.sessionFile,
      `${JSON.stringify(customEntry(
        "memory-entry-2",
        "memory-entry-1",
        MEMORY_CUSTOM_ENTRY_TYPE,
        replacement,
        "2026-08-25T00:00:03.000Z",
      ))}\n`,
    );

    const result = data.synchronizer.sync();
    expect(result.incrementalSessions).toBe(1);
    expect(projectMemories(data, true)).toEqual([
      expect.objectContaining({
        id: "memory-2",
        claim: "Project database is PostgreSQL.",
        provenance: expect.objectContaining({
          sourceBranchEntryId: "memory-entry-1",
          supersedes: "memory-1",
        }),
      }),
    ]);
    expect(projectMemories(data).find((memory) => memory.id === "memory-1")).toMatchObject({
      status: "superseded",
      supersededBy: "memory-2",
    });
    data.database.close();
  });

  it("uses stable conflict ordering and supports source exclusion and restoration", () => {
    const data = fixture();
    const makeEntries = (memoryId: string, mutationId: string, claim: string) => [
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-08-25T00:00:01.000Z",
        message: { role: "user", content: claim, timestamp: 1 },
      },
      customEntry(
        `entry-${memoryId}`,
        "user-1",
        MEMORY_CUSTOM_ENTRY_TYPE,
        memoryAdd({
          mutationId,
          memoryId,
          projectPath: data.projectPath,
          key: "database",
          claim,
          createdAt: 1_780_000_002_000,
        }),
      ),
    ];
    createSession(data.sessions, data.projectPath, "a-session", "100-a.jsonl", makeEntries(
      "memory-a",
      "mutation-a",
      "Project database is SQLite.",
    ));
    createSession(data.sessions, data.projectPath, "b-session", "200-b.jsonl", makeEntries(
      "memory-b",
      "mutation-b",
      "Project database is not SQLite.",
    ));

    data.synchronizer.sync();
    expect(projectMemories(data, true).map((memory) => memory.id)).toEqual(["memory-a"]);
    expect(projectMemories(data).find((memory) => memory.id === "memory-a")?.provenance.contradicts)
      .toEqual(["memory-b"]);
    expect(projectMemories(data).find((memory) => memory.id === "memory-b")).toMatchObject({
      status: "invalid",
      statusReason: "Conflicts with active memory memory-a",
    });

    const excluded = data.synchronizer.setExcluded("a-session", true, "obsolete source branch");
    expect(excluded.sources.find((source) => source.sessionId === "a-session")).toMatchObject({
      status: "excluded",
      exclusionReason: "obsolete source branch",
    });
    expect(projectMemories(data, true).map((memory) => memory.id)).toEqual(["memory-b"]);

    data.synchronizer.setExcluded("a-session", false);
    expect(projectMemories(data, true).map((memory) => memory.id)).toEqual(["memory-a"]);
    data.database.close();
  });

  it("excludes missing or corrupt canonical sources and rebuilds from JSONL after database loss", () => {
    const data = fixture();
    const source = createSession(data.sessions, data.projectPath, "source-session", "200-source.jsonl", [
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-08-25T00:00:01.000Z",
        message: { role: "user", content: "Remember SQLite.", timestamp: 1 },
      },
      customEntry(
        "memory-entry",
        "user-1",
        MEMORY_CUSTOM_ENTRY_TYPE,
        memoryAdd({
          mutationId: "mutation-memory",
          memoryId: "memory-sqlite",
          projectPath: data.projectPath,
          claim: "Project database is SQLite.",
        }),
      ),
    ]);
    data.synchronizer.sync();
    expect(projectMemories(data, true)).toHaveLength(1);

    writeFileSync(source.sessionFile, "{corrupt header}\n");
    const corrupt = data.synchronizer.sync();
    expect(corrupt.unavailableSessions).toBe(1);
    expect(projectMemories(data, true)).toHaveLength(0);

    const restored = createSession(data.sessions, data.projectPath, "source-session", "200-source.jsonl", source.entries);
    expect(restored.sessionFile).toBe(source.sessionFile);
    expect(data.synchronizer.sync().rebuiltSessions).toBeGreaterThanOrEqual(1);
    expect(projectMemories(data, true)).toHaveLength(1);

    unlinkSync(source.sessionFile);
    const missing = data.synchronizer.sync();
    expect(missing.sources.find((item) => item.sessionId === "source-session")?.status).toBe("missing");
    expect(projectMemories(data, true)).toHaveLength(0);
    data.database.close();
  });
});
