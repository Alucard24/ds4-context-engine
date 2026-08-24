import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { sha256 } from "../shared/hash.ts";

const READ_BUFFER_SIZE = 1024 * 1024;
const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_CHECKPOINT_HASH_BYTES = 64 * 1024;

export interface JsonlRecord {
  value: Record<string, unknown>;
  raw: string;
  rawHash: string;
  startOffset: number;
  endOffset: number;
  terminated: boolean;
}

export interface SessionHeaderRecord extends JsonlRecord {
  value: Record<string, unknown> & { type: "session"; id: string };
}

export interface JsonlReadResult {
  records: JsonlRecord[];
  malformedLines: number;
  fileSize: number;
  fileMtimeMs: number;
  safeCheckpointOffset: number;
  checkpointHashStart: number;
  checkpointHash?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseLine(
  bytes: Buffer,
  startOffset: number,
  endOffset: number,
  terminated: boolean,
): JsonlRecord | "blank" | "malformed" {
  let parseBytes = bytes;
  if (parseBytes.at(-1) === 0x0d) parseBytes = parseBytes.subarray(0, -1);
  const raw = parseBytes.toString("utf8");
  if (raw.trim().length === 0) return "blank";

  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || typeof value.type !== "string") return "malformed";
    return {
      value,
      raw,
      rawHash: sha256(bytes),
      startOffset,
      endOffset,
      terminated,
    };
  } catch {
    return "malformed";
  }
}

export function readSessionHeaderRecord(filePath: string): SessionHeaderRecord {
  if (!existsSync(filePath)) throw new Error(`Session file does not exist: ${filePath}`);

  const fd = openSync(filePath, "r");
  try {
    const stat = fstatSync(fd);
    const readLength = Math.min(stat.size, MAX_HEADER_BYTES);
    const buffer = Buffer.allocUnsafe(readLength);
    const bytesRead = readLength > 0 ? readSync(fd, buffer, 0, readLength, 0) : 0;
    const data = buffer.subarray(0, bytesRead);
    let lineStart = 0;

    for (let index = 0; index <= data.length; index++) {
      const atNewline = index < data.length && data[index] === 0x0a;
      const atCompleteEof = index === data.length && stat.size <= MAX_HEADER_BYTES;
      if (!atNewline && !atCompleteEof) continue;

      const line = data.subarray(lineStart, index);
      const parsed = parseLine(line, lineStart, atNewline ? index + 1 : index, atNewline);
      lineStart = index + 1;
      if (parsed === "blank" || parsed === "malformed") continue;
      if (parsed.value.type !== "session" || typeof parsed.value.id !== "string") {
        throw new Error(`First parsed JSONL record is not a Pi session header: ${filePath}`);
      }
      return parsed as SessionHeaderRecord;
    }

    throw new Error(`No Pi session header found within ${MAX_HEADER_BYTES} bytes: ${filePath}`);
  } finally {
    closeSync(fd);
  }
}

export function readJsonlRecords(filePath: string, startOffset = 0): JsonlReadResult {
  if (!Number.isSafeInteger(startOffset) || startOffset < 0) {
    throw new Error("JSONL start offset must be a non-negative safe integer");
  }

  const fd = openSync(filePath, "r");
  try {
    const stat = fstatSync(fd);
    if (startOffset > stat.size) throw new Error("JSONL start offset is beyond end of file");

    const records: JsonlRecord[] = [];
    let malformedLines = 0;
    let safeCheckpointOffset = startOffset;
    let checkpointHashStart = startOffset;
    let checkpointHash: string | undefined;
    let pending = Buffer.alloc(0);
    let pendingStart = startOffset;
    let position = startOffset;

    while (position < stat.size) {
      const length = Math.min(READ_BUFFER_SIZE, stat.size - position);
      const chunk = Buffer.allocUnsafe(length);
      const bytesRead = readSync(fd, chunk, 0, length, position);
      if (bytesRead === 0) break;
      position += bytesRead;

      const combined = pending.length === 0
        ? chunk.subarray(0, bytesRead)
        : Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let lineStart = 0;

      for (let index = 0; index < combined.length; index++) {
        if (combined[index] !== 0x0a) continue;

        const absoluteStart = pendingStart + lineStart;
        const absoluteEnd = pendingStart + index + 1;
        const line = combined.subarray(lineStart, index);
        const parsed = parseLine(line, absoluteStart, absoluteEnd, true);
        if (parsed === "malformed") malformedLines++;
        else if (parsed !== "blank") records.push(parsed);

        safeCheckpointOffset = absoluteEnd;
        const boundedHashStart = Math.max(lineStart, index + 1 - MAX_CHECKPOINT_HASH_BYTES);
        checkpointHashStart = pendingStart + boundedHashStart;
        checkpointHash = sha256(combined.subarray(boundedHashStart, index + 1));
        lineStart = index + 1;
      }

      pending = Buffer.from(combined.subarray(lineStart));
      pendingStart += lineStart;
    }

    if (pending.length > 0) {
      const parsed = parseLine(pending, pendingStart, stat.size, false);
      if (parsed === "malformed") malformedLines++;
      else if (parsed !== "blank") records.push(parsed);
    }

    return {
      records,
      malformedLines,
      fileSize: stat.size,
      fileMtimeMs: stat.mtimeMs,
      safeCheckpointOffset,
      checkpointHashStart,
      ...(checkpointHash ? { checkpointHash } : {}),
    };
  } finally {
    closeSync(fd);
  }
}

export function hashFileRange(filePath: string, startOffset: number, endOffset: number): string {
  if (startOffset < 0 || endOffset < startOffset) throw new Error("Invalid file range");
  const length = endOffset - startOffset;
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    let total = 0;
    while (total < length) {
      const bytesRead = readSync(fd, buffer, total, length - total, startOffset + total);
      if (bytesRead === 0) throw new Error("Unexpected end of file while validating index checkpoint");
      total += bytesRead;
    }
    return sha256(buffer);
  } finally {
    closeSync(fd);
  }
}
