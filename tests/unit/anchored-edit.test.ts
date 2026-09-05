import { describe, expect, it } from "vitest";
import { normalizeEditText, resolveAnchoredEdit } from "../../src/extension/anchored-edit.ts";

describe("anchored edit semantics", () => {
  it("replaces an inclusive range and permits a tail before the head", () => {
    const original = "END\nbefore\nHEAD\nold\nEND\nafter\n";
    const span = resolveAnchoredEdit(original, "HEAD\n[upto]\nEND\n");
    expect(span).toEqual({ start: 11, end: 24, oldText: "HEAD\nold\nEND\n", startLine: 3, endLine: 5 });
    expect(original.slice(0, span.start) + "new\n" + original.slice(span.end)).toBe("END\nbefore\nnew\nafter\n");
  });

  it("allows inline anchors, adjacent anchors and short manual prefixes", () => {
    expect(resolveAnchoredEdit("xABz", "A[upto]B").oldText).toBe("AB");
    expect(resolveAnchoredEdit("a—😀middle終z", "😀[upto]終").oldText).toBe("😀middle終");
  });

  it("normalizes CRLF/CR and removes only leading newline separators from the tail", () => {
    const original = normalizeEditText("HEAD\r\n  body\r\n  END\r\n");
    expect(resolveAnchoredEdit(original, "HEAD\r\n[upto]\r\n\r\n  END\r\n").oldText).toBe(original);
    expect(normalizeEditText("a\rb\r\nc\n")).toBe("a\nb\nc\n");
  });

  it.each([
    ["HEAD body END", "HEAD END", /one \[upto\]/],
    ["HEAD body END", "HEAD[upto]body[upto]END", /more than one/],
    ["HEAD body END", "[upto]END", /Head anchor must/],
    ["HEAD body END", " \t[upto]END", /Head anchor must/],
    ["HEAD body END", "HEAD[upto]", /Tail anchor must/],
    ["HEAD body END", "HEAD[upto]\n \t\n", /Tail anchor must/],
    ["HEAD body END", "missing[upto]END", /Head anchor not found/],
    ["HEAD body END", "HEAD[upto]missing", /Tail anchor not found after head/],
    ["END before HEAD", "HEAD[upto]END", /Tail anchor not found after head/],
    ["HEAD HEAD END", "HEAD[upto]END", /Head anchor is not unique/],
    ["HEAD END END", "HEAD[upto]END", /Tail anchor is not unique after head/],
    ["aaa END", "aa[upto]END", /Head anchor is not unique/],
    ["HEAD aaa", "HEAD[upto]aa", /Tail anchor is not unique after head/],
    ["HEADEND", "HEAD[upto]DEND", /Tail anchor not found after head/],
    ["“HEAD” body END", '"HEAD"[upto]END', /Head anchor not found/],
    ["HEAD body “END”", 'HEAD[upto]"END"', /Tail anchor not found/],
    ["HEAD\n  END\n", "HEAD[upto]\n   END\n", /Tail anchor not found/],
  ])("fails closed: %s / %s", (original, oldText, error) => {
    expect(() => resolveAnchoredEdit(original, oldText)).toThrow(error);
  });
});
