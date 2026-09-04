import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadConfig,
  resolveDatabasePath,
  resolveRankingModelPath,
  validateConfigFile,
} from "ds4-context-core/config/config-loader";

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
      storage: {
        busyTimeoutMs: 2_000,
        writeRetryTimeoutMs: 20_000,
        projectIndexLeaseMs: 60_000,
      },
    }));
    writeFileSync(join(cwd, ".pi", "ds4-context.json"), JSON.stringify({
      context: { targetFillRatio: 0.65 },
      retrieval: { maxResults: 20 },
      project: { maxResults: 5, snippetLines: 60, snippetOverlapLines: 10 },
      memory: {
        crossSession: true,
        maxProjectSessions: 50,
        maxPinChars: 3000,
        maxClaimChars: 1500,
        maxResults: 6,
      },
      artifacts: { maxInlineToolResultChars: 8000, maxSearchMatches: 6 },
      localKvReuse: { enabled: true },
      quality: { enabled: true, maxSamples: 250 },
      ranking: {
        mode: "shadow",
        modelPath: "models/ranker.json",
        minimumTrainingSamples: 10,
        maxTrainingSamples: 500,
        maxLatencyMs: 5,
      },
    }));

    const result = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });

    expect(result.config.context.mode).toBe("observer");
    expect(result.config.context.targetFillRatio).toBe(0.65);
    expect(result.config.context.softLimitRatio).toBe(0.8);
    expect(result.config.retrieval.maxResults).toBe(20);
    expect(result.config.project).toMatchObject({ maxResults: 5, snippetLines: 60, snippetOverlapLines: 10 });
    expect(result.config.memory).toMatchObject({
      crossSession: true,
      maxProjectSessions: 50,
      maxPinChars: 3000,
      maxClaimChars: 1500,
      maxResults: 6,
    });
    expect(result.config.artifacts).toMatchObject({ maxInlineToolResultChars: 8000, maxSearchMatches: 6 });
    expect(result.config.localKvReuse).toEqual({ enabled: true });
    expect(result.config.quality).toEqual({ enabled: true, maxSamples: 250 });
    expect(result.config.ranking).toEqual({
      mode: "shadow",
      modelPath: "models/ranker.json",
      minimumTrainingSamples: 10,
      maxTrainingSamples: 500,
      maxLatencyMs: 5,
    });
    expect(result.config.diagnostics.logLevel).toBe("debug");
    expect(result.config.storage).toMatchObject({
      busyTimeoutMs: 2_000,
      writeRetryTimeoutMs: 20_000,
      projectIndexLeaseMs: 60_000,
    });
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

  it("accepts an opt-in dedicated compaction model and thinking level", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      compaction: {
        model: { provider: "dedicated-provider", id: "dedicated-model" },
        summary: { thinking: "medium" },
      },
    }));

    const result = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });

    expect(result.config.compaction.model).toEqual({
      provider: "dedicated-provider",
      id: "dedicated-model",
    });
    expect(result.config.compaction.summary?.thinking).toBe("medium");
    expect(result.warnings).toEqual([]);
  });

  it("rejects an invalid compaction thinking level", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      compaction: { summary: { thinking: "ultra" } },
    }));

    const result = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });

    expect(result.config.compaction.summary?.thinking).toBeUndefined();
    expect(result.loadedFiles).toEqual([]);
    expect(result.warnings.join("\n")).toContain("compaction.summary.thinking must be one of");
  });

  it("loads bounded local embedding settings and requires exact remote consent", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      retrieval: {
        semantic: true,
        embedding: {
          mode: "remote",
          provider: "embed.example",
          model: "semantic-v2",
          dimensions: 768,
          remoteProfiles: ["embed.example/semantic-v2"],
          candidatePool: 40,
        },
      },
      privacy: { enabled: true },
    }));

    const result = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });

    expect(result.config.retrieval.semantic).toBe(true);
    expect(result.config.retrieval.embedding).toMatchObject({
      mode: "remote",
      provider: "embed.example",
      model: "semantic-v2",
      dimensions: 768,
      remoteProfiles: ["embed.example/semantic-v2"],
      candidatePool: 40,
    });
    expect(result.loadedFiles).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it("rejects remote embedding without consent and privacy filtering", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      retrieval: {
        semantic: true,
        embedding: {
          mode: "remote",
          provider: "embed.example",
          model: "semantic-v2",
        },
      },
    }));

    const result = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });

    expect(result.config.retrieval.semantic).toBe(false);
    expect(result.config.retrieval.embedding.mode).toBe("local");
    expect(result.loadedFiles).toEqual([]);
    expect(result.warnings.join("\n")).toContain("exact provider/model consent");
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

  it("rejects unbounded memory and pin configuration", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({ memory: { maxResults: 101 } }));

    const result = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });

    expect(result.config.memory.maxResults).toBe(12);
    expect(result.loadedFiles).toEqual([]);
    expect(result.warnings.join("\n")).toContain("memory.maxResults");
  });

  it("keeps cross-session memory opt-in and rejects an unsafe session discovery bound", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    const defaults = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });
    expect(defaults.config.memory).toMatchObject({
      crossSession: false,
      maxProjectSessions: 250,
    });

    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      memory: { crossSession: true, maxProjectSessions: 0 },
    }));
    const rejected = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });
    expect(rejected.loadedFiles).toEqual([]);
    expect(rejected.config.memory.crossSession).toBe(false);
    expect(rejected.warnings.join("\n")).toContain("memory.maxProjectSessions");
  });

  it("rejects artifact search limits larger than stored objects", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      artifacts: { maxArtifactBytes: 1000, maxSearchBytes: 1001 },
    }));

    const result = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });

    expect(result.config.artifacts.maxArtifactBytes).toBe(100_000_000);
    expect(result.loadedFiles).toEqual([]);
    expect(result.warnings.join("\n")).toContain("must not exceed");
  });

  it("loads dynamic remote provider privacy allow rules", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      privacy: {
        enabled: true,
        localProviders: ["ollama"],
        remoteDefaultAllowed: ["normal"],
        remoteProviders: { "custom-gateway": ["normal", "internal", "sensitive"] },
      },
    }));
    writeFileSync(join(cwd, ".pi", "ds4-context.json"), JSON.stringify({
      privacy: { remoteProviders: { "project-gateway": ["normal"] } },
    }));

    const result = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });

    expect(result.config.privacy.remoteProviders["custom-gateway"]).toEqual(["normal", "internal", "sensitive"]);
    expect(result.config.privacy.remoteProviders["project-gateway"]).toEqual(["normal"]);
    expect(result.loadedFiles).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it("rejects local-only remote rules and ambiguous provider destinations", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      privacy: {
        localProviders: ["openai"],
        remoteProviders: { openai: ["normal", "local-only"] },
      },
    }));

    const result = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });

    expect(result.loadedFiles).toEqual([]);
    expect(result.warnings.join("\n")).toMatch(/both local and remote|cannot allow local-only/u);
  });

  it("merges and validates model-specific profile overrides", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      modelAwareness: {
        calibrationWindow: 40,
        minimumCalibrationSamples: 5,
        overrides: {
          "*": { safetyMarginTokens: 2048 },
          "test/*": { recentTailTokens: 18000 },
        },
      },
    }));
    writeFileSync(join(cwd, ".pi", "ds4-context.json"), JSON.stringify({
      modelAwareness: {
        overrides: {
          "test/model-large": { contextWindow: 200000, maxRetrievedHistoryTokens: 12000 },
        },
      },
    }));

    const result = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });

    expect(result.config.modelAwareness).toMatchObject({
      calibrationWindow: 40,
      minimumCalibrationSamples: 5,
      overrides: {
        "*": { safetyMarginTokens: 2048 },
        "test/*": { recentTailTokens: 18000 },
        "test/model-large": { contextWindow: 200000, maxRetrievedHistoryTokens: 12000 },
      },
    });
    expect(result.warnings).toEqual([]);
  });

  it("rejects unsafe calibration bounds and unknown override fields", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      modelAwareness: {
        calibrationRatioLowerBound: 2,
        calibrationRatioUpperBound: 1,
        overrides: { "test/model": { mysteryBudget: 10 } },
      },
    }));

    const result = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });

    expect(result.loadedFiles).toEqual([]);
    expect(result.config.modelAwareness).toEqual(expect.objectContaining({
      calibrationRatioLowerBound: 0.5,
      calibrationRatioUpperBound: 2,
    }));
    expect(result.warnings.join("\n")).toMatch(/calibration ratio bounds|Unknown modelAwareness/u);
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

  it("requires explicit provider-storage consent for native continuation", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      nativeContinuation: {
        enabled: true,
        profiles: ["openai/*"],
      },
    }));

    const rejected = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });
    expect(rejected.loadedFiles).toEqual([]);
    expect(rejected.config.nativeContinuation.enabled).toBe(false);
    expect(rejected.warnings.join("\n")).toContain("allowProviderStorage must be true");

    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      nativeContinuation: {
        enabled: true,
        allowProviderStorage: true,
        profiles: ["openai/*", "proxy/vendor/model"],
        maxStateAgeMs: 60_000,
        retryManagedReplay: false,
      },
    }));
    const accepted = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });
    expect(accepted.warnings).toEqual([]);
    expect(accepted.config.nativeContinuation).toMatchObject({
      enabled: true,
      allowProviderStorage: true,
      profiles: ["openai/*", "proxy/vendor/model"],
      maxStateAgeMs: 60_000,
      retryManagedReplay: false,
    });
  });

  it("rejects global, malformed, duplicate, and unsafe-age continuation profiles", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      nativeContinuation: {
        enabled: true,
        allowProviderStorage: true,
        profiles: ["*"],
        maxStateAgeMs: 1,
      },
    }));

    const result = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });
    expect(result.loadedFiles).toEqual([]);
    expect(result.config.nativeContinuation.enabled).toBe(false);
    expect(result.warnings.join("\n")).toMatch(/provider\/model|provider\/\*/u);
  });

  it("rejects unsafe quality retention limits", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      quality: { enabled: true, maxSamples: 0 },
    }));

    const result = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });
    expect(result.loadedFiles).toEqual([]);
    expect(result.config.quality).toEqual({ enabled: false, maxSamples: 1000 });
    expect(result.warnings.join("\n")).toContain("quality.maxSamples");
  });

  it("rejects invalid local KV opt-in configuration", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      localKvReuse: { enabled: "yes" },
    }));

    const result = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });
    expect(result.loadedFiles).toEqual([join(agentDir, "ds4-context.json")]);
    expect(result.config.localKvReuse).toEqual({ enabled: false });
    expect(result.warnings.join("\n")).toContain("localKvReuse.enabled");
  });

  it("rejects unsafe learned-ranking configuration", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      ranking: {
        mode: "active",
        modelPath: "",
        minimumTrainingSamples: 1,
        maxTrainingSamples: 0,
        maxLatencyMs: 0,
      },
    }));

    const result = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });
    expect(result.loadedFiles).toEqual([]);
    expect(result.config.ranking).toEqual({
      mode: "off",
      modelPath: "ds4-context/ranking-model.json",
      minimumTrainingSamples: 20,
      maxTrainingSamples: 10_000,
      maxLatencyMs: 10,
    });
    expect(result.warnings.join("\n")).toMatch(/ranking\.(?:modelPath|minimumTrainingSamples|maxTrainingSamples|maxLatencyMs)/u);
  });

  it("rejects unsafe SQLite contention settings", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      storage: {
        busyTimeoutMs: 10_000,
        writeRetryTimeoutMs: 5_000,
        projectIndexLeaseMs: 1_000,
      },
    }));

    const result = loadConfig({ agentDir, cwd, configDirName: ".pi", projectTrusted: true });
    expect(result.loadedFiles).toEqual([]);
    expect(result.config.storage).toMatchObject({
      busyTimeoutMs: 5_000,
      writeRetryTimeoutMs: 30_000,
      projectIndexLeaseMs: 120_000,
    });
    expect(result.warnings.join("\n")).toMatch(/storage\.(?:writeRetryTimeoutMs|projectIndexLeaseMs)/u);
  });

  it("resolves storage paths against the Pi agent directory", () => {
    expect(resolveDatabasePath("ds4-context/context.db", "/agent", "/home/test"))
      .toBe("/agent/ds4-context/context.db");
    expect(resolveDatabasePath("~/.cache/context.db", "/agent", "/home/test"))
      .toBe("/home/test/.cache/context.db");
    expect(resolveRankingModelPath("ds4-context/ranking-model.json", "/agent", "/home/test"))
      .toBe("/agent/ds4-context/ranking-model.json");
  });

  describe("validateConfigFile", () => {
    it("returns defaults and no warnings for an empty file", () => {
      const { config, warnings } = validateConfigFile({});
      expect(warnings).toEqual([]);
      expect(config.context.mode).toBe("managed");
    });

    it("reports unknown keys as warnings but keeps default config", () => {
      const { config, warnings } = validateConfigFile({ context: { bogus: true } });
      expect(warnings.join("\n")).toMatch(/unknown configuration key/iu);
      expect(config.context.mode).toBe("managed");
      expect(config.context.targetFillRatio).toBe(0.7);
    });

    it("accepts the compaction opt-in fields introduced in 0.3.1", () => {
      const { config, warnings } = validateConfigFile({
        compaction: {
          model: { provider: "openai-codex", id: "gpt-5.4-mini" },
          summary: { thinking: "low" },
        },
      });
      expect(warnings).toEqual([]);
      expect(config.compaction.model).toEqual({ provider: "openai-codex", id: "gpt-5.4-mini" });
      expect(config.compaction.summary?.thinking).toBe("low");
    });

    it("rejects invalid field values before any file is written", () => {
      expect(() => validateConfigFile({ context: { mode: "wat" } })).toThrow(/context.mode/u);
      expect(() => validateConfigFile({ compaction: { model: { provider: "" } } })).toThrow();
      expect(() => validateConfigFile({ compaction: { summary: { thinking: "boh" } } })).toThrow();
      expect(() => validateConfigFile({ storage: { busyTimeoutMs: 0 } })).toThrow(/storage.busyTimeoutMs/u);
    });

    it("accepts and merges a partial compaction.transport policy", () => {
      const { config, warnings } = validateConfigFile({
        compaction: { transport: { baseDelayMs: 1 } },
      });
      expect(warnings).toEqual([]);
      expect(config.compaction.transport).toEqual({ maxAttempts: 3, baseDelayMs: 1 });
      const full = validateConfigFile({
        compaction: { transport: { maxAttempts: 5, baseDelayMs: 50 } },
      });
      expect(full.config.compaction.transport).toEqual({ maxAttempts: 5, baseDelayMs: 50 });
    });

    it("rejects out-of-range compaction.transport values", () => {
      expect(() => validateConfigFile({ compaction: { transport: { maxAttempts: 0 } } }))
        .toThrow(/compaction.transport.maxAttempts/u);
      expect(() => validateConfigFile({ compaction: { transport: { maxAttempts: 11 } } }))
        .toThrow(/compaction.transport.maxAttempts/u);
      expect(() => validateConfigFile({ compaction: { transport: { baseDelayMs: -1 } } }))
        .toThrow(/compaction.transport.baseDelayMs/u);
      expect(() => validateConfigFile({ compaction: { transport: { baseDelayMs: 60001 } } }))
        .toThrow(/compaction.transport.baseDelayMs/u);
    });
  });
});
