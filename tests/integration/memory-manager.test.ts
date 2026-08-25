import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import {
  MemoryConflictError,
  MemoryManager,
  deriveMemoryKey,
} from "../../src/memory/memory-manager.ts";
import type {
  MemoryMutation,
  PinMutation,
  StoredMemoryMutation,
  StoredPinMutation,
} from "../../src/memory/memory-types.ts";
import { ContextDatabase } from "../../src/persistence/sqlite.ts";

const SESSION = "memory-session";
const PROJECT = "/workspace/project";

function setup(entryIds: string[]) {
  const database = ContextDatabase.open(":memory:");
  const sessionFile = "/tmp/memory-session.jsonl";
  database.sessionIndex.rebuild(
    { sessionId: SESSION, sessionFile, projectPath: PROJECT, indexedAt: 1 },
    entryIds.map((entryId, index) => ({
      entryKey: `${SESSION}:${entryId}`,
      entryId,
      sessionId: SESSION,
      parentId: index === 0 ? null : entryIds[index - 1] ?? null,
      entryType: entryId.startsWith("mutation") ? "custom" : "message",
      role: entryId.startsWith("mutation") ? undefined : "user",
      createdAt: index + 1,
      contentHash: `hash-${entryId}`,
      searchableText: entryId,
      tokenEstimate: 1,
      indexedAt: 1,
    })),
    {
      sessionId: SESSION,
      sessionFile,
      headerHash: "header",
      fileSize: 1,
      fileMtimeMs: 1,
      checkpointOffset: 1,
      checkpointHashStart: 0,
      malformedLines: 0,
      indexedAt: 1,
    },
  );
  let clock = 100;
  let id = 0;
  const manager = new MemoryManager(
    database.memory,
    DEFAULT_CONFIG.memory,
    DEFAULT_CONFIG.context.maxPinnedTokens,
    DEFAULT_CONFIG.context.maxMemoryTokens,
    SESSION,
    PROJECT,
    true,
    () => clock++,
    () => `id-${++id}`,
  );
  return { database, manager };
}

function storedMemory(mutation: MemoryMutation, entryId: string): StoredMemoryMutation {
  return {
    mutationKey: `${SESSION}:${entryId}`,
    mutationId: mutation.mutationId,
    sessionId: SESSION,
    createdAt: mutation.createdAt,
    entryOrder: Number(entryId.replace(/\D/gu, "")) || 0,
    payload: mutation,
  };
}

function storedPin(mutation: PinMutation, entryId: string): StoredPinMutation {
  return {
    mutationKey: `${SESSION}:${entryId}`,
    mutationId: mutation.mutationId,
    sessionId: SESSION,
    createdAt: mutation.createdAt,
    entryOrder: Number(entryId.replace(/\D/gu, "")) || 0,
    payload: mutation,
  };
}

const activeEntries = new Set(["user-1", "mutation-1", "mutation-2", "mutation-3", "mutation-4"]);

