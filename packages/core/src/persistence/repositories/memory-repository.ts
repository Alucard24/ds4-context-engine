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
  type MutationProvenance,
  type PinMutation,
  type PinStatus,
  type ProjectMemorySource,
  type StoredMemoryMutation,
  type StoredPinMutation,
} from "../../memory/memory-types.ts";

export interface ProjectMemorySourceCheckpoint {
  projectPath: string;
  sessionId: string;
  sessionFile: string;
  headerHash: string;
  fileSize: number;
  fileMtimeMs: number;
  checkpointOffset: number;
  checkpointHashStart: number;
  checkpointHash?: string;
  indexedRecords: number;
  indexedMutations: number;
  malformedLines: number;
  status: "ready" | "missing" | "corrupt";
  lastError?: string;
  indexedAt: number;
}

interface MutationRow {
  mutation_key: string;
  mutation_id: string;
  session_id: string;
  session_file: string;
  source_project_path: string | null;
  created_at: number;
  entry_order: number;
  source_parent_entry_id: string | null;
  source_project_enabled: number;
  payload_json: string;
}

interface ProjectMemorySourceRow {
  project_path: string;
  session_id: string;
  session_file: string;
  header_hash: string;
  file_size: number;
  file_mtime_ms: number;
  checkpoint_offset: number;
  checkpoint_hash_start: number;
  checkpoint_hash: string | null;
  indexed_records: number;
  indexed_mutations: number;
  malformed_lines: number;
  status: "ready" | "missing" | "corrupt";
  last_error: string | null;
  indexed_at: number;
  excluded_at: number | null;
  exclusion_reason: string | null;
  active_project_memories?: number;
  active_project_pins?: number;
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

interface ItemMetadata {
  classification?: MemoryItem["classification"];
  provenance?: MutationProvenance;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...new Set(value)]
    : undefined;
}

function mutationProvenance(value: unknown): MutationProvenance | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const sourceEntryIds = stringList(record.sourceEntryIds);
  const contradicts = stringList(record.contradicts);
  if (typeof record.sourceSessionId !== "string"
    || typeof record.mutationEntryId !== "string"
    || !sourceEntryIds
    || !contradicts) {
    return undefined;
  }
  return {
    sourceSessionId: record.sourceSessionId,
    ...(typeof record.sourceSessionFile === "string"
      ? { sourceSessionFile: record.sourceSessionFile }
      : {}),
    mutationEntryId: record.mutationEntryId,
    ...(typeof record.sourceBranchEntryId === "string"
      ? { sourceBranchEntryId: record.sourceBranchEntryId }
      : {}),
    sourceEntryIds,
    ...(typeof record.supersedes === "string" ? { supersedes: record.supersedes } : {}),
    contradicts,
  };
}

function metadata(value: string): ItemMetadata {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object") return {};
  const record = parsed as { classification?: unknown; provenance?: unknown };
  const classification = record.classification === "normal"
    || record.classification === "internal"
    || record.classification === "sensitive"
    || record.classification === "local-only"
    ? record.classification
    : undefined;
  const provenance = mutationProvenance(record.provenance);
  return {
    ...(classification ? { classification } : {}),
    ...(provenance ? { provenance } : {}),
  };
}

function entryIdFromKey(entryKey: string): string {
  const separator = entryKey.indexOf(":");
  return separator < 0 ? entryKey : entryKey.slice(separator + 1);
}

function identityKey(item: MemoryItem): string | undefined {
  if (!item.key || item.status !== "active") return undefined;
  return [item.scope, item.sessionId ?? "", item.projectPath ?? "", item.key].join("\0");
}

function memoryMutationMatchesSource(item: MemoryItem, row: MutationRow): boolean {
  return item.scope === "session"
    ? item.sessionId === row.session_id
    : item.projectPath === row.source_project_path;
}

function pinMutationMatchesSource(item: PinItem, row: MutationRow): boolean {
  return item.scope === "project"
    ? item.projectPath === row.source_project_path
    : item.sessionId === row.session_id;
}

