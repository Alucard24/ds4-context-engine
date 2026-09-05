import { describe, expect, it } from "vitest";
import {
  CONFIG_FIELD_DOCS,
  applyConfigValue,
  findConfigField,
  getConfigValue,
  removeConfigValue,
} from "ds4-context-core/config/config-catalog";
import { DEFAULT_CONFIG, createDefaultConfig } from "ds4-context-core/config/config";
import { validateConfigFile } from "ds4-context-core/config/config-loader";

describe("config catalog", () => {
  it("describes every non-optional default key with a matching kind", () => {
    expect(CONFIG_FIELD_DOCS.length).toBeGreaterThan(80);
    const seen = new Set<string>();
    for (const doc of CONFIG_FIELD_DOCS) {
      expect(seen.has(doc.path)).toBe(false);
      seen.add(doc.path);
      expect(findConfigField(doc.path)).toBe(doc);
      if (!doc.optional) {
        const value = getConfigValue(DEFAULT_CONFIG, doc.path);
        expect(value, doc.path).toBeDefined();
        const expectedKind = doc.kind === "boolean"
          ? "boolean"
          : doc.kind === "integer" || doc.kind === "number"
            ? "number"
            : doc.kind === "string" || doc.kind === "enum"
              ? "string"
              : "object";
        expect(value, doc.path).toBeTypeOf(expectedKind);
        if (doc.kind === "enum") expect(doc.values).toContain(value);
      }
    }
    // Spot-check that a few optional nested paths resolve through defaults.
    expect(getConfigValue(DEFAULT_CONFIG, "context.targetFillRatio")).toBe(0.7);
    expect(getConfigValue(DEFAULT_CONFIG, "compaction.segmentTargetTokens")).toBe(30000);
    expect(getConfigValue(DEFAULT_CONFIG, "compaction.model")).toBeUndefined();
    expect(getConfigValue(DEFAULT_CONFIG, "compaction.summary.thinking")).toBeUndefined();
  });

  it("converts and applies scalar values, creating intermediate objects", () => {
    const target: Record<string, unknown> = {};
    expect(applyConfigValue(target, "context.mode", "observer",
      findConfigField("context.mode")!)).toBe("observer");
    expect(applyConfigValue(target, "context.targetFillRatio", "0.65",
      findConfigField("context.targetFillRatio")!)).toBe(0.65);
    expect(applyConfigValue(target, "context.maxPinnedTokens", "12000",
      findConfigField("context.maxPinnedTokens")!)).toBe(12000);
    expect(applyConfigValue(target, "compaction.model.provider", "openai-codex",
      findConfigField("compaction.model.provider")!)).toBe("openai-codex");
    expect(applyConfigValue(target, "compaction.model.id", "gpt-5.4-mini",
      findConfigField("compaction.model.id")!)).toBe("gpt-5.4-mini");
    expect(applyConfigValue(target, "compaction.summary.thinking", "low",
      findConfigField("compaction.summary.thinking")!)).toBe("low");
    expect(target).toEqual({
      context: { mode: "observer", targetFillRatio: 0.65, maxPinnedTokens: 12000 },
      compaction: { model: { provider: "openai-codex", id: "gpt-5.4-mini" }, summary: { thinking: "low" } },
    });
  });

  it.each(["editing.postEditReport", "reading.adaptive", "artifacts.adaptiveBudget", "jobs.enabled"])("round-trips independent default-off switch %s", (path) => {
    const target: Record<string, unknown> = {};
    expect(getConfigValue(createDefaultConfig(), path)).toBe(false);
    applyConfigValue(target, path, "true", findConfigField(path)!);
    expect(getConfigValue(validateConfigFile(target).config, path)).toBe(true);
    expect(() => applyConfigValue(target, path, "1", findConfigField(path)!)).toThrow();
    const [section, key] = path.split(".");
    const invalid = validateConfigFile({ [section!]: { [key!]: "true" } });
    expect(getConfigValue(invalid.config, path)).toBe(false);
    expect(invalid.warnings.length).toBeGreaterThan(0);
    expect(removeConfigValue(target, path)).toBe(true);
    expect(getConfigValue(validateConfigFile(target).config, path)).toBe(false);
  });

  it("round-trips the opt-in anchored editing switch and rejects wrong types", () => {
    const target: Record<string, unknown> = {};
    expect(getConfigValue(createDefaultConfig(), "editing.anchored")).toBe(false);
    applyConfigValue(target, "editing.anchored", "true", findConfigField("editing.anchored")!);
    expect(validateConfigFile(target).config.editing.anchored).toBe(true);
    for (const invalid of [{ editing: { anchored: "true" } }, { editing: true }]) {
      const result = validateConfigFile(invalid);
      expect(result.config.editing.anchored).toBe(false);
      expect(result.warnings).toEqual([expect.stringContaining("editing")]);
    }
    expect(removeConfigValue(target, "editing.anchored")).toBe(true);
    expect(validateConfigFile(target).config.editing.anchored).toBe(false);
  });

  it("round-trips compaction optimization controls with bounded validation", () => {
    const target: Record<string, unknown> = {};
    for (const [path, raw, defaultValue, value] of [
      ["compaction.directUpdate", "false", true, false],
      ["compaction.inputBudget", "context", "summary", "context"],
      ["compaction.maxConcurrentSegments", "1", 2, 1],
    ] as const) {
      expect(getConfigValue(createDefaultConfig(), path)).toBe(defaultValue);
      applyConfigValue(target, path, raw, findConfigField(path)!);
      expect(getConfigValue(validateConfigFile(target).config, path)).toBe(value);
      expect(removeConfigValue(target, path)).toBe(true);
      expect(getConfigValue(validateConfigFile(target).config, path)).toBe(defaultValue);
    }
    for (const maxConcurrentSegments of [0, -1, 1.5, 3, 100]) {
      expect(() => validateConfigFile({ compaction: { maxConcurrentSegments } })).toThrow("between 1 and 2");
    }
    expect(() => validateConfigFile({ compaction: { inputBudget: "unlimited" } })).toThrow("summary or context");
    for (const [key, value] of [["maxConcurrentSegments", "2"], ["directUpdate", "true"], ["inputBudget", 1]]) {
      expect(validateConfigFile({ compaction: { [key as string]: value } }).warnings).toHaveLength(1);
    }
  });

  it("preserves sibling keys when applying nested paths", () => {
    const target: Record<string, unknown> = {
      compaction: { enabled: false },
    };
    applyConfigValue(target, "compaction.model.provider", "ollama",
      findConfigField("compaction.model.provider")!);
    expect((target.compaction as Record<string, unknown>).enabled).toBe(false);
  });

  it("rejects malformed values with precise messages", () => {
    const apply = (path: string, raw: string) =>
      applyConfigValue({}, path, raw, findConfigField(path)!);
    expect(() => apply("enabled", "yes")).toThrow(/expected true or false/);
    expect(() => apply("context.maxPinnedTokens", "1.5")).toThrow(/safe integer/);
    expect(() => apply("context.maxPinnedTokens", "abc")).toThrow(/safe integer/);
    expect(() => apply("context.targetFillRatio", "nan")).toThrow(/finite number/);
    expect(() => apply("context.mode", "wat")).toThrow(/one of/);
    expect(() => apply("ranking.mode", "auto")).toThrow(/one of/);
    expect(() => apply("compaction.summary.thinking", "boh")).toThrow(/one of/);
    expect(() => apply("diagnostics.logLevel", "verbose")).toThrow(/one of/);
    expect(() => apply("retrieval.embedding.remoteProfiles", "not-json")).toThrow(/valid JSON/);
    expect(() => apply("retrieval.embedding.remoteProfiles", "[1]")).toThrow(/array of strings/);
    expect(() => apply("privacy.remoteDefaultAllowed", '["normal","normal"]')).toThrow(/duplicate/);
    expect(() => apply("privacy.remoteDefaultAllowed", '["normal","secret"]')).toThrow(/allowed/);
    expect(() => apply("privacy.remoteProviders", '{"ollama":["bogus"]}')).toThrow(/must map to an array/);
    expect(() => apply("modelAwareness.overrides", '{"p/m":1}')).toThrow(/must be a JSON object/);
    expect(() => apply("compaction.model", '[1]')).toThrow(/JSON object/);
    expect(() => apply("enabled", "")).toThrow(/true or false/);
  });

  it("sets classification maps and object maps from JSON", () => {
    const target: Record<string, unknown> = {};
    applyConfigValue(target, "privacy.remoteProviders",
      '{"ollama":["normal","internal"]}', findConfigField("privacy.remoteProviders")!);
    applyConfigValue(target, "modelAwareness.overrides",
      '{"openai-codex/gpt-5.4-mini":{"contextWindow":200000}}',
      findConfigField("modelAwareness.overrides")!);
    expect(target).toEqual({
      privacy: { remoteProviders: { ollama: ["normal", "internal"] } },
      modelAwareness: { overrides: { "openai-codex/gpt-5.4-mini": { contextWindow: 200000 } } },
    });
  });

  it("removes keys and prunes empty intermediate objects", () => {
    const target: Record<string, unknown> = {
      compaction: {
        enabled: false,
        model: { provider: "ollama", id: "x" },
      },
    };
    expect(removeConfigValue(target, "compaction.model.provider")).toBe(true);
    expect(target).toEqual({ compaction: { enabled: false, model: { id: "x" } } });
    expect(removeConfigValue(target, "compaction.model.id")).toBe(true);
    expect(target).toEqual({ compaction: { enabled: false } });
    expect(removeConfigValue(target, "compaction.model")).toBe(false);
    expect(removeConfigValue(target, "context.mode")).toBe(false);
  });

  it("round-trips a realistic edited file through validateConfigFile", () => {
    const target: Record<string, unknown> = {};
    const apply = (path: string, raw: string) =>
      applyConfigValue(target, path, raw, findConfigField(path)!);
    apply("context.targetFillRatio", "0.65");
    apply("compaction.model", '{"provider":"openai-codex","id":"gpt-5.4-mini"}');
    apply("compaction.summary.thinking", "low");
    apply("compaction.segmentTargetTokens", "45000");
    apply("privacy.enabled", "true");
    apply("privacy.localProviders", '["ollama"]');
    apply("retrieval.embedding.mode", "local");
    apply("diagnostics.logLevel", "debug");
    const { config, warnings } = validateConfigFile(target);
    expect(warnings).toEqual([]);
    expect(config.compaction.model).toEqual({ provider: "openai-codex", id: "gpt-5.4-mini" });
    expect(config.compaction.summary?.thinking).toBe("low");
    expect(config.privacy.enabled).toBe(true);
    expect(config.diagnostics.logLevel).toBe("debug");
    expect(createDefaultConfig().compaction.model).toBeUndefined();
  });
});
