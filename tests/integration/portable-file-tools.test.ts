import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadToolDefinition, type ExtensionAPI, type ExtensionContext, type ReadOperations } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adaptiveReadLimit, createAdaptiveReadRegistration, createAdaptiveReadTool } from "../../src/extension/adaptive-read-tool.ts";
import { createAnchoredEditRegistration, createAnchoredEditTool } from "../../src/extension/anchored-edit-tool.ts";
import { createReportingEditTool } from "../../src/extension/post-edit-report.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture(content: string) {
  const cwd = await mkdtemp(join(tmpdir(), "ds4-portable-files-")); roots.push(cwd);
  const path = join(cwd, "file.txt"); await writeFile(path, content);
  const ctx = { cwd, model: { contextWindow: 8192, input: ["text", "image"] } } as ExtensionContext;
  return { cwd, path, ctx };
}

it("reports ordinary native writes without interpreting literal marker text", async () => {
  const { cwd, path, ctx } = await fixture("\uFEFFliteral[upto]\r\nkeep\r\n");
  const result = await createReportingEditTool(cwd).execute("edit", {
    path, edits: [{ oldText: "literal[upto]", newText: "one\ntwo" }],
  }, undefined, undefined, ctx);
  expect(await readFile(path, "utf8")).toBe("\uFEFFone\r\ntwo\r\nkeep\r\n");
  expect(result.details).toMatchObject({ postEditReport: { lineDelta: 1, regions: [{ oldStart: 1, newCount: 2 }] } });
  expect(result.details?.patch).toContain("+two");
});

it("combines anchors and reporting without exposing expansion in arguments", async () => {
  const { cwd, path, ctx } = await fixture("HEAD\nold\nTAIL\nkeep\n");
  const input = { path, edits: [{ oldText: "HEAD[upto]TAIL", newText: "NEW" }] };
  const original = structuredClone(input);
  const result = await createAnchoredEditTool(cwd, undefined, true).execute("edit", input, undefined, undefined, ctx);
  expect(input).toEqual(original);
  expect(result.details).toMatchObject({ anchoredRanges: [{ startLine: 1, endLine: 3 }], postEditReport: { lineDelta: -2 } });
});

describe("adaptive native read", () => {
  it.each([[4096, 120], [8192, 120], [16384, 240], [16385, 500], [128000, 500], [undefined, undefined], [NaN, undefined], [0, undefined]])("maps %s to %s lines", (window, expected) => {
    expect(adaptiveReadLimit(window)).toBe(expected);
  });

  it("uses execution-time window and cwd, private args and native continuation notices", async () => {
    const { cwd, path, ctx } = await fixture(Array.from({ length: 800 }, (_, n) => `line ${n + 1}`).join("\n"));
    const tool = createAdaptiveReadTool("/not-the-execution-directory");
    const input = { path: "file.txt" };
    const first = await tool.execute("read", input, undefined, undefined, ctx);
    expect(first.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("offset=121") });
    expect(input).toEqual({ path: "file.txt" });
    ctx.model!.contextWindow = 128000;
    const second = await tool.execute("read", input, undefined, undefined, ctx);
    expect(second.content[0]).toMatchObject({ text: expect.stringContaining("offset=501") });
    const explicit = { path, offset: 11, limit: 17 };
    expect(await tool.execute("read", explicit, undefined, undefined, ctx))
      .toEqual(await createReadToolDefinition(cwd).execute("native", explicit, undefined, undefined, ctx));
  });

  it("keeps unknown-window and native byte-limit behavior", async () => {
    const { cwd, path, ctx } = await fixture("x".repeat(60_000));
    ctx.model = undefined;
    const input = { path };
    expect(await createAdaptiveReadTool(cwd).execute("read", input, undefined, undefined, ctx))
      .toEqual(await createReadToolDefinition(cwd).execute("read", input, undefined, undefined, ctx));
  });

  it("keeps native image output and aborts; rejects mutated limits before access", async () => {
    const { cwd, path, ctx } = await fixture("");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV/8AAAAASUVORK5CYII=", "base64");
    const ops: ReadOperations = { readFile: async () => png, access: vi.fn(async () => {}), detectImageMimeType: async () => "image/png" };
    const options = { operations: ops, autoResizeImages: false };
    const tool = createAdaptiveReadTool(cwd, options);
    expect(await tool.execute("read", { path }, undefined, undefined, ctx))
      .toEqual(await createReadToolDefinition(cwd, options).execute("read", { path }, undefined, undefined, ctx));
    const abort = new AbortController(); abort.abort();
    await expect(tool.execute("read", { path }, abort.signal, undefined, ctx)).rejects.toThrow(/aborted/i);
    vi.mocked(ops.access).mockClear();
    await expect(tool.execute("read", { path, limit: NaN }, undefined, undefined, ctx)).rejects.toThrow("positive integer");
    expect(ops.access).not.toHaveBeenCalled();
  });
});

it("registers independently, skips missing/overridden tools and restores native definitions", () => {
  const registerTool = vi.fn();
  let source = "builtin";
  const pi = { registerTool, getAllTools: () => ["read", "edit"].map((name) => ({ name, sourceInfo: { source } })) } as unknown as ExtensionAPI;
  const ctx = { cwd: "/tmp", hasUI: false } as ExtensionContext;
  const syncRead = createAdaptiveReadRegistration(pi);
  const syncEdit = createAnchoredEditRegistration(pi);
  syncRead(false, ctx); syncEdit({ anchored: false, postEditReport: false }, ctx);
  expect(registerTool).not.toHaveBeenCalled();
  source = "extension";
  syncRead(true, ctx); syncEdit({ anchored: false, postEditReport: true }, ctx);
  expect(registerTool).not.toHaveBeenCalled();
  source = "builtin";
  syncRead(true, ctx); syncEdit({ anchored: false, postEditReport: true }, ctx);
  expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(["read", "edit"]);
  expect(registerTool.mock.calls[1]![0].description).not.toContain("anchored");
  source = "extension";
  syncRead(false, ctx); syncEdit(false, ctx);
  expect(registerTool.mock.calls[2]![0].description).not.toContain("DS4");
  expect(registerTool.mock.calls[3]![0].description).not.toContain("anchored");
});
