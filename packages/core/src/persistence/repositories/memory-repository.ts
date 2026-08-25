import type { DatabaseSync } from "node:sqlite";
import { SqliteWriteCoordinator } from "../write-coordinator.ts";
import {
  parseMemoryMutation,
  parsePinMutation,
  type MemoryItem,
  type MemoryMaterializationResult,
  type MemoryMutation,
  type MemoryStatus,
  type PinItem,
  type PinMutation,
  type PinStatus,
  type StoredMemoryMutation,
  type StoredPinMutation,
} from "../../memory/memory-types.ts";

interface MutationRow {
  mutation_key: string;
  mutation_id: string;
  session_id: string;
  created_at: number;
  entry_order: number;
  payload_json: string;
}

interface MemoryRow {
  memory_id: string;
  scope: "session" | "project";
  session_id: string | null;
  project_path: string | null;
  memory_key: string | null;
  claim: string;
  status: MemoryStatus;
  created_at: number;
  updated_at: number;
  origin_session_id: string | null;
  superseded_by: string | null;
  status_reason: string | null;
  metadata_json: string;
}

interface PinRow {
  pin_id: string;
  scope: "session" | "branch" | "project";
  session_id: string | null;
  project_path: string | null;
  branch_leaf_id: string | null;
  content: string;
  source_entry_id: string | null;
  source_file: string | null;
  status: PinStatus;
  created_at: number;
  updated_at: number;
  superseded_by: string | null;
  status_reason: string | null;
  metadata_json: string;
}

interface MaterializedMemory {
  item: MemoryItem;
  sourceKeys: Set<string>;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function classificationFromMetadata(value: string): MemoryItem["classification"] {
  const metadata = parseJson(value);
  if (!metadata || typeof metadata !== "object" || !("classification" in metadata)) return undefined;
  const classification = (metadata as { classification?: unknown }).classification;
  return classification === "normal"
    || classification === "internal"
    || classification === "sensitive"
    || classification === "local-only"
    ? classification
    : undefined;
}

function entryIdFromKey(entryKey: string): string {
  const separator = entryKey.indexOf(":");
  return separator < 0 ? entryKey : entryKey.slice(separator + 1);
}

function identityKey(item: MemoryItem): string | undefined {
  if (!item.key || item.status !== "active") return undefined;
  return [item.scope, item.sessionId ?? "", item.projectPath ?? "", item.key].join("\0");
}

function mapMemory(row: MemoryRow, sourceEntryIds: string[]): MemoryItem {
  return {
    id: row.memory_id,
    scope: row.scope,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.project_path ? { projectPath: row.project_path } : {}),
    ...(row.memory_key ? { key: row.memory_key } : {}),
    ...(classificationFromMetadata(row.metadata_json)
      ? { classification: classificationFromMetadata(row.metadata_json) }
      : {}),
    claim: row.claim,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    originSessionId: row.origin_session_id ?? row.session_id ?? "legacy",
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    ...(row.status_reason ? { statusReason: row.status_reason } : {}),
    sourceEntryIds,
  };
}

function mapPin(row: PinRow): PinItem {
  return {
    id: row.pin_id,
    scope: row.scope,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.project_path ? { projectPath: row.project_path } : {}),
    ...(row.branch_leaf_id ? { branchLeafId: row.branch_leaf_id } : {}),
    ...(classificationFromMetadata(row.metadata_json)
      ? { classification: classificationFromMetadata(row.metadata_json) }
      : {}),
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    ...(row.status_reason ? { statusReason: row.status_reason } : {}),
    ...(row.source_entry_id ? { sourceEntryId: row.source_entry_id } : {}),
    ...(row.source_file ? { sourceFile: row.source_file } : {}),
  };
}

