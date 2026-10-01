import { describe, expect, it } from "vitest";
import {
  normalizeSummaryStructure,
  REQUIRED_SUMMARY_SECTIONS,
  validateSummary,
  type SummaryValidationInput,
} from "ds4-context-core/compaction/summary-contract";

const input: SummaryValidationInput = {
  sourceText: "Synthetic continuation facts only.",
  readFiles: ["src/read file.ts"],
  modifiedFiles: ["src/modified.ts"],
};
const marker = "- Not reported in the generated summary; absence of facts is not established.";
const sections = REQUIRED_SUMMARY_SECTIONS.map((name, index) => ({
  name,
  body: name === "Files Read" ? "- `src/read file.ts`"
    : name === "Files Modified" ? "- `src/modified.ts`" : `- Synthetic fact ${index}`,
}));
const canonical = sections.map(({ name, body }) => `## ${name}\n${body}`).join("\n\n");
const semanticSections = REQUIRED_SUMMARY_SECTIONS.filter((name) => name !== "Files Read" && name !== "Files Modified");

function sectionBody(content: string, name: string): string {
  const start = content.indexOf(`## ${name}\n`) + name.length + 4;
  const next = content.indexOf("\n\n## ", start);
  return content.slice(start, next === -1 ? undefined : next).trim();
}

