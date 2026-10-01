import { describe, expect, it } from "vitest";
import {
  buildFtsQuery,
  currentRequestText,
  describeTask,
} from "ds4-context-core/retrieval/task-descriptor";

describe("retrieval task descriptor", () => {
  it("extracts coding identifiers, files, errors, phrases, and lexical terms", () => {
    const descriptor = describeTask(
      'Come avevamo deciso di gestire `LastExportUtc` in src/DatabaseManager.cs after SQLITE_BUSY with --force? "nullable timestamp"',
    );

    expect(descriptor.exactIdentifiers).toEqual(expect.arrayContaining([
      "LastExportUtc",
      "src/DatabaseManager.cs",
      "SQLITE_BUSY",
      "--force",
    ]));
    expect(descriptor.files).toContain("src/DatabaseManager.cs");
    expect(descriptor.errors).toContain("SQLITE_BUSY");
    expect(descriptor.phrases).toContain("nullable timestamp");
    expect(descriptor.keywords).toContain("gestire");
    expect(descriptor.queryTerms[0]).toBe("LastExportUtc");
  });

  it.each([
    "procedi", "Procedi", "ok procedi allora", "si prosegui", "continua", "Continue please", "yes proceed", "grazie",
  ])("does not turn an acknowledgement into a historical query: %s", (request) => {
    const descriptor = describeTask(request);
    expect(descriptor.queryTerms).toEqual([]);
    expect(descriptor.exactIdentifiers).toEqual([]);
  });

  it("keeps topic terms rather than generic Italian workflow words", () => {
    const descriptor = describeTask(
      "Aggiungi progetti legacy fuori dalla cartella orbit: devi considerare la memoria, ovvero quelli precedenti.",
    );
    expect(descriptor.queryTerms).toEqual(expect.arrayContaining(["legacy", "cartella", "orbit", "memoria"]));
    for (const term of ["aggiungi", "devi", "considerare", "ovvero", "quelli"]) {
      expect(descriptor.queryTerms.map((value) => value.toLowerCase())).not.toContain(term);
    }
  });

  it("preserves explicitly named identifiers and phrases even when they are stopwords", () => {
    const descriptor = describeTask('Inspect `Continue`, `devi`, and Workflow.Proceed in src/Continue.ts: "procedi allora"');
    expect(descriptor.exactIdentifiers).toEqual(expect.arrayContaining([
      "Continue", "devi", "Workflow.Proceed", "src/Continue.ts",
    ]));
    expect(descriptor.phrases).toContain("procedi allora");
    expect(descriptor.queryTerms).toEqual(expect.arrayContaining(["Continue", "devi", "procedi allora"]));
  });

  it("quotes every FTS term instead of accepting user operators", () => {
    const query = buildFtsQuery(['name" OR secret*', "foo NEAR bar", "LastExportUtc"]);

    expect(query).toBe('"name"" OR secret*" OR "foo NEAR bar" OR "LastExportUtc"');
  });

  it("reads only the latest user text blocks", () => {
    expect(currentRequestText([
      { role: "user", content: "old" },
      { role: "assistant", content: [{ type: "text", text: "response" }] },
      { role: "user", content: [{ type: "text", text: "latest" }, { type: "image", data: "ignored" }] },
    ])).toBe("latest");
  });
});
