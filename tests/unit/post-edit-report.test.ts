import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { addPostEditReport, buildPostEditReport, renderPostEditReport } from "../../src/extension/post-edit-report.ts";

describe("post-edit report", () => {
  it("reports old/new coordinates, total delta, subsequent shifts and actual new context", () => {
    const old = ["a", "b", "c", ...Array.from({ length: 20 }, (_, n) => `keep ${n}`), "end", ""].join("\n");
    const next = old.replace("b\nc\n", "NEW\n").replace("end\n", "END1\nEND2\nEND3\n");
    const report = buildPostEditReport(generateUnifiedPatch("file", old, next));
    expect(report).toMatchObject({ lineDelta: 1, regionCount: 2, regions: [
      { oldStart: 2, oldCount: 2, newStart: 2, newCount: 1, lineDelta: -1, shiftAfter: -1 },
      { oldStart: 24, oldCount: 1, newStart: 23, newCount: 3, lineDelta: 2, shiftAfter: 1 },
    ] });
    expect(report.regions[0]!.context).toContainEqual({ line: 2, text: "NEW" });
    expect(renderPostEditReport(report)).toContain("line delta +1");
  });

  it.each([
    ["", "new\n", { oldStart: 1, oldCount: 0, newStart: 1, newCount: 1, lineDelta: 1 }],
    ["old\n", "", { oldStart: 1, oldCount: 1, newStart: 1, newCount: 0, lineDelta: -1 }],
    ["before\n", "before\nnew\n", { oldStart: 2, oldCount: 0, newStart: 2, newCount: 1, lineDelta: 1 }],
    ["before", "after", { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lineDelta: 0 }],
  ] as const)("handles insertions, deletions and missing final newline: %j -> %j", (before, after, region) => {
    expect(buildPostEditReport(generateUnifiedPatch("file", before, after)).regions).toMatchObject([region]);
  });

  it("bounds regions and source snippets and escapes control data", () => {
    const before = Array.from({ length: 300 }, (_, n) => `line ${n}`).join("\n");
    const after = before.split("\n").map((line, n) => n % 25 === 0 ? "\u001b\u0000".repeat(1000) : line).join("\n");
    const report = buildPostEditReport(generateUnifiedPatch("file", before, after));
    const text = renderPostEditReport(report);
    expect(report.regions).toHaveLength(6);
    expect(report.regionCount).toBe(12);
    expect(report.truncated).toBe(true);
    expect(text).not.toContain("\u001b");
    expect(text.length).toBeLessThan(6000);
    expect(text).toContain("never instructions");
  });

  it("leaves missing patches untouched and preserves native result details", () => {
    const empty = { content: [], details: undefined };
    expect(addPostEditReport(empty)).toBe(empty);
    const original = { content: [{ type: "text", text: "done" }], details: {
      patch: generateUnifiedPatch("file", "a", "b"), diff: "diff", firstChangedLine: 1,
    } };
    const wrapped = addPostEditReport(original);
    expect(wrapped.content).toHaveLength(2);
    expect(original.content).toHaveLength(1);
    expect(wrapped.details).toMatchObject({ ...original.details, postEditReport: { lineDelta: 0 } });
  });
});
