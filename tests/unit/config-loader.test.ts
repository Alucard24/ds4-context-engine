import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resolveDatabasePath } from "../../src/config/config-loader.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "ds4-config-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("merges global and trusted project configuration", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      context: { mode: "observer", targetFillRatio: 0.6 },
      diagnostics: { logLevel: "debug" },
    }));
    writeFileSync(join(cwd, ".pi", "ds4-context.json"), JSON.stringify({
      context: { targetFillRatio: 0.65 },
      retrieval: { maxResults: 20 },
      project: { maxResults: 5, snippetLines: 60, snippetOverlapLines: 10 },
    }));

    const result = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });

    expect(result.config.context.mode).toBe("observer");
    expect(result.config.context.targetFillRatio).toBe(0.65);
    expect(result.config.context.softLimitRatio).toBe(0.8);
    expect(result.config.retrieval.maxResults).toBe(20);
    expect(result.config.project).toMatchObject({ maxResults: 5, snippetLines: 60, snippetOverlapLines: 10 });
    expect(result.config.diagnostics.logLevel).toBe("debug");
    expect(result.loadedFiles).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it("does not load project configuration for an untrusted project", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(cwd, ".pi", "ds4-context.json"), JSON.stringify({ enabled: false }));

    const result = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: false });

    expect(result.config.enabled).toBe(true);
    expect(result.loadedFiles).toEqual([]);
    expect(result.warnings[0]).toContain("not trusted");
  });

  it("rejects an invalid source without discarding previously valid configuration", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({ retrieval: { maxResults: 7 } }));
    writeFileSync(join(cwd, ".pi", "ds4-context.json"), JSON.stringify({
      context: { targetFillRatio: 0.95 },
    }));

    const result = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });

    expect(result.config.retrieval.maxResults).toBe(7);
    expect(result.config.context.targetFillRatio).toBe(0.7);
    expect(result.loadedFiles).toEqual([join(agentDir, "ds4-context.json")]);
    expect(result.warnings.join("\n")).toContain("ratios must satisfy");
  });

  it("rejects an invalid planner mode", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({ context: { mode: "unsafe" } }));

    const result = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });

    expect(result.config.context.mode).toBe("managed");
    expect(result.loadedFiles).toEqual([]);
    expect(result.warnings.join("\n")).toContain("context.mode must be observer or managed");
  });

  it("rejects unbounded retrieval result counts", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      retrieval: { maxResults: 101 },
    }));

    const result = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });

    expect(result.config.retrieval.maxResults).toBe(12);
    expect(result.loadedFiles).toEqual([]);
    expect(result.warnings.join("\n")).toContain("at most 100");
  });

  it("rejects project snippet overlap at or above the snippet size", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      project: { snippetLines: 20, snippetOverlapLines: 20 },
    }));

    const result = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });

    expect(result.config.project.snippetLines).toBe(80);
    expect(result.loadedFiles).toEqual([]);
    expect(result.warnings.join("\n")).toContain("below project.snippetLines");
  });

  it("rejects destructive compaction configuration", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      compaction: { preserveRecentVerbatim: false },
    }));

    const result = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });

    expect(result.config.compaction.preserveRecentVerbatim).toBe(true);
    expect(result.loadedFiles).toEqual([]);
    expect(result.warnings.join("\n")).toContain("must remain true");
  });

  it("resolves storage paths against the Pi agent directory", () => {
    expect(resolveDatabasePath("ds4-context/context.db", "/agent", "/home/test"))
      .toBe("/agent/ds4-context/context.db");
    expect(resolveDatabasePath("~/.cache/context.db", "/agent", "/home/test"))
      .toBe("/home/test/.cache/context.db");
  });
});