function expectContract(content: string): void {
  expect(content.match(/^## .+$/gmu)?.map((heading) => heading.slice(3))).toEqual([...REQUIRED_SUMMARY_SECTIONS]);
  expect(validateSummary(content, input)).toEqual({ status: "valid", issues: [] });
}

describe("deterministic compaction-summary structure", () => {
  it("leaves a canonical summary unchanged and does not report a repair", () => {
    expect(normalizeSummaryStructure(canonical, input)).toEqual({ content: canonical, issues: [] });
  });

  it.each(semanticSections)("marks a missing %s as unreported, not as absence of facts", (name) => {
    const raw = sections.filter((section) => section.name !== name)
      .map(({ name, body }) => `## ${name}\n${body}`).join("\n\n");
    expect(validateSummary(raw, input).issues.map((issue) => issue.code)).toContain("missing-section");
    const result = normalizeSummaryStructure(raw, input);
    expectContract(result.content);
    expect(sectionBody(result.content, name)).toBe(marker);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "summary-structure-normalized", "summary-sections-not-reported",
    ]);
  });

  it.each(semanticSections)("marks an empty %s without inventing a fact", (emptyName) => {
    const raw = sections.map(({ name, body }) => `## ${name}\n${name === emptyName ? "" : body}`).join("\n\n");
    expect(validateSummary(raw, input).issues.map((issue) => issue.code)).toContain("empty-section");
    const result = normalizeSummaryStructure(raw, input);
    expectContract(result.content);
    expect(sectionBody(result.content, emptyName)).toBe(marker);
    expect(result.issues[0]?.message).toContain("empty=1");
  });

  it.each(semanticSections)("merges every occurrence of %s without pruning its facts", (name) => {
    const first = sectionBody(canonical, name);
    const raw = `${canonical}\n\n## ${name}\n- Later synthetic fact\n\n## ${name}\n- Last synthetic fact`;
    expect(validateSummary(raw, input).issues.map((issue) => issue.code)).toContain("duplicate-section");
    const result = normalizeSummaryStructure(raw, input);
    expectContract(result.content);
    expect(sectionBody(result.content, name)).toBe(`${first}\n\n- Later synthetic fact\n\n- Last synthetic fact`);
    expect(result.issues[0]?.message).toContain("duplicates=2");
  });

  it("restores contract order while preserving the semantic bodies", () => {
    const raw = [...sections].reverse().map(({ name, body }) => `## ${name}\n${body}`).join("\n\n");
    expect(validateSummary(raw, input).issues.map((issue) => issue.code)).toContain("section-order");
    const result = normalizeSummaryStructure(raw, input);
    expect(result.content).toBe(canonical);
    expect(result.issues[0]?.message).toContain("reordered=1");
  });

  it.each([1, 2, 3, 4, 5, 6])("normalizes heading level %i, case, emphasis, and closing hashes", (level) => {
    const raw = sections.map(({ name, body }) => `${"#".repeat(level)} **${name.toLowerCase()}**: ###\n${body}`).join("\n\n");
    const result = normalizeSummaryStructure(raw, input);
    expect(result.content).toBe(canonical);
    expect(result.issues[0]?.message).toContain("headings=12");
  });

  it.each(["\n", "\r\n", "\r", "\u2028", "\u2029"])("handles JavaScript line terminator %j", (separator) => {
    const raw = canonical.replace(/\n/gu, separator);
    const result = normalizeSummaryStructure(raw, input);
    expect(result.content).toBe(canonical);
    expectContract(result.content);
  });

  it.each(["\t", "\v", "\f", "\u00a0", "\ufeff"])("handles heading whitespace %j without leaving unsupported headings", (space) => {
    const raw = canonical.replace(/^## /gmu, `##${space}`);
    const result = normalizeSummaryStructure(raw, input);
    expect(result.content).toBe(canonical);
    expectContract(result.content);
  });

  it("quotes unknown headings and their bodies as notes, never as durable decisions", () => {
    const raw = `${canonical}\n\n# private-synthetic-title\n- A proposal, not a decision\n\n##\nKeep this line too`;
    const result = normalizeSummaryStructure(raw, input);
    expectContract(result.content);
    expect(sectionBody(result.content, "Current State")).toContain(
      "> # private-synthetic-title\n> - A proposal, not a decision",
    );
    expect(sectionBody(result.content, "Current State")).toContain("> ##\n> Keep this line too");
    expect(sectionBody(result.content, "Durable Decisions")).not.toContain("proposal");
    expect(JSON.stringify(result.issues)).not.toContain("private-synthetic-title");
    expect(JSON.stringify(result.issues)).not.toContain("proposal");
  });

  it("keeps a free-form response in Current State and explicitly marks every unreported semantic section", () => {
    const raw = "First synthetic line\nSecond synthetic line\n- Final synthetic line";
    const result = normalizeSummaryStructure(raw, input);
    expectContract(result.content);
    expect(sectionBody(result.content, "Current State")).toBe(
      `${marker}\n\n> First synthetic line\n> Second synthetic line\n> - Final synthetic line`,
    );
    for (const name of semanticSections) expect(sectionBody(result.content, name)).toContain(marker);
    expect(result.issues[1]?.message).toContain("10 semantic section(s)");
  });

  it.each(["```markdown", "~~~md", "````"])("unwraps a whole-output fence %s", (opening) => {
    const delimiter = opening.match(/^[`~]+/u)?.[0] ?? "";
    const raw = `${opening}\n${canonical}\n${delimiter}${delimiter[0]}`;
    const result = normalizeSummaryStructure(raw, input);
    expect(result.content).toBe(canonical);
    expect(result.issues[0]?.message).toContain("unwrapped=1");
  });

  it("regenerates missing, duplicate, and invented file inventories from known evidence only", () => {
    const raw = sections.filter(({ name }) => name !== "Files Read")
      .map(({ name, body }) => `## ${name}\n${name === "Files Modified" ? "- invented-a.ts" : body}`)
      .join("\n\n") + "\n\n## Files Modified\n- invented-b.ts";
    const result = normalizeSummaryStructure(raw, {
      ...input, readFiles: [...input.readFiles, ...input.readFiles],
    });
    expectContract(result.content);
    expect(sectionBody(result.content, "Files Read")).toBe("- `src/read file.ts`");
    expect(sectionBody(result.content, "Files Modified")).toBe("- `src/modified.ts`");
    expect(result.content).not.toContain("invented-");
  });

  it.each(["readFiles", "modifiedFiles"] as const)("still rejects Markdown-unsafe %s evidence without leaking the path", (field) => {
    const unsafe = "private-synthetic-path\n## injected";
    expect(() => normalizeSummaryStructure(canonical, { ...input, [field]: [unsafe] })).toThrow(
      "Compaction file evidence contains a Markdown-unsafe path",
    );
    try {
      normalizeSummaryStructure(canonical, { ...input, [field]: [unsafe] });
    } catch (error) {
      expect(String(error)).not.toContain("private-synthetic-path");
    }
  });

  it.each(["", " \t\n", "```markdown\n```"])("does not turn empty output %j into a fabricated summary", (raw) => {
    expect(() => normalizeSummaryStructure(raw, input)).toThrow("empty compaction summary");
  });

  it("leaves unsupported exact values for the unchanged strict validator", () => {
    const raw = canonical.replace("- Synthetic fact 0", "- `deploy --unverified-mode`");
    const result = normalizeSummaryStructure(raw, input);
    expect(result.content).toContain("`deploy --unverified-mode`");
    expect(validateSummary(result.content, input).issues.map((issue) => issue.code)).toEqual(["unsupported-exact-value"]);
  });

  it("normalizes all 4,096 subsets of omitted sections and is idempotent", () => {
    for (let mask = 0; mask < 2 ** sections.length; mask++) {
      const included = sections.filter((_, index) => (mask & (1 << index)) !== 0);
      // Truly empty output must still fail; a free-form note exercises the zero-heading case.
      const raw = included.map(({ name, body }) => `## ${name}\n${body}`).join("\n\n") || "Synthetic unsectioned note";
      const result = normalizeSummaryStructure(raw, input);
      expectContract(result.content);
      for (const { name, body } of included) expect(sectionBody(result.content, name)).toContain(body);
      for (const name of semanticSections.filter((name) => !included.some((section) => section.name === name))) {
        expect(sectionBody(result.content, name)).toContain(marker);
      }
      const second = normalizeSummaryStructure(result.content, input);
      expect(second).toEqual({ content: result.content, issues: [] });
    }
  });
});