export class MemoryRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly writes = new SqliteWriteCoordinator(database),
  ) {}

  reconcileSession(
    sessionId: string,
    memoryMutations: readonly StoredMemoryMutation[],
    pinMutations: readonly StoredPinMutation[],
  ): MemoryMaterializationResult {
    return this.writes.transaction("memory-reconcile-session", () => {
      this.database.prepare("DELETE FROM memory_mutations WHERE session_id = ?").run(sessionId);
      this.database.prepare("DELETE FROM pin_mutations WHERE session_id = ?").run(sessionId);
      const insertMemoryMutation = this.database.prepare(`
        INSERT INTO memory_mutations(
          mutation_key, mutation_id, session_id, created_at, entry_order, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insertPinMutation = this.database.prepare(`
        INSERT INTO pin_mutations(
          mutation_key, mutation_id, session_id, created_at, entry_order, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const mutation of memoryMutations) {
        insertMemoryMutation.run(
          mutation.mutationKey,
          mutation.mutationId,
          mutation.sessionId,
          mutation.createdAt,
          mutation.entryOrder,
          JSON.stringify(mutation.payload),
        );
      }
      for (const mutation of pinMutations) {
        insertPinMutation.run(
          mutation.mutationKey,
          mutation.mutationId,
          mutation.sessionId,
          mutation.createdAt,
          mutation.entryOrder,
          JSON.stringify(mutation.payload),
        );
      }
      return this.materialize();
    });
  }

  getMemory(id: string): MemoryItem | undefined {
    const row = this.database.prepare("SELECT * FROM memory_items WHERE memory_id = ?").get(id) as MemoryRow | undefined;
    return row ? mapMemory(row, this.memorySourceIds(id)) : undefined;
  }

  listMemories(options: {
    sessionId: string;
    projectPath: string;
    includeProject: boolean;
    activeOnly?: boolean;
  }): MemoryItem[] {
    const status = options.activeOnly === false ? "" : "AND status = 'active'";
    const rows = this.database.prepare(`
      SELECT * FROM memory_items
      WHERE (
        (scope = 'session' AND session_id = ?)
        OR (scope = 'project' AND project_path = ? AND ? = 1)
      ) ${status}
      ORDER BY created_at DESC, memory_id
    `).all(options.sessionId, options.projectPath, options.includeProject ? 1 : 0) as unknown as MemoryRow[];
    const sources = this.memorySources(new Set(rows.map((row) => row.memory_id)));
    return rows.map((row) => mapMemory(row, sources.get(row.memory_id) ?? []));
  }

  getPin(id: string): PinItem | undefined {
    const row = this.database.prepare("SELECT * FROM pins WHERE pin_id = ?").get(id) as PinRow | undefined;
    return row ? mapPin(row) : undefined;
  }

  listPins(options: {
    sessionId: string;
    projectPath: string;
    includeProject: boolean;
    activeOnly?: boolean;
  }): PinItem[] {
    const status = options.activeOnly === false ? "" : "AND status = 'active'";
    const rows = this.database.prepare(`
      SELECT * FROM pins
      WHERE (
        (scope IN ('session', 'branch') AND session_id = ?)
        OR (scope = 'project' AND project_path = ? AND ? = 1)
      ) ${status}
      ORDER BY created_at ASC, pin_id
    `).all(options.sessionId, options.projectPath, options.includeProject ? 1 : 0) as unknown as PinRow[];
    return rows.map(mapPin);
  }

  stats(sessionId: string, projectPath: string): {
    activeMemories: number;
    inactiveMemories: number;
    activePins: number;
    inactivePins: number;
  } {
    const memories = this.database.prepare(`
      SELECT
        COALESCE(sum(status = 'active'), 0) AS active,
        COALESCE(sum(status <> 'active'), 0) AS inactive
      FROM memory_items
      WHERE (scope = 'session' AND session_id = ?) OR (scope = 'project' AND project_path = ?)
    `).get(sessionId, projectPath) as { active: number; inactive: number };
    const pins = this.database.prepare(`
      SELECT
        COALESCE(sum(status = 'active'), 0) AS active,
        COALESCE(sum(status <> 'active'), 0) AS inactive
      FROM pins
      WHERE (scope IN ('session', 'branch') AND session_id = ?)
         OR (scope = 'project' AND project_path = ?)
    `).get(sessionId, projectPath) as { active: number; inactive: number };
    return {
      activeMemories: memories.active,
      inactiveMemories: memories.inactive,
      activePins: pins.active,
      inactivePins: pins.inactive,
    };
  }

  private materialize(): MemoryMaterializationResult {
    const warnings: string[] = [];
    let ignoredMutations = 0;
    const memories = new Map<string, MaterializedMemory>();
    const pins = new Map<string, PinItem>();

    const memoryRows = this.database.prepare(`
      SELECT mutation_key, mutation_id, session_id, created_at, entry_order, payload_json
      FROM memory_mutations ORDER BY created_at, session_id, entry_order, mutation_id, mutation_key
    `).all() as unknown as MutationRow[];
    const memoryOperations: Array<{ mutation: MemoryMutation; row: MutationRow }> = [];
    for (const row of memoryRows) {
      const mutation = parseMemoryMutation(parseJson(row.payload_json));
      if (!mutation || mutation.mutationId !== row.mutation_id) {
        warnings.push(`Ignored malformed memory mutation ${row.mutation_id}`);
        ignoredMutations++;
        continue;
      }
      memoryOperations.push({ mutation, row });
      this.applyMemoryMutation(memories, mutation, row, warnings, false);
    }
    for (const { mutation, row } of memoryOperations) {
      this.applyMemoryMutation(memories, mutation, row, warnings, true);
    }

    const pinRows = this.database.prepare(`
      SELECT mutation_key, mutation_id, session_id, created_at, entry_order, payload_json
      FROM pin_mutations ORDER BY created_at, session_id, entry_order, mutation_id, mutation_key
    `).all() as unknown as MutationRow[];
    const pinOperations: Array<{ mutation: PinMutation; row: MutationRow }> = [];
    for (const row of pinRows) {
      const mutation = parsePinMutation(parseJson(row.payload_json));
      if (!mutation || mutation.mutationId !== row.mutation_id) {
        warnings.push(`Ignored malformed pin mutation ${row.mutation_id}`);
        ignoredMutations++;
        continue;
      }
      pinOperations.push({ mutation, row });
      this.applyPinMutation(pins, mutation, row, warnings, false);
    }
    for (const { mutation, row } of pinOperations) {
      this.applyPinMutation(pins, mutation, row, warnings, true);
    }

    const activeKeys = new Map<string, string>();
    for (const memory of memories.values()) {
      const key = identityKey(memory.item);
      if (!key) continue;
      const previousId = activeKeys.get(key);
      if (!previousId) {
        activeKeys.set(key, memory.item.id);
        continue;
      }
      memory.item.status = "invalid";
      memory.item.statusReason = `Conflicts with active memory ${previousId}`;
      memory.item.updatedAt = Math.max(memory.item.updatedAt, memory.item.createdAt);
      warnings.push(`Memory ${memory.item.id} invalidated because key conflicts with ${previousId}`);
    }

    this.database.exec(`
      DELETE FROM memory_fts;
      DELETE FROM memory_sources;
      UPDATE memory_items SET superseded_by = NULL;
      DELETE FROM memory_items;
      UPDATE pins SET superseded_by = NULL;
      DELETE FROM pins;
    `);

    const availableEntryKeys = new Set(
      (this.database.prepare("SELECT entry_key FROM entries").all() as unknown as Array<{ entry_key: string }>)
        .map((row) => row.entry_key),
    );
    const insertMemory = this.database.prepare(`
      INSERT INTO memory_items(
        memory_id, scope, session_id, project_path, claim, status, created_at,
        superseded_by, memory_key, origin_session_id, updated_at, status_reason, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMemorySource = this.database.prepare(
      "INSERT OR IGNORE INTO memory_sources(memory_id, entry_key) VALUES (?, ?)",
    );
    const insertMemoryFts = this.database.prepare(
      "INSERT INTO memory_fts(claim, memory_id) VALUES (?, ?)",
    );
    for (const { item, sourceKeys } of memories.values()) {
      insertMemory.run(
        item.id,
        item.scope,
        item.sessionId ?? null,
        item.projectPath ?? null,
        item.claim,
        item.status,
        item.createdAt,
        null,
        item.key ?? null,
        item.originSessionId,
        item.updatedAt,
        item.statusReason ?? null,
        JSON.stringify({ ...(item.classification ? { classification: item.classification } : {}) }),
      );
      for (const sourceKey of sourceKeys) {
        if (availableEntryKeys.has(sourceKey)) insertMemorySource.run(item.id, sourceKey);
      }
      insertMemoryFts.run(item.claim, item.id);
    }
    const updateSupersededMemory = this.database.prepare(
      "UPDATE memory_items SET superseded_by = ? WHERE memory_id = ?",
    );
    for (const { item } of memories.values()) {
      if (item.supersededBy) updateSupersededMemory.run(item.supersededBy, item.id);
    }

    const insertPin = this.database.prepare(`
      INSERT INTO pins(
        pin_id, scope, session_id, project_path, content, source_entry_key,
        source_entry_id, source_file, status, created_at, branch_leaf_id,
        superseded_by, updated_at, status_reason, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of pins.values()) {
      const sourceEntryId = item.sourceEntryId ?? item.id;
      const sourceEntryKey = item.sessionId ? `${item.sessionId}:${sourceEntryId}` : null;
      const sourceExists = sourceEntryKey ? availableEntryKeys.has(sourceEntryKey) : false;
      insertPin.run(
        item.id,
        item.scope,
        item.sessionId ?? null,
        item.projectPath ?? null,
        item.content,
        sourceExists ? sourceEntryKey : null,
        sourceExists ? sourceEntryId : null,
        item.sourceFile ?? null,
        item.status,
        item.createdAt,
        item.branchLeafId ?? null,
        null,
        item.updatedAt,
        item.statusReason ?? null,
        JSON.stringify({ ...(item.classification ? { classification: item.classification } : {}) }),
      );
    }
    const updateSupersededPin = this.database.prepare(
      "UPDATE pins SET superseded_by = ? WHERE pin_id = ?",
    );
    for (const item of pins.values()) {
      if (item.supersededBy) updateSupersededPin.run(item.supersededBy, item.id);
    }

    return {
      memories: memories.size,
      pins: pins.size,
      memoryMutations: memoryRows.length,
      pinMutations: pinRows.length,
      ignoredMutations,
      warnings,
    };
  }

  private applyMemoryMutation(
    memories: Map<string, MaterializedMemory>,
    mutation: MemoryMutation,
    row: MutationRow,
    warnings: string[],
    lifecycleOnly: boolean,
  ): void {
    if (lifecycleOnly) {
      if (mutation.operation === "status") {
        const existing = memories.get(mutation.memoryId);
        if (!existing) {
          warnings.push(`Memory status mutation ${mutation.mutationId} references missing ${mutation.memoryId}`);
          return;
        }
        existing.item.status = mutation.status;
        existing.item.updatedAt = mutation.createdAt;
        existing.item.statusReason = mutation.reason;
        existing.item.supersededBy = undefined;
        return;
      }
      if (mutation.operation === "supersede") {
        const previous = memories.get(mutation.previousId);
        if (!previous) {
          warnings.push(`Memory supersession ${mutation.mutationId} references missing ${mutation.previousId}`);
          return;
        }
        previous.item.status = "superseded";
        previous.item.supersededBy = mutation.item.id;
        previous.item.updatedAt = mutation.createdAt;
        previous.item.statusReason = `Superseded by ${mutation.item.id}`;
      }
      return;
    }
    if (mutation.operation === "status") return;

    const value = mutation.item;
    const existing = memories.get(value.id);
    if (existing) {
      if (existing.item.claim !== value.claim || existing.item.scope !== value.scope) {
        warnings.push(`Memory ID collision ignored for ${value.id}`);
      }
      return;
    }
    if (value.scope === "project" && !value.projectPath) {
      warnings.push(`Project memory ${value.id} has no project path`);
      return;
    }
    const sourceKeys = new Set<string>([
      row.mutation_key,
      ...value.sourceEntryIds.map((entryId) => `${row.session_id}:${entryId}`),
    ]);
    const item: MemoryItem = {
      id: value.id,
      scope: value.scope,
      ...(value.scope === "session" ? { sessionId: row.session_id } : {}),
      ...(value.projectPath ? { projectPath: value.projectPath } : {}),
      ...(value.key ? { key: value.key } : {}),
      ...(value.classification ? { classification: value.classification } : {}),
      claim: value.claim,
      status: "active",
      createdAt: value.createdAt,
      updatedAt: mutation.createdAt,
      originSessionId: row.session_id,
      sourceEntryIds: [...new Set([entryIdFromKey(row.mutation_key), ...value.sourceEntryIds])],
    };
    memories.set(item.id, { item, sourceKeys });
  }

  private applyPinMutation(
    pins: Map<string, PinItem>,
    mutation: PinMutation,
    row: MutationRow,
    warnings: string[],
    lifecycleOnly: boolean,
  ): void {
    if (lifecycleOnly) {
      if (mutation.operation === "status") {
        const existing = pins.get(mutation.pinId);
        if (!existing) {
          warnings.push(`Pin status mutation ${mutation.mutationId} references missing ${mutation.pinId}`);
          return;
        }
        existing.status = mutation.status;
        existing.updatedAt = mutation.createdAt;
        existing.statusReason = mutation.reason;
        existing.supersededBy = undefined;
        return;
      }
      if (mutation.operation === "supersede") {
        const previous = pins.get(mutation.previousId);
        if (!previous) {
          warnings.push(`Pin supersession ${mutation.mutationId} references missing ${mutation.previousId}`);
          return;
        }
        previous.status = "superseded";
        previous.supersededBy = mutation.item.id;
        previous.updatedAt = mutation.createdAt;
        previous.statusReason = `Superseded by ${mutation.item.id}`;
      }
      return;
    }
    if (mutation.operation === "status") return;

    const value = mutation.item;
    const existing = pins.get(value.id);
    if (existing) {
      if (existing.content !== value.content || existing.scope !== value.scope) {
        warnings.push(`Pin ID collision ignored for ${value.id}`);
      }
      return;
    }
    if (value.scope === "project" && !value.projectPath) {
      warnings.push(`Project pin ${value.id} has no project path`);
      return;
    }
    if (value.scope === "branch" && !value.branchLeafId) {
      warnings.push(`Branch pin ${value.id} has no branch leaf`);
      return;
    }
    const item: PinItem = {
      id: value.id,
      scope: value.scope,
      sessionId: row.session_id,
      ...(value.projectPath ? { projectPath: value.projectPath } : {}),
      ...(value.branchLeafId ? { branchLeafId: value.branchLeafId } : {}),
      ...(value.classification ? { classification: value.classification } : {}),
      content: value.content,
      status: "active",
      createdAt: value.createdAt,
      updatedAt: mutation.createdAt,
      ...(value.sourceEntryId
        ? { sourceEntryId: value.sourceEntryId }
        : { sourceEntryId: entryIdFromKey(row.mutation_key) }),
      ...(value.sourceFile ? { sourceFile: value.sourceFile } : {}),
    };
    pins.set(item.id, item);
  }

  private memorySourceIds(memoryId: string): string[] {
    return this.memorySources(new Set([memoryId])).get(memoryId) ?? [];
  }

  private memorySources(memoryIds: ReadonlySet<string>): Map<string, string[]> {
    if (memoryIds.size === 0) return new Map();
    const rows = this.database.prepare(`
      SELECT source.memory_id, entry.entry_id
      FROM memory_sources AS source
      JOIN entries AS entry ON entry.entry_key = source.entry_key
      ORDER BY entry.created_at, entry.entry_id
    `).all() as unknown as Array<{ memory_id: string; entry_id: string }>;
    const result = new Map<string, string[]>();
    for (const row of rows) {
      if (!memoryIds.has(row.memory_id)) continue;
      const values = result.get(row.memory_id) ?? [];
      values.push(row.entry_id);
      result.set(row.memory_id, values);
    }
    return result;
  }
}
