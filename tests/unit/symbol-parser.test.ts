import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DeterministicRegexSymbolParser,
  extractLegacySymbols,
  stableSymbolId,
  withRegexSymbolFallback,
  type ParsedSymbol,
  type SymbolParser,
} from "ds4-context-core/project/symbol-parser";

interface SymbolFixture {
  id: string;
  language: string;
  filePath: string;
  content: string;
  expectedSymbols: string[];
  forbiddenSymbols: string[];
}

interface SymbolCorpus {
  schemaVersion: number;
  corpusVersion: string;
  fixtures: SymbolFixture[];
}

function corpus(): SymbolCorpus {
  return JSON.parse(readFileSync(resolve("quality/symbol-corpus-v1.json"), "utf8")) as SymbolCorpus;
}

function symbolNames(symbols: readonly ParsedSymbol[]): string[] {
  return symbols.map((symbol) => symbol.qualifiedName);
}

describe("deterministic structural symbol parser", () => {
  it("extracts declarations, signatures, parents, imports, references, and ranges", () => {
    const parser = new DeterministicRegexSymbolParser();
    const typescript = parser.parse({
      projectPath: "/repo",
      filePath: "src/service.ts",
      fileHash: "a".repeat(64),
      language: "typescript",
      content: [
        'import { Client } from "./client.js";',
        "export class Service {",
        "  async run(client: Client): Promise<Result> {",
        "    return client.execute();",
        "  }",
        "}",
      ].join("\n"),
    });

    expect(typescript?.parserId).toBe("regex-structural-v1");
    expect(typescript?.imports).toEqual(["./client.js"]);
    expect(typescript?.symbols.find((symbol) => symbol.qualifiedName === "Service.run")).toMatchObject({
      name: "run",
      kind: "method",
      parentSymbol: "Service",
      startLine: 3,
      endLine: 5,
      imports: ["./client.js"],
    });
    expect(typescript?.symbols.find((symbol) => symbol.qualifiedName === "Service.run")?.signature)
      .toContain("async run(client: Client)");
    expect(typescript?.symbols.find((symbol) => symbol.qualifiedName === "Service.run")?.references)
      .toEqual(expect.arrayContaining(["Client", "Promise", "Result", "execute"]));
  });

  it("covers JavaScript, Python, and Go fixtures without comment/string symbols", () => {
    const parser = new DeterministicRegexSymbolParser();
    for (const fixture of corpus().fixtures) {
      const parsed = parser.parse({
        projectPath: "/fixture",
        filePath: fixture.filePath,
        fileHash: "b".repeat(64),
        language: fixture.language,
        content: fixture.content,
      });
      const names = symbolNames(parsed?.symbols ?? []);
      expect(names, fixture.id).toEqual(expect.arrayContaining(fixture.expectedSymbols));
      for (const forbidden of fixture.forbiddenSymbols) expect(names, fixture.id).not.toContain(forbidden);
    }
  });

  it("reduces false symbol matches against the versioned 0.1 regex corpus", () => {
    const parser = new DeterministicRegexSymbolParser();
    let legacyFalseMatches = 0;
    let structuralFalseMatches = 0;
    for (const fixture of corpus().fixtures) {
      const expected = new Set(fixture.expectedSymbols.map((name) => name.split(".").at(-1)));
      legacyFalseMatches += extractLegacySymbols(fixture.content).filter((name) => !expected.has(name)).length;
      const parsed = parser.parse({
        projectPath: "/fixture",
        filePath: fixture.filePath,
        fileHash: "c".repeat(64),
        language: fixture.language,
        content: fixture.content,
      });
      structuralFalseMatches += (parsed?.symbols ?? []).filter((symbol) => !expected.has(symbol.name)).length;
    }
    expect(legacyFalseMatches).toBeGreaterThan(0);
    expect(structuralFalseMatches).toBeLessThan(legacyFalseMatches);
  });

  it("falls back from an optional parser adapter to deterministic regex parsing", () => {
    const unavailable: SymbolParser = {
      id: "optional-unavailable-v1",
      languages: ["typescript"],
      parse: () => undefined,
    };
    const throwing: SymbolParser = {
      id: "optional-throwing-v1",
      languages: ["typescript"],
      parse: () => { throw new Error("adapter unavailable"); },
    };
    const input = {
      projectPath: "/repo",
      filePath: "service.ts",
      fileHash: "d".repeat(64),
      language: "typescript",
      content: "export class Service {}",
    };
    expect(withRegexSymbolFallback(unavailable).parse(input)?.symbols[0]?.name).toBe("Service");
    expect(withRegexSymbolFallback(throwing).parse(input)?.symbols[0]?.name).toBe("Service");
  });

  it("falls back to text chunking for unsupported or structurally invalid source", () => {
    const parser = new DeterministicRegexSymbolParser();
    expect(parser.parse({
      projectPath: "/repo",
      filePath: "README.md",
      fileHash: "d".repeat(64),
      language: "markdown",
      content: "# class DocumentationOnly",
    })).toBeUndefined();
    expect(parser.parse({
      projectPath: "/repo",
      filePath: "broken.ts",
      fileHash: "e".repeat(64),
      language: "typescript",
      content: "export class Broken {\n  run() {\n",
    })).toBeUndefined();
  });

  it("derives stable IDs from project, path, hash, and structural location", () => {
    const input = {
      projectPath: "/repo",
      filePath: "src/service.ts",
      fileHash: "f".repeat(64),
      language: "typescript",
      content: "export class Service {}",
    };
    const symbol: ParsedSymbol = {
      name: "Service",
      qualifiedName: "Service",
      kind: "class",
      signature: "export class Service {}",
      startLine: 1,
      endLine: 1,
      imports: [],
      references: [],
    };
    expect(stableSymbolId(input, symbol)).toBe(stableSymbolId(input, symbol));
    expect(stableSymbolId(input, symbol)).not.toBe(stableSymbolId({ ...input, fileHash: "0".repeat(64) }, symbol));
    expect(stableSymbolId(input, symbol)).not.toBe(stableSymbolId({ ...input, filePath: "src/other.ts" }, symbol));
    expect(stableSymbolId(input, symbol)).not.toBe(stableSymbolId({ ...input, projectPath: "/fork" }, symbol));
    expect(stableSymbolId(input, symbol)).not.toBe(stableSymbolId(input, { ...symbol, startLine: 2, endLine: 2 }));
  });
});
