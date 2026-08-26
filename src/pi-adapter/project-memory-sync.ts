import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  CrossSessionMemoryDiagnostics,
  MemoryMaterializationResult,
  ProjectMemorySource,
  SessionMutationProjection,
} from "ds4-context-core/memory/memory-types";
import type {
  MemoryRepository,
  ProjectMemorySourceCheckpoint,
} from "ds4-context-core/persistence/repositories/memory-repository";
import type { Logger } from "ds4-context-core/shared/logging";
import { silentLogger } from "ds4-context-core/shared/logging";
import { projectJsonlMutations } from "./memory-adapter.ts";
import {
  hashFileRange,
  readJsonlRecords,
  readSessionHeaderRecord,
  type JsonlReadResult,
  type SessionHeaderRecord,
} from "./session-jsonl.ts";
import { PiSessionIndexer } from "./session-indexer.ts";

const SUPPORTED_SESSION_VERSION = 3;

export interface ProjectMemorySynchronizerOptions {
  projectPath: string;
  activeSessionId: string;
  activeSessionFile: string;
  maxSessions: number;
  logger?: Logger;
  now?: () => number;
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function comparablePath(path: string): string {
  const canonical = canonicalPath(path);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sourceCheckpoint(
  projectPath: string,
  sessionId: string,
  sessionFile: string,
  header: SessionHeaderRecord,
  read: JsonlReadResult,
  indexedRecords: number,
  indexedMutations: number,
  malformedLines: number,
  indexedAt: number,
  previous?: ProjectMemorySourceCheckpoint,
): ProjectMemorySourceCheckpoint {
  const hasNewTerminatedLine = read.checkpointHash !== undefined;
  return {
    projectPath,
    sessionId,
    sessionFile,
    headerHash: header.rawHash,
    fileSize: read.fileSize,
    fileMtimeMs: read.fileMtimeMs,
    checkpointOffset: hasNewTerminatedLine
      ? read.safeCheckpointOffset
      : previous?.checkpointOffset ?? read.safeCheckpointOffset,
    checkpointHashStart: hasNewTerminatedLine
      ? read.checkpointHashStart
      : previous?.checkpointHashStart ?? read.checkpointHashStart,
    ...(hasNewTerminatedLine
      ? { checkpointHash: read.checkpointHash }
      : previous?.checkpointHash
        ? { checkpointHash: previous.checkpointHash }
        : {}),
    indexedRecords,
    indexedMutations,
    malformedLines,
    status: "ready",
    indexedAt,
  };
}

function mutationCount(projection: SessionMutationProjection): number {
  const projectMemories = projection.memoryMutations.filter((stored) =>
    stored.payload.operation === "status" || stored.payload.item.scope === "project"
  ).length;
  const projectPins = projection.pinMutations.filter((stored) =>
    stored.payload.operation === "status" || stored.payload.item.scope === "project"
  ).length;
  return projectMemories + projectPins;
}

function diagnostics(
  enabled: boolean,
  sources: ProjectMemorySource[],
  discoveredSessions: number,
  refreshedSessions: number,
  incrementalSessions: number,
  rebuiltSessions: number,
  warnings: string[],
  lastSyncAt?: number,
): CrossSessionMemoryDiagnostics {
  return {
    enabled,
    status: enabled ? "ready" : "disabled",
    discoveredSessions,
    contributingSessions: sources.filter((source) =>
      source.status === "ready" && source.indexedMutations > 0
    ).length,
    excludedSessions: sources.filter((source) => source.status === "excluded").length,
    unavailableSessions: sources.filter((source) =>
      source.status === "missing" || source.status === "corrupt"
    ).length,
    refreshedSessions,
    incrementalSessions,
    rebuiltSessions,
    sources,
    warnings,
    ...(lastSyncAt !== undefined ? { lastSyncAt } : {}),
  };
}

export class ProjectMemorySynchronizer {
  private readonly projectPath: string;
  private readonly comparableProjectPath: string;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(
    private readonly repository: MemoryRepository,
    private readonly indexer: PiSessionIndexer,
    private readonly options: ProjectMemorySynchronizerOptions,
  ) {
    this.projectPath = canonicalPath(options.projectPath);
    this.comparableProjectPath = comparablePath(this.projectPath);
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? Date.now;
  }

  sync(): CrossSessionMemoryDiagnostics {
    const warnings: string[] = [];
    let discoveredSessions = 0;
    let refreshedSessions = 0;
    let incrementalSessions = 0;
    let rebuiltSessions = 0;
    let latestMaterializationWarnings: string[] = [];
    const syncedAt = this.now();
    const previousSources = this.repository.listProjectSources(this.projectPath);
    const candidates = this.discoverCandidates(previousSources, warnings);
    const seenSessionIds = new Set<string>();

    for (const sessionFile of candidates) {
      let header: SessionHeaderRecord;
      try {
        header = readSessionHeaderRecord(sessionFile);
      } catch (error) {
        const previous = previousSources.find((source) => source.sessionFile === sessionFile);
        const message = `Project memory source ${sessionFile} has an invalid header: ${errorMessage(error)}`;
        warnings.push(message);
        if (previous) {
          seenSessionIds.add(previous.sessionId);
          const materialized = this.markSourceUnavailable(
            previous.sessionId,
            "corrupt",
            message,
            syncedAt,
          );
          if (materialized) latestMaterializationWarnings = materialized.warnings;
        }
        continue;
      }

      const headerCwd = header.value.cwd;
      if (typeof headerCwd !== "string"
        || comparablePath(headerCwd) !== this.comparableProjectPath) {
        const previous = previousSources.find((source) => source.sessionFile === sessionFile);
        if (previous) {
          seenSessionIds.add(previous.sessionId);
          const message = `Project memory source identity no longer matches ${this.projectPath}`;
          warnings.push(`${sessionFile}: ${message}`);
          const materialized = this.markSourceUnavailable(
            previous.sessionId,
            "corrupt",
            message,
            syncedAt,
          );
          if (materialized) latestMaterializationWarnings = materialized.warnings;
        }
        continue;
      }
      const version = header.value.version;
      if (typeof version === "number" && version > SUPPORTED_SESSION_VERSION) {
        const message = `Unsupported Pi session format v${version}`;
        warnings.push(`${sessionFile}: ${message}`);
        const previous = previousSources.find((source) => source.sessionFile === sessionFile);
        if (previous) {
          seenSessionIds.add(previous.sessionId);
          const materialized = this.markSourceUnavailable(
            previous.sessionId,
            "corrupt",
            message,
            syncedAt,
          );
          if (materialized) latestMaterializationWarnings = materialized.warnings;
        }
        continue;
      }
      if (seenSessionIds.has(header.value.id)) {
        warnings.push(`Duplicate Pi session id ${header.value.id} ignored at ${sessionFile}`);
        continue;
      }
      seenSessionIds.add(header.value.id);
      const crossSessionSource = header.value.id !== this.options.activeSessionId;
      if (crossSessionSource) discoveredSessions++;

      try {
        const synced = this.syncSource(sessionFile, header, syncedAt, warnings);
        if (synced.mode !== "noop") latestMaterializationWarnings = synced.materializationWarnings;
        if (crossSessionSource && synced.mode !== "noop") refreshedSessions++;
        if (crossSessionSource && synced.mode === "incremental") incrementalSessions++;
        if (crossSessionSource && synced.mode === "rebuild") rebuiltSessions++;
      } catch (error) {
        const message = errorMessage(error);
        const disposition = header.value.id === this.options.activeSessionId
          ? "retained after refresh failure"
          : "excluded";
        warnings.push(`Project memory source ${header.value.id} ${disposition}: ${message}`);
        const materialized = this.markSourceUnavailable(
          header.value.id,
          "corrupt",
          message,
          syncedAt,
        );
        if (materialized) latestMaterializationWarnings = materialized.warnings;
        this.logger.warn("project_memory.source_failed", {
          projectPath: this.projectPath,
          sessionId: header.value.id,
          sessionFile,
          error: message,
        });
      }
    }

    const candidateSet = new Set(candidates.map((path) => resolve(path)));
    for (const source of previousSources) {
      if (seenSessionIds.has(source.sessionId)) continue;
      const present = existsSync(source.sessionFile);
      const message = present && !candidateSet.has(resolve(source.sessionFile))
        ? `Project memory source is outside memory.maxProjectSessions: ${source.sessionFile}`
        : `Canonical Pi session file is missing: ${source.sessionFile}`;
      const materialized = this.markSourceUnavailable(
        source.sessionId,
        present ? "corrupt" : "missing",
        message,
        syncedAt,
      );
      if (materialized) latestMaterializationWarnings = materialized.warnings;
      warnings.push(message);
    }

    const allSources = this.repository.listProjectSources(this.projectPath);
    for (const source of allSources) {
      if (source.malformedLines > 0) {
        warnings.push(
          `Project memory source ${source.sessionId} contains ${source.malformedLines} malformed JSONL line(s)`,
        );
      }
      if (source.lastError && !warnings.some((warning) => warning.includes(source.lastError ?? ""))) {
        warnings.push(`Project memory source ${source.sessionId}: ${source.lastError}`);
      }
    }
    warnings.push(...latestMaterializationWarnings);
    const uniqueWarnings = [...new Set(warnings)];
    const sources = allSources.filter((source) =>
      source.sessionId !== this.options.activeSessionId || source.status === "excluded"
    );
    const result = diagnostics(
      true,
      sources,
      discoveredSessions,
      refreshedSessions,
      incrementalSessions,
      rebuiltSessions,
      uniqueWarnings,
      syncedAt,
    );
    this.logger.debug("project_memory.synced", {
      projectPath: this.projectPath,
      discoveredSessions,
      contributingSessions: result.contributingSessions,
      refreshedSessions,
      incrementalSessions,
      rebuiltSessions,
      warnings: uniqueWarnings.length,
    });
    return result;
  }

  setExcluded(sessionId: string, excluded: boolean, reason?: string): CrossSessionMemoryDiagnostics {
    if (excluded && sessionId === this.options.activeSessionId) {
      throw new Error("The active Pi session cannot be excluded as a project memory source");
    }
    const source = this.repository.listProjectSources(this.projectPath)
      .find((candidate) => candidate.sessionId === sessionId);
    if (!source) throw new Error(`Project memory source session ${sessionId} was not discovered`);
    const materialized = this.repository.setProjectSourceExcluded(
      this.projectPath,
      sessionId,
      excluded,
      this.now(),
      reason,
    );
    const result = this.sync();
    return {
      ...result,
      warnings: [...new Set([...result.warnings, ...materialized.warnings])],
    };
  }

  private markSourceUnavailable(
    sessionId: string,
    status: "missing" | "corrupt",
    message: string,
    indexedAt: number,
  ): MemoryMaterializationResult | undefined {
    if (sessionId === this.options.activeSessionId) {
      this.logger.warn("project_memory.active_source_retained", {
        projectPath: this.projectPath,
        sessionId,
        error: message,
      });
      return undefined;
    }
    return this.repository.markProjectSourceUnavailable(
      this.projectPath,
      sessionId,
      status,
      message,
      indexedAt,
    );
  }

  private discoverCandidates(
    previousSources: readonly ProjectMemorySource[],
    warnings: string[],
  ): string[] {
    const directory = dirname(this.options.activeSessionFile);
    let names: string[] = [];
    try {
      names = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => join(directory, entry.name))
        .sort((left, right) => right.localeCompare(left));
    } catch (error) {
      warnings.push(`Unable to enumerate Pi project sessions in ${directory}: ${errorMessage(error)}`);
    }

    const active = resolve(this.options.activeSessionFile);
    const siblings = names.filter((path) => resolve(path) !== active);
    if (siblings.length > this.options.maxSessions) {
      warnings.push(
        `Project session discovery capped at memory.maxProjectSessions (${this.options.maxSessions})`,
      );
    }
    names = [active, ...siblings.slice(0, this.options.maxSessions)];
    for (const source of previousSources) {
      if (source.sessionId === this.options.activeSessionId
        || names.includes(source.sessionFile)
        || !existsSync(source.sessionFile)) {
        continue;
      }
      if (names.length - 1 >= this.options.maxSessions) break;
      names.push(source.sessionFile);
    }
    return [...new Set(names)];
  }

  private syncSource(
    sessionFile: string,
    header: SessionHeaderRecord,
    indexedAt: number,
    warnings: string[],
  ): { mode: "noop" | "incremental" | "rebuild"; materializationWarnings: string[] } {
    const sessionId = header.value.id;
    const previous = this.repository.getProjectSourceState(this.projectPath, sessionId);
    const stat = statSync(sessionFile);
    const rebuildReason = this.rebuildReason(sessionFile, header, stat.size, stat.mtimeMs, previous);

    this.indexer.sync({
      sessionId,
      sessionFile,
      projectPath: this.projectPath,
      totalEntries: 0,
      branchEntries: 0,
    }, Boolean(rebuildReason));

    if (!rebuildReason && previous
      && stat.size === previous.fileSize
      && stat.mtimeMs === previous.fileMtimeMs
      && previous.status === "ready") {
      return { mode: "noop", materializationWarnings: [] };
    }

    if (rebuildReason || !previous) {
      const read = readJsonlRecords(sessionFile, 0);
      const first = read.records[0];
      if (!first || first.value.type !== "session" || first.rawHash !== header.rawHash) {
        throw new Error("Pi session header changed during project memory replay");
      }
      const projection = projectJsonlMutations(read.records.slice(1), sessionId);
      const records = read.records.filter((record) => record.value.type !== "session").length;
      const materialized = this.repository.replaceProjectSource(
        sourceCheckpoint(
          this.projectPath,
          sessionId,
          sessionFile,
          header,
          read,
          records,
          mutationCount(projection),
          read.malformedLines,
          indexedAt,
        ),
        projection.memoryMutations,
        projection.pinMutations,
      );
      warnings.push(
        ...projection.warnings.map((warning) => `${sessionId}: ${warning}`),
      );
      return { mode: "rebuild", materializationWarnings: materialized.warnings };
    }

    const read = readJsonlRecords(sessionFile, previous.checkpointOffset);
    const projection = projectJsonlMutations(read.records, sessionId, previous.indexedRecords);
    const records = read.records.filter((record) => record.value.type !== "session").length;
    const materialized = this.repository.appendProjectSource(
      sourceCheckpoint(
        this.projectPath,
        sessionId,
        sessionFile,
        header,
        read,
        previous.indexedRecords + records,
        previous.indexedMutations + mutationCount(projection),
        previous.malformedLines + read.malformedLines,
        indexedAt,
        previous,
      ),
      projection.memoryMutations,
      projection.pinMutations,
    );
    warnings.push(
      ...projection.warnings.map((warning) => `${sessionId}: ${warning}`),
    );
    return { mode: "incremental", materializationWarnings: materialized.warnings };
  }

  private rebuildReason(
    sessionFile: string,
    header: SessionHeaderRecord,
    fileSize: number,
    fileMtimeMs: number,
    previous?: ProjectMemorySourceCheckpoint,
  ): string | undefined {
    if (!previous) return "initial project memory replay";
    if (previous.status !== "ready") return `source status is ${previous.status}`;
    if (previous.sessionFile !== sessionFile) return "session file path changed";
    if (previous.headerHash !== header.rawHash) return "session header changed";
    if (fileSize < previous.fileSize) return "session file was truncated";
    if (fileSize === previous.fileSize && fileMtimeMs !== previous.fileMtimeMs) {
      return "session file changed in place";
    }
    if (fileSize > previous.fileSize && previous.checkpointOffset < previous.fileSize) {
      return "session grew after an unterminated JSONL tail";
    }
    if (previous.checkpointOffset > 0) {
      if (!previous.checkpointHash) return "project memory checkpoint hash is missing";
      const currentHash = hashFileRange(
        sessionFile,
        previous.checkpointHashStart,
        previous.checkpointOffset,
      );
      if (currentHash !== previous.checkpointHash) {
        return "project memory checkpoint no longer matches the JSONL file";
      }
    }
    return undefined;
  }
}
