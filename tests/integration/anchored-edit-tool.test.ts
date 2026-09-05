import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  initTheme,
  type Theme,
  type EditOperations,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAnchoredEditRegistration,
  createAnchoredEditTool,
  type AnchoredEditInput,
} from "../../src/extension/anchored-edit-tool.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(content = "before\nHEAD\nold\nTAIL\nafter\n") {
  const cwd = await mkdtemp(join(tmpdir(), "ds4-anchored-edit-"));
  roots.push(cwd);
  const path = join(cwd, "file.txt");
  await writeFile(path, content);
  const ctx = { cwd } as ExtensionContext;
  const tool = createAnchoredEditTool(cwd);
  const run = (edits: AnchoredEditInput["edits"], signal?: AbortSignal) =>
    tool.execute("call-1", { path: "file.txt", edits }, signal, undefined, ctx);
  return { cwd, path, ctx, tool, run };
}
const range = { oldText: "HEAD\n[upto]\nTAIL\n", newText: "NEW\n" };
const operations: EditOperations = {
  access: (path) => access(path, constants.R_OK | constants.W_OK),
  readFile: (path) => readFile(path),
  writeFile: (path, content) => writeFile(path, content, "utf8"),
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("native anchored edit integration", () => {
  it("expands inside the native read, preserves arguments and returns native diff plus line ranges", async () => {
    const { path, run } = await fixture();
    const edits = [{ ...range }];
    const before = structuredClone(edits);
    const result = await run(edits);
    expect(await readFile(path, "utf8")).toBe("before\nNEW\nafter\n");
    expect(edits).toEqual(before);
    expect(result.details?.diff).toContain("+2 NEW");
    expect(result.details?.patch).toContain("-HEAD");
    expect(result.details).toMatchObject({ firstChangedLine: 2, anchoredRanges: [{ editIndex: 0, startLine: 2, endLine: 4 }] });
    expect(result.content).toContainEqual({ type: "text", text: "Anchored replacements (original lines): edits[0] 2-4." });
  });

  it("produces the same large replacement with a shorter serialized oldText request", async () => {
    const original = `HEAD\n${Array.from({ length: 200 }, (_, index) => `old line ${index}`).join("\n")}\nTAIL\n`;
    const { cwd, path, run, ctx } = await fixture(original);
    const nativePath = join(cwd, "native.txt");
    await writeFile(nativePath, original);
    const ordinary = [{ oldText: original, newText: range.newText }];
    await run([range]);
    await createEditToolDefinition(cwd).execute("baseline", { path: nativePath, edits: ordinary }, undefined, undefined, ctx);
    expect(await readFile(path, "utf8")).toBe(await readFile(nativePath, "utf8"));
    // Deterministic request-byte comparison, not a measured model token/latency claim.
    expect(Buffer.byteLength(JSON.stringify([range]))).toBeLessThan(Buffer.byteLength(JSON.stringify(ordinary)));
  });

  it("suppresses the literal-marker preview but renders the actual native result diff", async () => {
    const { cwd, tool, run } = await fixture();
    initTheme("dark");
    const theme = { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
    const args = { path: "file.txt", edits: [range] };
    const invalidate = vi.fn();
    const context: Parameters<NonNullable<typeof tool.renderCall>>[2] = {
      args, toolCallId: "render", invalidate, lastComponent: undefined, state: {}, cwd,
      executionStarted: false, argsComplete: true, isPartial: false, expanded: false, showImages: false, isError: false,
    };
    const component = tool.renderCall!(args, theme, context);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(invalidate).not.toHaveBeenCalled();
    expect(component.render(100).join("\n")).not.toContain("Could not find");
    const result = await run([range]);
    tool.renderResult!(result, { expanded: false, isPartial: false }, theme, context);
    expect(component.render(100).join("\n")).toContain("NEW");
  });

  it("matches all mixed edits against the original file even when replacements contain later needles", async () => {
    const { path, run } = await fixture();
    await run([{ ...range, newText: "after\n" }, { oldText: "after\n", newText: "DONE\n" }]);
    expect(await readFile(path, "utf8")).toBe("before\nafter\nDONE\n");
  });

  it("supports multiple disjoint anchored ranges and an earlier identical tail", async () => {
    const { path, run } = await fixture("TAIL\nHEAD\na\nTAIL\nSECOND\nb\nEND\n");
    await run([range, { oldText: "SECOND\n[upto]\nEND\n", newText: "TWO\n" }]);
    expect(await readFile(path, "utf8")).toBe("TAIL\nNEW\nTWO\n");
  });

  it.each([
    ["HEAD\n[upto]\nTAIL\n", "HEAD\nold\n"],
    ["HEAD\n[upto]\nTAIL\n", "old\n[upto]\nafter\n"],
  ])("rejects overlapping mixed/anchored edits before any write", async (first, second) => {
    const { path, run } = await fixture();
    const original = await readFile(path, "utf8");
    await expect(run([{ oldText: first, newText: "A" }, { oldText: second, newText: "B" }])).rejects.toThrow(/overlap/);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it.each([
    "HEAD[upto]missing", "missing[upto]TAIL", "HEAD[upto]old[upto]TAIL", "HEAD[upto]\n",
  ])("keeps the complete batch unwritten on invalid anchors: %s", async (oldText) => {
    const { path, run } = await fixture();
    const original = await readFile(path, "utf8");
    await expect(run([{ oldText: "before", newText: "CHANGED" }, { oldText, newText: "X" }])).rejects.toThrow(/edits\[1\]/);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("never accepts fuzzy head/tail anchors but preserves native fallback for ordinary edits", async () => {
    const { path, run } = await fixture('“HEAD”\nold\n“TAIL”\nordinary “quote”\n');
    await expect(run([{ oldText: '"HEAD"[upto]“TAIL”', newText: "X" }])).rejects.toThrow(/Head anchor not found/);
    await expect(run([{ oldText: '“HEAD”[upto]"TAIL"', newText: "X" }])).rejects.toThrow(/Tail anchor not found/);
    await expect(run([
      { oldText: "“HEAD”\n[upto]\n“TAIL”\n", newText: "NEW\n" },
      { oldText: 'ordinary "quote"', newText: "ordinary NEW" },
    ])).rejects.toThrow(/exact ordinary oldText/);
    await run([{ oldText: 'ordinary "quote"', newText: "ordinary NEW" }]);
    await run([{ oldText: "“HEAD”\n[upto]\n“TAIL”\n", newText: "NEW\n" }]);
    expect(await readFile(path, "utf8")).toBe("NEW\nordinary NEW\n");
  });

  it("prevents native fuzzy batch rematching from moving an exact anchored span", async () => {
    // The exact span is AＡ at offset 1. NFKC creates AAA, where native fuzzy
    // rematching can choose overlapping AA at offset 0 instead of that span.
    const original = "ＡAＡ\nordinary “quote”\n";
    const { cwd, ctx, path, run } = await fixture(original);
    const nativePath = join(cwd, "native.txt");
    await writeFile(nativePath, original);
    await createEditToolDefinition(cwd).execute("native-fuzzy", { path: nativePath, edits: [
      { oldText: "AＡ", newText: "X" },
      { oldText: 'ordinary "quote"', newText: "ordinary NEW" },
    ] }, undefined, undefined, ctx);
    // Pin the native behavior that makes expansion alone unsafe in mixed batches.
    expect(await readFile(nativePath, "utf8")).toBe("XA\nordinary NEW\n");
    await expect(run([
      { oldText: "A[upto]Ａ", newText: "X" },
      { oldText: 'ordinary "quote"', newText: "ordinary NEW" },
    ])).rejects.toThrow(/exact ordinary oldText/);
    expect(await readFile(path, "utf8")).toBe(original);
    await run([{ oldText: "A[upto]Ａ", newText: "X" }]);
    expect(await readFile(path, "utf8")).toBe("ＡX\nordinary “quote”\n");
  });

  it("keeps exact mixed batches in original coordinates even with normalized repeats", async () => {
    const { path, run } = await fixture("ＡAＡ\nordinary “quote”\n");
    await run([
      { oldText: "A[upto]Ａ", newText: "X" },
      { oldText: "ordinary “quote”", newText: "ordinary NEW" },
    ]);
    expect(await readFile(path, "utf8")).toBe("ＡX\nordinary NEW\n");
  });

  it("keeps native normalized-ambiguity rejection after exact anchor validation", async () => {
    const { path, run } = await fixture('“HEAD”x“TAIL”\n"HEAD"x"TAIL"\n');
    const original = await readFile(path, "utf8");
    await expect(run([{ oldText: '“HEAD”[upto]“TAIL”\n', newText: "NEW\n" }])).rejects.toThrow(/Found 2 occurrences/);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("preserves native behavior for ordinary and literal-marker edits", async () => {
    const original = 'ordinary “quotes”  \n[upto]\n';
    const { cwd, path, run, ctx } = await fixture(original);
    const nativePath = join(cwd, "native.txt");
    await writeFile(nativePath, original);
    const edits = [{ oldText: 'ordinary "quotes"', newText: "updated" }, { oldText: "[upto]", newText: "literal", literal: true }];
    await run(edits);
    await createEditToolDefinition(cwd).execute("native", { path: nativePath, edits }, undefined, undefined, ctx);
    expect(await readFile(path, "utf8")).toBe(await readFile(nativePath, "utf8"));
  });

  it("allows newText to contain literal markers and literal edits in an anchored batch", async () => {
    const { path, run } = await fixture("[upto]\nHEAD\nold\nTAIL\n");
    await run([{ oldText: "[upto]", newText: "literal", literal: true }, { ...range, newText: "[upto]\n" }]);
    expect(await readFile(path, "utf8")).toBe("literal\n[upto]\n");
  });

  it("preserves BOM, CRLF, Unicode and a missing final newline", async () => {
    const { path, run } = await fixture("\uFEFFbefore 😀\r\nHEAD\r\nold\r\nTAIL\r\nafter");
    await run([{ ...range, newText: "NEW 😀\r\n" }]);
    expect(await readFile(path, "utf8")).toBe("\uFEFFbefore 😀\r\nNEW 😀\r\nafter");
  });

  it("rejects no-op replacements and missing files", async () => {
    const { tool, ctx, path, run } = await fixture();
    await expect(run([{ ...range, newText: "HEAD\nold\nTAIL\n" }])).rejects.toThrow(/No changes/);
    await rm(path);
    await expect(tool.execute("missing", { path, edits: [range] }, undefined, undefined, ctx)).rejects.toThrow(/Could not edit file/);
  });

  it("honors execution ctx.cwd for anchored and ordinary calls", async () => {
    const first = await fixture();
    const second = await fixture();
    await first.tool.execute("ctx", { path: "file.txt", edits: [range] }, undefined, undefined, second.ctx);
    await first.tool.execute("ctx", { path: "file.txt", edits: [{ oldText: "NEW", newText: "DONE" }] }, undefined, undefined, second.ctx);
    expect(await readFile(second.path, "utf8")).toBe("before\nDONE\nafter\n");
    expect(await readFile(first.path, "utf8")).toContain("HEAD\nold\nTAIL");
  });

  it("retains native argument preparation for serialized/single/legacy edits", async () => {
    const { tool, ctx, path } = await fixture("[upto]\nHEAD\nold\nTAIL\n");
    for (const input of [
      { path, edits: JSON.stringify([{ ...range }]) },
      { path, edits: JSON.stringify({ ...range }) },
      { path, edits: { ...range } },
      { path, oldText: range.oldText, newText: range.newText },
    ]) {
      const prepared = tool.prepareArguments!(input);
      expect(prepared.edits).toEqual([range]);
    }
    const prepared = tool.prepareArguments!({ path, edits: JSON.stringify({ oldText: "[upto]", newText: "marker", literal: true }) });
    await tool.execute("literal", prepared, undefined, undefined, ctx);
    expect(await readFile(path, "utf8")).toContain("marker\nHEAD");
  });

  it("revalidates mutated input and propagates access failures without writes", async () => {
    const { cwd, path, ctx, tool } = await fixture();
    for (const edits of [[], [null], [{ oldText: "x", newText: 1 }], [{ ...range, literal: "false" }]]) {
      await expect(tool.execute("invalid", { path, edits } as unknown as AnchoredEditInput, undefined, undefined, ctx)).rejects.toThrow(/Edit input|Invalid edits/);
    }
    const deniedWrite = vi.fn(operations.writeFile);
    const denied = createAnchoredEditTool(cwd, { operations: {
      ...operations, writeFile: deniedWrite, access: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
    } });
    await expect(denied.execute("denied", { path, edits: [range] }, undefined, undefined, ctx)).rejects.toThrow(/EACCES/);
    expect(deniedWrite).not.toHaveBeenCalled();
  });

  it("delegates custom operations without losing their receiver", async () => {
    const { cwd, path, ctx } = await fixture();
    class BoundOperations implements EditOperations {
      reads = 0;
      writes = 0;
      async access(file: string) { await operations.access(file); }
      async readFile(file: string) { this.reads++; return operations.readFile(file); }
      async writeFile(file: string, content: string) { this.writes++; await operations.writeFile(file, content); }
    }
    const bound = new BoundOperations();
    await createAnchoredEditTool(cwd, { operations: bound }).execute("bound", { path, edits: [range] }, undefined, undefined, ctx);
    expect(bound.reads).toBe(1);
    expect(bound.writes).toBe(1);
    expect(await readFile(path, "utf8")).toBe("before\nNEW\nafter\n");
  });

  it("keeps concurrent calls and their range metadata isolated", async () => {
    const { cwd, ctx, path, tool } = await fixture();
    const secondPath = join(cwd, "second.txt");
    await writeFile(secondPath, "HEAD\ndifferent\nTAIL\n");
    const firstInput = { path, edits: [{ ...range }] };
    const secondInput = { path: secondPath, edits: [{ ...range, newText: "SECOND\n" }] };
    const snapshot = structuredClone([firstInput, secondInput]);
    const [first, second] = await Promise.all([
      tool.execute("one", firstInput, undefined, undefined, ctx),
      tool.execute("two", secondInput, undefined, undefined, ctx),
    ]);
    expect([firstInput, secondInput]).toEqual(snapshot);
    expect(first.details).toMatchObject({ anchoredRanges: [{ editIndex: 0, startLine: 2, endLine: 4 }] });
    expect(second.details).toMatchObject({ anchoredRanges: [{ editIndex: 0, startLine: 1, endLine: 3 }] });
    expect(await readFile(path, "utf8")).toBe("before\nNEW\nafter\n");
    expect(await readFile(secondPath, "utf8")).toBe("SECOND\n");
  });

  it("expands from the latest serialized content, not a stale preflight read", async () => {
    const { cwd, path, ctx } = await fixture();
    const started = deferred();
    const release = deferred();
    const writer = createWriteToolDefinition(cwd, { operations: {
      mkdir: async () => {},
      writeFile: async (target, content) => { started.resolve(); await release.promise; await writeFile(target, content); },
    } });
    const writing = writer.execute("write", { path, content: "HEAD\nlatest\nTAIL\n" }, undefined, undefined, ctx);
    await started.promise;
    const editing = createAnchoredEditTool(cwd).execute("edit", { path, edits: [range] }, undefined, undefined, ctx);
    release.resolve();
    await writing;
    const result = await editing;
    expect(await readFile(path, "utf8")).toBe("NEW\n");
    expect(result.details?.patch).toContain("-latest");
    expect(result.details?.patch).not.toContain("-old");
  });

  it("keeps the native queue held until an aborted read settles, also through a symlink", async () => {
    const { cwd, path, ctx } = await fixture();
    const alias = join(cwd, "alias.txt");
    // Windows symlink creation can require elevation; same-path still exercises the queue there.
    if (process.platform !== "win32") await symlink(path, alias);
    const target = process.platform === "win32" ? path : alias;
    const started = deferred();
    const release = deferred();
    const controller = new AbortController();
    const firstWrite = vi.fn(operations.writeFile);
    const secondRead = vi.fn(operations.readFile);
    const first = createAnchoredEditTool(cwd, { operations: {
      ...operations, writeFile: firstWrite,
      readFile: async (file) => { started.resolve(); await release.promise; return readFile(file); },
    } });
    const second = createEditToolDefinition(cwd, { operations: { ...operations, readFile: secondRead } });
    const pending = first.execute("first", { path, edits: [range] }, controller.signal, undefined, ctx);
    const rejection = expect(pending).rejects.toThrow(/aborted/i);
    await started.promise;
    controller.abort();
    const next = second.execute("second", { path: target, edits: [{ oldText: "old", newText: "SECOND" }] }, undefined, undefined, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondRead).not.toHaveBeenCalled();
    release.resolve();
    await rejection;
    await next;
    expect(firstWrite).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toContain("HEAD\nSECOND\nTAIL");
  });

  it("holds the queue through an aborted in-flight write without promising rollback", async () => {
    const { cwd, path, ctx } = await fixture();
    const started = deferred();
    const release = deferred();
    const controller = new AbortController();
    const tool = createAnchoredEditTool(cwd, { operations: {
      ...operations,
      writeFile: async (file, content) => { started.resolve(); await release.promise; await writeFile(file, content); },
    } });
    const pending = tool.execute("writing", { path, edits: [range] }, controller.signal, undefined, ctx);
    const rejection = expect(pending).rejects.toThrow(/aborted/i);
    await started.promise;
    controller.abort();
    const nextRead = vi.fn(operations.readFile);
    const next = createEditToolDefinition(cwd, { operations: { ...operations, readFile: nextRead } }).execute(
      "after-abort", { path, edits: [{ oldText: "NEW", newText: "DONE" }] }, undefined, undefined, ctx,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(nextRead).not.toHaveBeenCalled();
    release.resolve();
    await rejection;
    await next;
    expect(await readFile(path, "utf8")).toBe("before\nDONE\nafter\n");
  });

  it("rejects pre-aborted calls before file operations", async () => {
    const { cwd, path, ctx } = await fixture();
    const reader = vi.fn(operations.readFile);
    const tool = createAnchoredEditTool(cwd, { operations: { ...operations, readFile: reader } });
    await expect(tool.execute("abort", { path, edits: [range] }, AbortSignal.abort(), undefined, ctx)).rejects.toThrow(/aborted/i);
    expect(reader).not.toHaveBeenCalled();
  });
});

describe("anchored edit registration", () => {
  it("registers nothing by default and restores the native definition after disable", () => {
    const registered: ToolDefinition[] = [];
    const pi = {
      registerTool: (tool: ToolDefinition) => registered.push(tool),
      getAllTools: () => [{ name: "edit", sourceInfo: { source: "builtin" } }],
    } as unknown as ExtensionAPI;
    const ctx = { cwd: "/project" } as ExtensionContext;
    const sync = createAnchoredEditRegistration(pi);
    sync(false, ctx);
    expect(registered).toEqual([]);
    sync(true, ctx);
    expect(registered[0]!.description).toContain("[upto]");
    sync(false, ctx);
    expect(registered[1]!.parameters).toEqual(createEditToolDefinition(ctx.cwd).parameters);
    expect(registered[1]!.promptGuidelines).toEqual(createEditToolDefinition(ctx.cwd).promptGuidelines);
    sync(true, ctx);
    expect(registered[2]!.description).toContain("[upto]");
  });

  it.each(["extension", "sdk", "missing"])("does not replace %s edit or force tool activation", (source) => {
    const registerTool = vi.fn();
    const notify = vi.fn();
    const pi = {
      registerTool,
      getAllTools: () => source === "missing" ? [] : [{ name: "edit", sourceInfo: { source } }],
    } as unknown as ExtensionAPI;
    createAnchoredEditRegistration(pi)(true, { cwd: "/project", hasUI: true, ui: { notify } } as unknown as ExtensionContext);
    expect(registerTool).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("not registered"), "warning");
  });
});
