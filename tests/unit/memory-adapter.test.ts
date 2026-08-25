import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  MEMORY_CUSTOM_ENTRY_TYPE,
  PIN_CUSTOM_ENTRY_TYPE,
  type MemoryMutation,
  type PinMutation,
} from "ds4-context-core/memory/memory-types";
import { projectSessionMutations } from "../../src/pi-adapter/memory-adapter.ts";

const memory: MemoryMutation = {
  schemaVersion: 1,
  mutationId: "memory-mutation",
  operation: "add",
  createdAt: 1,
  item: {
    id: "memory-1",
    scope: "session",
    claim: "Durable claim",
    createdAt: 1,
    sourceEntryIds: ["source-1"],
  },
};

const pin: PinMutation = {
  schemaVersion: 1,
  mutationId: "pin-mutation",
  operation: "add",
  createdAt: 1,
  item: {
    id: "pin-1",
    scope: "branch",
    branchLeafId: "source-1",
    content: "Durable pin",
    createdAt: 1,
  },
};

describe("memory custom-entry adapter", () => {
  it("projects validated mutations and normalizes timestamps from canonical Pi entries", () => {
    const entries: SessionEntry[] = [
      {
        type: "custom",
        id: "entry-memory",
        parentId: null,
        timestamp: "2026-08-24T01:00:00.000Z",
        customType: MEMORY_CUSTOM_ENTRY_TYPE,
        data: memory,
      },
      {
        type: "custom",
        id: "entry-pin",
        parentId: "entry-memory",
        timestamp: "2026-08-24T01:00:01.000Z",
        customType: PIN_CUSTOM_ENTRY_TYPE,
        data: pin,
      },
      {
        type: "custom",
        id: "entry-duplicate",
        parentId: "entry-pin",
        timestamp: "2026-08-24T01:00:02.000Z",
        customType: MEMORY_CUSTOM_ENTRY_TYPE,
        data: memory,
      },
      {
        type: "custom",
        id: "entry-invalid",
        parentId: "entry-duplicate",
        timestamp: "2026-08-24T01:00:03.000Z",
        customType: MEMORY_CUSTOM_ENTRY_TYPE,
        data: { operation: "overwrite-silently" },
      },
    ];

    const projected = projectSessionMutations(entries, "session-1");

    expect(projected.memoryMutations).toHaveLength(1);
    expect(projected.pinMutations).toHaveLength(1);
    expect(projected.memoryMutations[0]).toMatchObject({
      mutationKey: "session-1:entry-memory",
      createdAt: Date.parse("2026-08-24T01:00:00.000Z"),
      payload: {
        createdAt: Date.parse("2026-08-24T01:00:00.000Z"),
        item: { createdAt: Date.parse("2026-08-24T01:00:00.000Z") },
      },
    });
    expect(projected.warnings).toEqual([
      "Ignored duplicate memory mutation memory-mutation at entry-duplicate",
      "Ignored malformed memory custom entry entry-invalid",
    ]);
  });
});
