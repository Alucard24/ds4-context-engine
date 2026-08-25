import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileArtifactStore } from "ds4-context-core/artifacts/artifact-store";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function store(): { root: string; store: FileArtifactStore } {
  const root = mkdtempSync(join(tmpdir(), "ds4-artifacts-"));
  temporaryDirectories.push(root);
  let id = 0;
  return { root, store: new FileArtifactStore(root, () => 100 + id, () => `id-${++id}`) };
}

describe("FileArtifactStore", () => {
  it("writes content-addressed objects with private permissions and deduplicates", () => {
    const fixture = store();
    const first = fixture.store.put(Buffer.from("full tool output"), "text/plain");
    const second = fixture.store.put(Buffer.from("full tool output"), "text/plain");

    expect(second).toMatchObject({ sha256: first.sha256, filePath: first.filePath, deduplicated: true });
    if (process.platform !== "win32") {
      expect(statSync(first.filePath).mode & 0o777).toBe(0o600);
      expect(statSync(join(fixture.root, first.sha256.slice(0, 2))).mode & 0o777).toBe(0o700);
    }
    expect(fixture.store.verify(first.sha256)).toMatchObject({ status: "available" });
  });

  it("repairs a corrupt existing object instead of trusting its filename", () => {
    const fixture = store();
    const first = fixture.store.put(Buffer.from("canonical content"), "text/plain");
    writeFileSync(first.filePath, "corrupt content");

    const repaired = fixture.store.put(Buffer.from("canonical content"), "text/plain");

    expect(repaired.repaired).toBe(true);
    expect(fixture.store.verify(first.sha256)).toMatchObject({ status: "available" });
    expect(readdirSync(join(fixture.root, first.sha256.slice(0, 2))).some((name) => name.includes(".corrupt-")))
      .toBe(false);
  });

  it("reports missing, corrupt, over-limit, and invalid addresses", () => {
    const fixture = store();
    const object = fixture.store.put(Buffer.from("123456789"), "text/plain");
    expect(() => fixture.store.verify(object.sha256, 2)).toThrow("byte read limit");
    writeFileSync(object.filePath, "different");
    expect(fixture.store.verify(object.sha256)).toMatchObject({ status: "corrupt" });
    rmSync(object.filePath);
    expect(fixture.store.verify(object.sha256)).toMatchObject({ status: "missing" });
    expect(() => fixture.store.pathFor("../escape")).toThrow("SHA-256");
  });
});