function mapMemory(row: MemoryRow, sourceEntryIds: string[]): MemoryItem {
  const stored = metadata(row.metadata_json);
  const fallbackSessionId = row.origin_session_id ?? row.session_id ?? "legacy";
  return {
    id: row.memory_id,
    scope: row.scope,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.project_path ? { projectPath: row.project_path } : {}),
    ...(row.memory_key ? { key: row.memory_key } : {}),
    ...(stored.classification ? { classification: stored.classification } : {}),
    claim: row.claim,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    originSessionId: fallbackSessionId,
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    ...(row.status_reason ? { statusReason: row.status_reason } : {}),
    sourceEntryIds,
    provenance: stored.provenance ?? {
      sourceSessionId: fallbackSessionId,
      mutationEntryId: sourceEntryIds.at(-1) ?? row.memory_id,
      sourceEntryIds,
      contradicts: [],
    },
  };
}

function mapPin(row: PinRow): PinItem {
  const stored = metadata(row.metadata_json);
  const fallbackSessionId = row.session_id ?? "legacy";
  const fallbackEntryId = row.source_entry_id ?? row.pin_id;
  return {
    id: row.pin_id,
    scope: row.scope,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.project_path ? { projectPath: row.project_path } : {}),
    ...(row.branch_leaf_id ? { branchLeafId: row.branch_leaf_id } : {}),
    ...(stored.classification ? { classification: stored.classification } : {}),
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    ...(row.status_reason ? { statusReason: row.status_reason } : {}),
    ...(row.source_entry_id ? { sourceEntryId: row.source_entry_id } : {}),
    ...(row.source_file ? { sourceFile: row.source_file } : {}),
    provenance: stored.provenance ?? {
      sourceSessionId: fallbackSessionId,
      mutationEntryId: fallbackEntryId,
      sourceEntryIds: [fallbackEntryId],
      contradicts: [],
    },
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
      this.database.prepare(`
        DELETE FROM project_memory_sessions AS source
        WHERE source.session_id = ? AND source.status <> 'ready'
          AND NOT EXISTS (
            SELECT 1 FROM project_memory_source_exclusions AS exclusion
            WHERE exclusion.project_path = source.project_path
              AND exclusion.session_id = source.session_id
          )
      `).run(sessionId);
      this.database.prepare("DELETE FROM memory_mutations WHERE session_id = ?").run(sessionId);
      this.database.prepare("DELETE FROM pin_mutations WHERE session_id = ?").run(sessionId);
      this.insertMemoryMutations(memoryMutations);
      this.insertPinMutations(pinMutations);
      return this.materialize();
    });
  }

  getProjectSourceState(
    projectPath: string,
    sessionId: string,
  ): ProjectMemorySourceCheckpoint | undefined {
    const row = this.database.prepare(`
      SELECT project_path, session_id, session_file, header_hash, file_size,
        file_mtime_ms, checkpoint_offset, checkpoint_hash_start, checkpoint_hash,
        indexed_records, indexed_mutations, malformed_lines, status, last_error,
        indexed_at, NULL AS excluded_at, NULL AS exclusion_reason
      FROM project_memory_sessions
      WHERE project_path = ? AND session_id = ?
    `).get(projectPath, sessionId) as unknown as ProjectMemorySourceRow | undefined;
    return row ? this.mapProjectSourceCheckpoint(row) : undefined;
  }

  replaceProjectSource(
    checkpoint: ProjectMemorySourceCheckpoint,
    memoryMutations: readonly StoredMemoryMutation[],
    pinMutations: readonly StoredPinMutation[],
  ): MemoryMaterializationResult {
    return this.writes.transaction("project-memory-source-rebuild", () => {
      this.database.prepare("DELETE FROM memory_mutations WHERE session_id = ?").run(checkpoint.sessionId);
      this.database.prepare("DELETE FROM pin_mutations WHERE session_id = ?").run(checkpoint.sessionId);
      this.insertMemoryMutations(memoryMutations);
      this.insertPinMutations(pinMutations);
      this.writeProjectSourceState(checkpoint);
      return this.materialize();
    });
  }

  appendProjectSource(
    checkpoint: ProjectMemorySourceCheckpoint,
    memoryMutations: readonly StoredMemoryMutation[],
    pinMutations: readonly StoredPinMutation[],
  ): MemoryMaterializationResult {
    return this.writes.transaction("project-memory-source-append", () => {
      this.insertMemoryMutations(memoryMutations, true);
      this.insertPinMutations(pinMutations, true);
      this.writeProjectSourceState(checkpoint);
      return this.materialize();
    });
  }

  markProjectSourceUnavailable(
    projectPath: string,
    sessionId: string,
    status: "missing" | "corrupt",
    error: string,
    indexedAt: number,
  ): MemoryMaterializationResult | undefined {
    return this.writes.transaction("project-memory-source-unavailable", () => {
      const existing = this.getProjectSourceState(projectPath, sessionId);
      if (!existing) return undefined;
      const lastError = error.slice(0, 1_000);
      if (existing.status === status
        && existing.indexedMutations === 0
        && existing.lastError === lastError) {
        return undefined;
      }
      this.writeProjectSourceState({
        ...existing,
        indexedMutations: 0,
        status,
        lastError,
        indexedAt,
      });
      return this.materialize();
    });
  }

  setProjectSourceExcluded(
    projectPath: string,
    sessionId: string,
    excluded: boolean,
    excludedAt: number,
    reason?: string,
  ): MemoryMaterializationResult {
    return this.writes.transaction("project-memory-source-exclusion", () => {
      if (excluded) {
        this.database.prepare(`
          INSERT INTO project_memory_source_exclusions(project_path, session_id, excluded_at, reason)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(project_path, session_id) DO UPDATE SET
            excluded_at = excluded.excluded_at,
            reason = excluded.reason
        `).run(projectPath, sessionId, excludedAt, reason?.slice(0, 500) ?? null);
      } else {
        this.database.prepare(`
          DELETE FROM project_memory_source_exclusions
          WHERE project_path = ? AND session_id = ?
        `).run(projectPath, sessionId);
      }
      return this.materialize();
    });
  }

  listProjectSources(projectPath: string): ProjectMemorySource[] {
    const rows = this.database.prepare(`
      SELECT state.project_path, state.session_id, state.session_file, state.header_hash,
        state.file_size, state.file_mtime_ms, state.checkpoint_offset,
        state.checkpoint_hash_start, state.checkpoint_hash, state.indexed_records,
        state.indexed_mutations, state.malformed_lines, state.status, state.last_error,
        state.indexed_at, exclusion.excluded_at, exclusion.reason AS exclusion_reason,
        (SELECT count(*) FROM memory_items AS memory
          WHERE memory.scope = 'project' AND memory.project_path = state.project_path
            AND memory.origin_session_id = state.session_id AND memory.status = 'active')
          AS active_project_memories,
        (SELECT count(*) FROM pins AS pin
          WHERE pin.scope = 'project' AND pin.project_path = state.project_path
            AND pin.session_id = state.session_id AND pin.status = 'active')
          AS active_project_pins
      FROM project_memory_sessions AS state
      LEFT JOIN project_memory_source_exclusions AS exclusion
        ON exclusion.project_path = state.project_path AND exclusion.session_id = state.session_id
      WHERE state.project_path = ?
      ORDER BY state.indexed_at DESC, state.session_id
    `).all(projectPath) as unknown as ProjectMemorySourceRow[];
    return rows.map((row) => ({
      projectPath: row.project_path,
      sessionId: row.session_id,
      sessionFile: row.session_file,
      status: row.excluded_at !== null ? "excluded" : row.status,
      indexedRecords: row.indexed_records,
      indexedMutations: row.indexed_mutations,
      malformedLines: row.malformed_lines,
      activeProjectMemories: row.active_project_memories ?? 0,
      activeProjectPins: row.active_project_pins ?? 0,
      indexedAt: row.indexed_at,
      ...(row.last_error ? { lastError: row.last_error } : {}),
      ...(row.exclusion_reason ? { exclusionReason: row.exclusion_reason } : {}),
    }));
  }

  getMemory(id: string): MemoryItem | undefined {
    const row = this.database.prepare("SELECT * FROM memory_items WHERE memory_id = ?").get(id) as MemoryRow | undefined;
    return row ? mapMemory(row, this.memorySourceIds(id)) : undefined;
  }

  listMemories(options: {
    sessionId: string;
    projectPath: string;
    includeProject: boolean;
    includeCrossSessionProject?: boolean;
    activeOnly?: boolean;
  }): MemoryItem[] {
    const status = options.activeOnly === false ? "" : "AND status = 'active'";
    const rows = this.database.prepare(`
      SELECT * FROM memory_items
      WHERE (
        (scope = 'session' AND session_id = ?)
        OR (scope = 'project' AND project_path = ? AND ? = 1
          AND (? = 1 OR origin_session_id = ?))
      ) ${status}
      ORDER BY created_at DESC, memory_id
    `).all(
      options.sessionId,
      options.projectPath,
      options.includeProject ? 1 : 0,
      options.includeCrossSessionProject ? 1 : 0,
      options.sessionId,
    ) as unknown as MemoryRow[];
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
    includeCrossSessionProject?: boolean;
    activeOnly?: boolean;
  }): PinItem[] {
    const status = options.activeOnly === false ? "" : "AND status = 'active'";
    const rows = this.database.prepare(`
      SELECT * FROM pins
      WHERE (
        (scope IN ('session', 'branch') AND session_id = ?)
        OR (scope = 'project' AND project_path = ? AND ? = 1
          AND (? = 1 OR session_id = ?))
      ) ${status}
      ORDER BY created_at ASC, pin_id
    `).all(
      options.sessionId,
      options.projectPath,
      options.includeProject ? 1 : 0,
      options.includeCrossSessionProject ? 1 : 0,
      options.sessionId,
    ) as unknown as PinRow[];
    return rows.map(mapPin);
  }

  stats(sessionId: string, projectPath: string, includeCrossSessionProject = true): {
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
      WHERE (scope = 'session' AND session_id = ?)
         OR (scope = 'project' AND project_path = ? AND (? = 1 OR origin_session_id = ?))
    `).get(sessionId, projectPath, includeCrossSessionProject ? 1 : 0, sessionId) as { active: number; inactive: number };
    const pins = this.database.prepare(`
      SELECT
        COALESCE(sum(status = 'active'), 0) AS active,
        COALESCE(sum(status <> 'active'), 0) AS inactive
      FROM pins
      WHERE (scope IN ('session', 'branch') AND session_id = ?)
         OR (scope = 'project' AND project_path = ? AND (? = 1 OR session_id = ?))
    `).get(sessionId, projectPath, includeCrossSessionProject ? 1 : 0, sessionId) as { active: number; inactive: number };
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
      SELECT mutation.mutation_key, mutation.mutation_id, mutation.session_id,
        session.session_file, session.project_path AS source_project_path,
        mutation.created_at, mutation.entry_order, mutation.source_parent_entry_id,
        CASE
          WHEN exclusion.session_id IS NOT NULL THEN 0
          WHEN source.status IS NOT NULL AND source.status <> 'ready' THEN 0
          ELSE 1
        END AS source_project_enabled,
        mutation.payload_json
      FROM memory_mutations AS mutation
      JOIN sessions AS session ON session.session_id = mutation.session_id
      LEFT JOIN project_memory_sessions AS source
        ON source.project_path = session.project_path
          AND source.session_id = mutation.session_id
      LEFT JOIN project_memory_source_exclusions AS exclusion
        ON exclusion.project_path = session.project_path
          AND exclusion.session_id = mutation.session_id
      ORDER BY mutation.created_at, mutation.session_id, mutation.entry_order,
        mutation.mutation_id, mutation.mutation_key
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
      SELECT mutation.mutation_key, mutation.mutation_id, mutation.session_id,
        session.session_file, session.project_path AS source_project_path,
        mutation.created_at, mutation.entry_order, mutation.source_parent_entry_id,
        CASE
          WHEN exclusion.session_id IS NOT NULL THEN 0
          WHEN source.status IS NOT NULL AND source.status <> 'ready' THEN 0
          ELSE 1
        END AS source_project_enabled,
        mutation.payload_json
      FROM pin_mutations AS mutation
      JOIN sessions AS session ON session.session_id = mutation.session_id
      LEFT JOIN project_memory_sessions AS source
        ON source.project_path = session.project_path
          AND source.session_id = mutation.session_id
      LEFT JOIN project_memory_source_exclusions AS exclusion
        ON exclusion.project_path = session.project_path
          AND exclusion.session_id = mutation.session_id
      ORDER BY mutation.created_at, mutation.session_id, mutation.entry_order,
        mutation.mutation_id, mutation.mutation_key
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
      memory.item.provenance.contradicts = [
        ...new Set([...memory.item.provenance.contradicts, previousId]),
      ];
      const previous = memories.get(previousId);
      if (previous) {
        previous.item.provenance.contradicts = [
          ...new Set([...previous.item.provenance.contradicts, memory.item.id]),
        ];
      }
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
        JSON.stringify({
          ...(item.classification ? { classification: item.classification } : {}),
          provenance: item.provenance,
        }),
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
        JSON.stringify({
          ...(item.classification ? { classification: item.classification } : {}),
          provenance: item.provenance,
        }),
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
          if (row.source_project_enabled === 0) return;
          warnings.push(`Memory status mutation ${mutation.mutationId} references missing ${mutation.memoryId}`);
          return;
        }
        if (existing.item.scope === "project" && row.source_project_enabled === 0) return;
        if (!memoryMutationMatchesSource(existing.item, row)) {
          warnings.push(`Memory status mutation ${mutation.mutationId} crosses its source project/session scope`);
          return;
        }
        existing.item.status = mutation.status;
        existing.item.updatedAt = mutation.createdAt;
        existing.item.statusReason = mutation.reason;
        existing.item.supersededBy = undefined;
        return;
      }
      if (mutation.operation === "supersede") {
        if (mutation.item.scope === "project" && row.source_project_enabled === 0) return;
        const previous = memories.get(mutation.previousId);
        if (!previous) {
          warnings.push(`Memory supersession ${mutation.mutationId} references missing ${mutation.previousId}`);
          return;
        }
        const replacement = memories.get(mutation.item.id);
        if (!replacement
          || replacement.item.provenance.sourceSessionId !== row.session_id
          || replacement.item.provenance.mutationEntryId !== entryIdFromKey(row.mutation_key)) {
          warnings.push(`Memory supersession ${mutation.mutationId} has no valid replacement ${mutation.item.id}`);
          return;
        }
        if (previous.item.scope !== replacement.item.scope
          || !memoryMutationMatchesSource(previous.item, row)) {
          warnings.push(`Memory supersession ${mutation.mutationId} crosses its source project/session scope`);
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
    if (value.scope === "project" && row.source_project_enabled === 0) return;
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
    if (value.scope === "project" && value.projectPath !== row.source_project_path) {
      warnings.push(`Project memory ${value.id} does not match its canonical source project`);
      return;
    }
    const sourceKeys = new Set<string>([
      row.mutation_key,
      ...value.sourceEntryIds.map((entryId) => `${row.session_id}:${entryId}`),
    ]);
    const mutationEntryId = entryIdFromKey(row.mutation_key);
    const sourceEntryIds = [...new Set([mutationEntryId, ...value.sourceEntryIds])];
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
      sourceEntryIds,
      provenance: {
        sourceSessionId: row.session_id,
        sourceSessionFile: row.session_file,
        mutationEntryId,
        ...(row.source_parent_entry_id
          ? { sourceBranchEntryId: row.source_parent_entry_id }
          : {}),
        sourceEntryIds,
        ...(mutation.operation === "supersede" ? { supersedes: mutation.previousId } : {}),
        contradicts: [],
      },
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
          if (row.source_project_enabled === 0) return;
          warnings.push(`Pin status mutation ${mutation.mutationId} references missing ${mutation.pinId}`);
          return;
        }
        if (existing.scope === "project" && row.source_project_enabled === 0) return;
        if (!pinMutationMatchesSource(existing, row)) {
          warnings.push(`Pin status mutation ${mutation.mutationId} crosses its source project/session scope`);
          return;
        }
        existing.status = mutation.status;
        existing.updatedAt = mutation.createdAt;
        existing.statusReason = mutation.reason;
        existing.supersededBy = undefined;
        return;
      }
      if (mutation.operation === "supersede") {
        if (mutation.item.scope === "project" && row.source_project_enabled === 0) return;
        const previous = pins.get(mutation.previousId);
        if (!previous) {
          warnings.push(`Pin supersession ${mutation.mutationId} references missing ${mutation.previousId}`);
          return;
        }
        const replacement = pins.get(mutation.item.id);
        if (!replacement
          || replacement.provenance.sourceSessionId !== row.session_id
          || replacement.provenance.mutationEntryId !== entryIdFromKey(row.mutation_key)) {
          warnings.push(`Pin supersession ${mutation.mutationId} has no valid replacement ${mutation.item.id}`);
          return;
        }
        if (previous.scope !== replacement.scope || !pinMutationMatchesSource(previous, row)) {
          warnings.push(`Pin supersession ${mutation.mutationId} crosses its source project/session scope`);
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
    if (value.scope === "project" && row.source_project_enabled === 0) return;
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
    if (value.scope === "project" && value.projectPath !== row.source_project_path) {
      warnings.push(`Project pin ${value.id} does not match its canonical source project`);
      return;
    }
    if (value.scope === "branch" && !value.branchLeafId) {
      warnings.push(`Branch pin ${value.id} has no branch leaf`);
      return;
    }
    const mutationEntryId = entryIdFromKey(row.mutation_key);
    const sourceEntryId = value.sourceEntryId ?? mutationEntryId;
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
      sourceEntryId,
      ...(value.sourceFile ? { sourceFile: value.sourceFile } : {}),
      provenance: {
        sourceSessionId: row.session_id,
        sourceSessionFile: row.session_file,
        mutationEntryId,
        ...(row.source_parent_entry_id
          ? { sourceBranchEntryId: row.source_parent_entry_id }
          : {}),
        sourceEntryIds: [...new Set([sourceEntryId, mutationEntryId])],
        ...(mutation.operation === "supersede" ? { supersedes: mutation.previousId } : {}),
        contradicts: [],
      },
    };
    pins.set(item.id, item);
  }

  private insertMemoryMutations(
    mutations: readonly StoredMemoryMutation[],
    ignoreExisting = false,
  ): void {
    const insert = this.database.prepare(`
      INSERT ${ignoreExisting ? "OR IGNORE" : ""} INTO memory_mutations(
        mutation_key, mutation_id, session_id, created_at, entry_order,
        source_parent_entry_id, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const existingIds = ignoreExisting
      ? new Set((this.database.prepare("SELECT mutation_id FROM memory_mutations WHERE session_id = ?")
          .all(mutations[0]?.sessionId ?? "") as unknown as Array<{ mutation_id: string }>)
          .map((row) => row.mutation_id))
      : new Set<string>();
    for (const mutation of mutations) {
      if (existingIds.has(mutation.mutationId)) continue;
      existingIds.add(mutation.mutationId);
      insert.run(
        mutation.mutationKey,
        mutation.mutationId,
        mutation.sessionId,
        mutation.createdAt,
        mutation.entryOrder,
        mutation.sourceParentEntryId ?? null,
        JSON.stringify(mutation.payload),
      );
    }
  }

  private insertPinMutations(
    mutations: readonly StoredPinMutation[],
    ignoreExisting = false,
  ): void {
    const insert = this.database.prepare(`
      INSERT ${ignoreExisting ? "OR IGNORE" : ""} INTO pin_mutations(
        mutation_key, mutation_id, session_id, created_at, entry_order,
        source_parent_entry_id, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const existingIds = ignoreExisting
      ? new Set((this.database.prepare("SELECT mutation_id FROM pin_mutations WHERE session_id = ?")
          .all(mutations[0]?.sessionId ?? "") as unknown as Array<{ mutation_id: string }>)
          .map((row) => row.mutation_id))
      : new Set<string>();
    for (const mutation of mutations) {
      if (existingIds.has(mutation.mutationId)) continue;
      existingIds.add(mutation.mutationId);
      insert.run(
        mutation.mutationKey,
        mutation.mutationId,
        mutation.sessionId,
        mutation.createdAt,
        mutation.entryOrder,
        mutation.sourceParentEntryId ?? null,
        JSON.stringify(mutation.payload),
      );
    }
  }

  private writeProjectSourceState(checkpoint: ProjectMemorySourceCheckpoint): void {
    this.database.prepare(`
      INSERT INTO project_memory_sessions(
        project_path, session_id, session_file, header_hash, file_size,
        file_mtime_ms, checkpoint_offset, checkpoint_hash_start, checkpoint_hash,
        indexed_records, indexed_mutations, malformed_lines, status, last_error,
        indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_path, session_id) DO UPDATE SET
        session_file = excluded.session_file,
        header_hash = excluded.header_hash,
        file_size = excluded.file_size,
        file_mtime_ms = excluded.file_mtime_ms,
        checkpoint_offset = excluded.checkpoint_offset,
        checkpoint_hash_start = excluded.checkpoint_hash_start,
        checkpoint_hash = excluded.checkpoint_hash,
        indexed_records = excluded.indexed_records,
        indexed_mutations = excluded.indexed_mutations,
        malformed_lines = excluded.malformed_lines,
        status = excluded.status,
        last_error = excluded.last_error,
        indexed_at = excluded.indexed_at
    `).run(
      checkpoint.projectPath,
      checkpoint.sessionId,
      checkpoint.sessionFile,
      checkpoint.headerHash,
      checkpoint.fileSize,
      checkpoint.fileMtimeMs,
      checkpoint.checkpointOffset,
      checkpoint.checkpointHashStart,
      checkpoint.checkpointHash ?? null,
      checkpoint.indexedRecords,
      checkpoint.indexedMutations,
      checkpoint.malformedLines,
      checkpoint.status,
      checkpoint.lastError ?? null,
      checkpoint.indexedAt,
    );
  }

  private mapProjectSourceCheckpoint(row: ProjectMemorySourceRow): ProjectMemorySourceCheckpoint {
    return {
      projectPath: row.project_path,
      sessionId: row.session_id,
      sessionFile: row.session_file,
      headerHash: row.header_hash,
      fileSize: row.file_size,
      fileMtimeMs: row.file_mtime_ms,
      checkpointOffset: row.checkpoint_offset,
      checkpointHashStart: row.checkpoint_hash_start,
      ...(row.checkpoint_hash ? { checkpointHash: row.checkpoint_hash } : {}),
      indexedRecords: row.indexed_records,
      indexedMutations: row.indexed_mutations,
      malformedLines: row.malformed_lines,
      status: row.status,
      ...(row.last_error ? { lastError: row.last_error } : {}),
      indexedAt: row.indexed_at,
    };
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
