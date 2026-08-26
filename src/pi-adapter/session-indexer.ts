import { existsSync, statSync } from "node:fs";
import type { Logger } from "ds4-context-core/shared/logging";
import { silentLogger } from "ds4-context-core/shared/logging";
import {
  AppendOnlyEntryChangedError,
  type SessionIdentity,
  type SessionIndexCheckpointInput,
  type SessionIndexRepository,
  type SessionIndexState,
} from "ds4-context-core/persistence/repositories/session-index-repository";
import type { PiSessionSnapshot } from "./session-reader.ts";
import { isPiSessionEntryRecord, toIndexedSessionEntry } from "./indexed-entry.ts";
import {
  hashFileRange,
  readJsonlRecords,
  readSessionHeaderRecord,
  type JsonlReadResult,
  type SessionHeaderRecord,
} from "./session-jsonl.ts";

const SUPPORTED_SESSION_VERSION = 3;

export type SessionIndexMode = "noop" | "incremental" | "rebuild" | "skipped";

export interface SessionIndexResult {
  mode: SessionIndexMode;
  reason: string;
  processedEntries: number;
  insertedEntries: number;
  totalEntries: number;
  malformedLines: number;
  durationMs: number;
}

export interface SessionIndexerOptions {
  logger?: Logger;
  now?: () => number;
  monotonicNow?: () => number;
}

function validateHeader(header: SessionHeaderRecord, expectedSessionId: string): void {
  if (header.value.id !== expectedSessionId) {
    throw new Error(
      `Session header id ${header.value.id} does not match Pi session id ${expectedSessionId}`,
    );
  }
  const version = header.value.version;
  if (typeof version === "number" && version > SUPPORTED_SESSION_VERSION) {
    throw new Error(`Pi session format v${version} is newer than supported v${SUPPORTED_SESSION_VERSION}`);
  }
}

function identity(session: PiSessionSnapshot, indexedAt: number): SessionIdentity {
  if (!session.sessionFile) throw new Error("Cannot index an ephemeral Pi session");
  return {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    projectPath: session.projectPath,
    indexedAt,
  };
}

function checkpoint(
  session: PiSessionSnapshot,
  header: SessionHeaderRecord,
  read: JsonlReadResult,
  indexedAt: number,
  previous?: SessionIndexState,
): SessionIndexCheckpointInput {
  const hasNewTerminatedLine = read.checkpointHash !== undefined;
  return {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile ?? "",
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
    malformedLines: (previous?.malformedLines ?? 0) + read.malformedLines,
    indexedAt,
  };
}

export class PiSessionIndexer {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;

  constructor(
    private readonly repository: SessionIndexRepository,
    options: SessionIndexerOptions = {},
  ) {
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  sync(session: PiSessionSnapshot, forceRebuild = false): SessionIndexResult {
    const started = this.monotonicNow();
    if (!session.sessionFile || !existsSync(session.sessionFile)) {
      return this.result("skipped", "session file is not persisted yet", 0, 0, 0, 0, started);
    }

    const header = readSessionHeaderRecord(session.sessionFile);
    validateHeader(header, session.sessionId);
    const state = this.repository.getState(session.sessionId);
    const stat = statSync(session.sessionFile);

    const rebuildReason = this.rebuildReason(session, header, state, stat.size, stat.mtimeMs, forceRebuild);
    if (rebuildReason) return this.rebuild(session, header, rebuildReason, started);

    if (!state) return this.rebuild(session, header, "missing index checkpoint", started);
    if (stat.size === state.fileSize && stat.mtimeMs === state.fileMtimeMs) {
      return this.result(
        "noop",
        "session file unchanged",
        0,
        0,
        state.indexedEntries,
        state.malformedLines,
        started,
      );
    }

    const read = readJsonlRecords(session.sessionFile, state.checkpointOffset);
    const indexedAt = this.now();
    const entries = read.records
      .filter((record) => record.value.type !== "session")
      .map((record) => toIndexedSessionEntry(session.sessionId, record, indexedAt));

    try {
      const write = this.repository.append(
        identity(session, indexedAt),
        entries,
        checkpoint(session, header, read, indexedAt, state),
      );
      const result = this.result(
        "incremental",
        "appended JSONL records",
        entries.length,
        write.inserted,
        write.totalEntries,
        state.malformedLines + read.malformedLines,
        started,
      );
      this.logger.debug("session_index.incremental", { sessionId: session.sessionId, ...result });
      return result;
    } catch (error) {
      if (error instanceof AppendOnlyEntryChangedError) {
        return this.rebuild(session, header, `append-only validation failed for ${error.entryId}`, started);
      }
      throw error;
    }
  }

  private rebuildReason(
    session: PiSessionSnapshot,
    header: SessionHeaderRecord,
    state: SessionIndexState | undefined,
    fileSize: number,
    fileMtimeMs: number,
    force: boolean,
  ): string | undefined {
    if (force) return "forced by user";
    if (!state) return "initial index";
    if (state.sessionFile !== session.sessionFile) return "session file path changed";
    if (state.headerHash !== header.rawHash) return "session header changed";
    if (fileSize < state.fileSize) return "session file was truncated";
    if (fileSize === state.fileSize && fileMtimeMs !== state.fileMtimeMs) return "session file changed in place";
    if (fileSize > state.fileSize && state.checkpointOffset < state.fileSize) {
      return "session grew after an unterminated JSONL tail";
    }
    if (state.checkpointOffset > 0) {
      if (!state.checkpointHash) return "index checkpoint hash is missing";
      const currentHash = hashFileRange(
        session.sessionFile ?? "",
        state.checkpointHashStart,
        state.checkpointOffset,
      );
      if (currentHash !== state.checkpointHash) return "index checkpoint no longer matches the JSONL file";
    }
    return undefined;
  }

  private rebuild(
    session: PiSessionSnapshot,
    header: SessionHeaderRecord,
    reason: string,
    started: number,
  ): SessionIndexResult {
    if (!session.sessionFile) throw new Error("Cannot rebuild an ephemeral Pi session index");
    const read = readJsonlRecords(session.sessionFile, 0);
    const first = read.records[0];
    if (!first || first.value.type !== "session" || first.rawHash !== header.rawHash) {
      throw new Error("Pi session header changed while rebuilding the index");
    }

    const indexedAt = this.now();
    const seen = new Set<string>();
    const entries = read.records.slice(1).map((record) => {
      if (!isPiSessionEntryRecord(record.value)) {
        throw new Error(`Invalid Pi session entry at byte ${record.startOffset}`);
      }
      if (seen.has(record.value.id)) throw new Error(`Duplicate Pi session entry id: ${record.value.id}`);
      seen.add(record.value.id);
      return toIndexedSessionEntry(session.sessionId, record, indexedAt);
    });

    const write = this.repository.rebuild(
      identity(session, indexedAt),
      entries,
      checkpoint(session, header, read, indexedAt),
    );
    const result = this.result(
      "rebuild",
      reason,
      entries.length,
      write.inserted,
      write.totalEntries,
      read.malformedLines,
      started,
    );
    this.logger.debug("session_index.rebuilt", { sessionId: session.sessionId, ...result });
    return result;
  }

  private result(
    mode: SessionIndexMode,
    reason: string,
    processedEntries: number,
    insertedEntries: number,
    totalEntries: number,
    malformedLines: number,
    started: number,
  ): SessionIndexResult {
    return {
      mode,
      reason,
      processedEntries,
      insertedEntries,
      totalEntries,
      malformedLines,
      durationMs: Math.max(0, this.monotonicNow() - started),
    };
  }
}
