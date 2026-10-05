import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { sha256 } from "ds4-context-core/shared/hash";
import type { SessionIndexRepository } from "ds4-context-core/persistence/repositories/session-index-repository";
import { toIndexedSessionEntry } from "./indexed-entry.ts";

export const MAX_HISTORY_SOURCE_BYTES = 4 * 1024 * 1024;
export function historyProjectPath(path: string): string {
  let value = resolve(path);
  try { value = realpathSync.native(value); } catch { /* Missing sources remain unavailable. */ }
  return process.platform === "win32" ? value.toLowerCase() : value;
}
export interface HistorySource {
  sessionId: string;
  sessionFile: string;
  projectPath: string;
  entryId: string;
  contentHash: string;
}
/** Only called with repository-resolved paths, never a model-supplied filesystem path. */
export function readHistorySource(repository: SessionIndexRepository, source: HistorySource): {
  text: string; raw: string; kind: string; role?: string; timestamp?: number;
} {
  const location = repository.getSourceLocation(source.sessionId, source.entryId);
  if (!location || !Number.isSafeInteger(location.startOffset) || !Number.isSafeInteger(location.endOffset)
    || location.startOffset < 0 || location.endOffset <= location.startOffset
    || location.endOffset - location.startOffset > MAX_HISTORY_SOURCE_BYTES) throw new Error("source-unavailable");
  const fd = openSync(source.sessionFile, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || location.endOffset > stat.size) throw new Error("source-unavailable");
    const read = (offset: number, length: number): Buffer => {
      const bytes = Buffer.alloc(length);
      let total = 0;
      while (total < length) {
        const count = readSync(fd, bytes, total, length - total, offset + total);
        if (!count) throw new Error("source-unavailable");
        total += count;
      }
      return bytes;
    };
    // Header and source are verified on the SAME descriptor, including after rename/replacement.
    const head = read(0, Math.min(stat.size, 1024 * 1024));
    const newline = head.indexOf(10);
    if (newline < 0) throw new Error("source-unavailable");
    const header = JSON.parse(head.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
    if (header.type !== "session" || header.id !== source.sessionId || typeof header.cwd !== "string"
      || historyProjectPath(header.cwd) !== historyProjectPath(source.projectPath)) throw new Error("source-scope-mismatch");
    let bytes = read(location.startOffset, location.endOffset - location.startOffset);
    if (bytes.at(-1) === 10) bytes = bytes.subarray(0, -1);
    if (sha256(bytes) !== source.contentHash) throw new Error("source-changed");
    const raw = bytes.toString("utf8");
    const entry = JSON.parse(raw) as Record<string, unknown>;
    if (entry.id !== source.entryId) throw new Error("source-changed");
    const indexed = toIndexedSessionEntry(source.sessionId, { value: entry, raw, rawHash: source.contentHash,
      ...location, terminated: true }, 0);
    return { text: indexed.searchableText, raw, kind: indexed.entryType,
      ...(indexed.role ? { role: indexed.role } : {}), ...(indexed.createdAt !== undefined ? { timestamp: indexed.createdAt } : {}) };
  } finally { closeSync(fd); }
}
