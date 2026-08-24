import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashFileRange,
  readJsonlRecords,
  readSessionHeaderRecord,
} from "../../src/pi-adapter/session-jsonl.ts";

const fixture = join(import.meta.dirname, "..", "fixtures", "pi-session-v3.jsonl");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Pi session JSONL reader", () => {
  it("reads byte offsets and a verifiable append checkpoint", () => {
    const header = readSessionHeaderRecord(fixture);
    const result = readJsonlRecords(fixture);

    expect(header.value).toMatchObject({ type: "session", version: 3, id: "session-fixture" });
    expect(result.records).toHaveLength(11);
    expect(result.malformedLines).toBe(0);
    expect(result.safeCheckpointOffset).toBe(result.fileSize);
    expect(result.checkpointHash).toBeDefined();
    expect(hashFileRange(fixture, result.checkpointHashStart, result.safeCheckpointOffset))
      .toBe(result.checkpointHash);
  });

  it("skips complete malformed lines but retains valid unterminated records", () => {
    const directory = mkdtempSync(join(tmpdir(), "ds4-jsonl-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "session.jsonl");
    const header = '{"type":"session","version":3,"id":"s","timestamp":"x","cwd":"/tmp"}\n';
    writeFileSync(path, `${header}not-json\n\n`);
    appendFileSync(path, '{"type":"message","id":"a","parentId":null,"timestamp":"x","message":{"role":"user","content":"ok"}}');

    const result = readJsonlRecords(path);

    expect(result.records.map((record) => record.value.type)).toEqual(["session", "message"]);
    expect(result.records.at(-1)?.terminated).toBe(false);
    expect(result.malformedLines).toBe(1);
    expect(result.safeCheckpointOffset).toBeLessThan(result.fileSize);
  });

  it("supports incremental reads from a newline checkpoint", () => {
    const contents = readFileSync(fixture);
    const firstNewline = contents.indexOf(0x0a) + 1;
    const incremental = readJsonlRecords(fixture, firstNewline);

    expect(incremental.records).toHaveLength(10);
    expect(incremental.records[0]?.value.id).toBe("00000001");
  });
});