describe("MemoryManager", () => {
  it("detects duplicate and contradictory durable claims and supersedes explicitly", () => {
    const fixture = setup(["user-1", "mutation-1", "mutation-2", "mutation-3"]);
    const first = fixture.manager.proposeMemory({
      claim: "Package export mode defaults to PerEndpoint.",
      scope: "session",
      sourceEntryIds: ["user-1"],
      activeEntryIds: activeEntries,
    }).mutation;
    if (!first || first.operation !== "add") throw new Error("Expected memory add");
    fixture.manager.reconcile({
      memoryMutations: [storedMemory(first, "mutation-1")],
      pinMutations: [],
      warnings: [],
    });

    const duplicate = fixture.manager.proposeMemory({
      claim: "Package export mode defaults to PerEndpoint.",
      scope: "session",
      sourceEntryIds: [],
      activeEntryIds: activeEntries,
    });
    expect(duplicate).toEqual({ duplicateId: first.item.id });
    expect(deriveMemoryKey("Package export mode defaults to PerEndpoint.")).toBe("package-export-mode");
    expect(() => fixture.manager.proposeMemory({
      claim: "Package export mode defaults to SingleFile.",
      scope: "session",
      sourceEntryIds: [],
      activeEntryIds: activeEntries,
    })).toThrow(MemoryConflictError);

    const replacement = fixture.manager.proposeMemorySupersession({
      previousId: first.item.id,
      claim: "Package export mode defaults to SingleFile.",
      sourceEntryIds: ["user-1"],
      activeEntryIds: activeEntries,
    });
    if (replacement.operation !== "supersede") throw new Error("Expected supersession");
    fixture.manager.reconcile({
      memoryMutations: [
        storedMemory(first, "mutation-1"),
        storedMemory(replacement, "mutation-2"),
      ],
      pinMutations: [],
      warnings: [],
    });

    expect(fixture.manager.getMemory(first.item.id)).toMatchObject({
      status: "superseded",
      supersededBy: replacement.item.id,
    });
    expect(fixture.manager.getMemory(replacement.item.id)).toMatchObject({
      status: "active",
      key: "package-export-mode",
      sourceEntryIds: expect.arrayContaining(["user-1", "mutation-2"]),
    });
    const selection = fixture.manager.select("Keep Package export mode as SingleFile.", activeEntries);
    expect(selection.memories.map((item) => item.item.id)).toEqual([replacement.item.id]);
    expect(selection.memories[0]?.message.content).toContain("DS4 DURABLE MEMORY");
    expect(selection.memories[0]?.manifestRef).not.toHaveProperty("claim");
    fixture.database.close();
  });

  it("isolates branch pins while keeping session and project pins durable", () => {
    const fixture = setup(["user-1", "mutation-1", "mutation-2", "mutation-3", "mutation-4"]);
    const branch = fixture.manager.proposePin({
      content: "Keep branch-specific API compatibility.",
      scope: "branch",
      branchLeafId: "user-1",
      sourceEntryId: "user-1",
      activeEntryIds: activeEntries,
    }).mutation;
    const session = fixture.manager.proposePin({
      content: "Never rewrite canonical Pi JSONL.",
      scope: "session",
      activeEntryIds: activeEntries,
    }).mutation;
    const project = fixture.manager.proposePin({
      content: "Project invariant: all migrations are append-only.",
      scope: "project",
      sourceFile: "docs/ARCHITECTURE.md",
      activeEntryIds: activeEntries,
    }).mutation;
    if (!branch || !session || !project) throw new Error("Expected pin mutations");
    fixture.manager.reconcile({
      memoryMutations: [],
      pinMutations: [
        storedPin(branch, "mutation-1"),
        storedPin(session, "mutation-2"),
        storedPin(project, "mutation-3"),
      ],
      warnings: [],
    });
    if (session.operation === "status") throw new Error("Expected session pin add");
    const replacement = fixture.manager.proposePin({
      content: "Never rewrite canonical Pi JSONL or remove raw entries.",
      scope: "session",
      supersedes: session.item.id,
      activeEntryIds: activeEntries,
    }).mutation;
    if (!replacement || replacement.operation === "status") throw new Error("Expected pin replacement");
    fixture.manager.reconcile({
      memoryMutations: [],
      pinMutations: [
        storedPin(branch, "mutation-1"),
        storedPin(session, "mutation-2"),
        storedPin(project, "mutation-3"),
        storedPin(replacement, "mutation-4"),
      ],
      warnings: [],
    });
    expect(fixture.manager.getPin(session.item.id)).toMatchObject({
      status: "superseded",
      supersededBy: replacement.item.id,
    });

    const selected = fixture.manager.select("Continue.", new Set(["user-1"]));
    expect(selected.pins.map((item) => item.item.scope)).toEqual(["branch", "project", "session"]);
    expect(selected.pins.every((item) => item.message.content.includes("USER-CONFIRMED"))).toBe(true);
    const sibling = fixture.manager.select("Continue.", new Set(["sibling-entry"]));
    expect(sibling.pins.map((item) => item.item.scope)).toEqual(["project", "session"]);
    expect(sibling.excludedPins).toBe(1);
    fixture.database.close();
  });

  it("soft-deletes pins and invalidates memory through append-only mutations", () => {
    const fixture = setup(["mutation-1", "mutation-2", "mutation-3", "mutation-4"]);
    const pin = fixture.manager.proposePin({
      content: "Temporary pinned constraint.",
      scope: "session",
      activeEntryIds: activeEntries,
    }).mutation;
    const memory = fixture.manager.proposeMemory({
      claim: "Temporary setting is enabled.",
      scope: "session",
      sourceEntryIds: [],
      activeEntryIds: activeEntries,
    }).mutation;
    if (!pin || pin.operation === "status" || !memory || memory.operation !== "add") {
      throw new Error("Expected mutations");
    }
    fixture.manager.reconcile({
      memoryMutations: [storedMemory(memory, "mutation-1")],
      pinMutations: [storedPin(pin, "mutation-2")],
      warnings: [],
    });
    const unpin = fixture.manager.proposeUnpin(pin.item.id, "constraint completed");
    const invalid = fixture.manager.proposeMemoryStatus(memory.item.id, "invalid", "setting removed");
    fixture.manager.reconcile({
      memoryMutations: [storedMemory(memory, "mutation-1"), storedMemory(invalid, "mutation-3")],
      pinMutations: [storedPin(pin, "mutation-2"), storedPin(unpin, "mutation-4")],
      warnings: [],
    });

    expect(fixture.manager.getPin(pin.item.id)).toMatchObject({ status: "deleted", statusReason: "constraint completed" });
    expect(fixture.manager.getMemory(memory.item.id)).toMatchObject({ status: "invalid", statusReason: "setting removed" });
    expect(fixture.manager.select("Temporary setting", activeEntries)).toMatchObject({ pins: [], memories: [] });
    fixture.database.close();
  });

  it("shares project memory across sessions without leaking session memory", () => {
    const fixture = setup(["mutation-1", "mutation-2"]);
    const project = fixture.manager.proposeMemory({
      claim: "Project database is SQLite.",
      scope: "project",
      sourceEntryIds: [],
      activeEntryIds: activeEntries,
    }).mutation;
    const session = fixture.manager.proposeMemory({
      claim: "This session uses a temporary benchmark.",
      scope: "session",
      sourceEntryIds: [],
      activeEntryIds: activeEntries,
    }).mutation;
    if (!project || !session) throw new Error("Expected memory mutations");
    fixture.manager.reconcile({
      memoryMutations: [storedMemory(project, "mutation-1"), storedMemory(session, "mutation-2")],
      pinMutations: [],
      warnings: [],
    });

    const secondSession = "memory-session-two";
    fixture.database.sessionIndex.rebuild(
      { sessionId: secondSession, sessionFile: "/tmp/two.jsonl", projectPath: PROJECT, indexedAt: 2 },
      [],
      {
        sessionId: secondSession,
        sessionFile: "/tmp/two.jsonl",
        headerHash: "header-two",
        fileSize: 1,
        fileMtimeMs: 1,
        checkpointOffset: 1,
        checkpointHashStart: 0,
        malformedLines: 0,
        indexedAt: 2,
      },
    );
    const secondManager = new MemoryManager(
      fixture.database.memory,
      DEFAULT_CONFIG.memory,
      DEFAULT_CONFIG.context.maxPinnedTokens,
      DEFAULT_CONFIG.context.maxMemoryTokens,
      secondSession,
      PROJECT,
      true,
      () => 500,
      () => "second-id",
    );
    secondManager.reconcile({ memoryMutations: [], pinMutations: [], warnings: [] });

    expect(secondManager.listMemories(true).map((item) => item.claim)).toEqual(["Project database is SQLite."]);
    fixture.database.close();
  });

  it("rolls back mutation replacement when canonical entry provenance is missing", () => {
    const fixture = setup(["mutation-1"]);
    const mutation = fixture.manager.proposeMemory({
      claim: "Rollback invariant is enabled.",
      scope: "session",
      sourceEntryIds: [],
      activeEntryIds: activeEntries,
    }).mutation;
    if (!mutation) throw new Error("Expected mutation");
    fixture.manager.reconcile({
      memoryMutations: [storedMemory(mutation, "mutation-1")],
      pinMutations: [],
      warnings: [],
    });

    expect(() => fixture.manager.reconcile({
      memoryMutations: [storedMemory(mutation, "missing-entry")],
      pinMutations: [],
      warnings: [],
    })).toThrow();
    expect(fixture.manager.listMemories(true).map((item) => item.claim)).toEqual(["Rollback invariant is enabled."]);
    fixture.database.close();
  });

  it("invalidates conflicting active keys during deterministic replay instead of overwriting", () => {
    const fixture = setup(["mutation-1", "mutation-2"]);
    const first: MemoryMutation = {
      schemaVersion: 1,
      mutationId: "z-first",
      operation: "add",
      createdAt: 1,
      item: {
        id: "memory-a",
        scope: "session",
        key: "same-key",
        claim: "Feature is enabled.",
        createdAt: 1,
        sourceEntryIds: [],
      },
    };
    const second: MemoryMutation = {
      schemaVersion: 1,
      mutationId: "a-second",
      operation: "add",
      createdAt: 1,
      item: {
        id: "memory-b",
        scope: "session",
        key: "same-key",
        claim: "Feature is disabled.",
        createdAt: 1,
        sourceEntryIds: [],
      },
    };

    const result = fixture.manager.reconcile({
      memoryMutations: [storedMemory(first, "mutation-1"), storedMemory(second, "mutation-2")],
      pinMutations: [],
      warnings: [],
    });

    expect(fixture.manager.getMemory("memory-a")?.status).toBe("active");
    expect(fixture.manager.getMemory("memory-b")).toMatchObject({
      status: "invalid",
      statusReason: "Conflicts with active memory memory-a",
    });
    expect(result.warnings.join("\n")).toContain("key conflicts");
    fixture.database.close();
  });
});
