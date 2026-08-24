import { describe, expect, it } from "vitest";
import {
  buildFtsQuery,
  currentRequestText,
  describeTask,
} from "../../src/retrieval/task-descriptor.ts";

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
