#!/usr/bin/env node
/** Bounded, opt-in Pi+DS4 live probe. Only aggregate token metadata leaves this process. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { syntheticUserPrompt, compareEstimate } from "./compare-provider-token-drift.mjs";

export const MODEL_ID = "openai/gpt-6-sol";
export const COMPARISON_MODELS = ["openai/gpt-6-luna", "openai/gpt-5.6-terra"];
export const MAX_CALLS = 12;
export const MAX_CHARS = 120_000;
export const MAX_COMPARISON_CALLS = 24;
export const MAX_COMPARISON_CHARS = 240_000;
export const SIZES = [512, 4_096, 12_000, 20_000];
export const REPEATS = 3;
export const SYSTEM_PROMPT = "Token measurement probe. Reply only OK. Do not quote the data.";

export function plan(samples = SIZES.flatMap((size) => Array(REPEATS).fill(size))) {
  if (!Array.isArray(samples) || samples.length === 0 || samples.some((size) =>
    !Number.isSafeInteger(size) || size < 64)) throw new Error("invalid sample sizes");
  const chars = samples.reduce((total, size) => total + size + SYSTEM_PROMPT.length, 0);
  if (samples.length > MAX_CALLS || chars > MAX_CHARS) throw new Error("exceeds approved probe limits");
  return { samples, calls: samples.length, chars };
}

export function comparisonPlan() {
  const perModel = plan();
  const calls = perModel.calls * COMPARISON_MODELS.length;
  const chars = perModel.chars * COMPARISON_MODELS.length;
  if (calls > MAX_COMPARISON_CALLS || chars > MAX_COMPARISON_CHARS) {
    throw new Error("exceeds approved two-model comparison limits");
  }
  return { models: COMPARISON_MODELS.map((id) => `openrouter/${id}`),
    samplesPerModel: perModel.samples, calls, chars };
}

function createSandbox(root, modelId) {
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
    modelAwareness: { autoTune: false, overrides: { [`openrouter/${modelId}`]: { tokenEstimator: "o200k-base-v1" } } },
    nativeContinuation: { enabled: false, allowProviderStorage: false },
  }));
  return { cwd, agentDir };
}

async function measureOne(size, modelRuntime, model, register, sampleIndex) {
  const root = mkdtempSync(join(tmpdir(), "ds4-manifest-probe-"));
  let session;
  let ds4;
  try {
    const { cwd, agentDir } = createSandbox(root, model.id);
    const loader = new DefaultResourceLoader({
      cwd, agentDir, systemPrompt: SYSTEM_PROMPT,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => { ds4 = register(pi, { agentDir, homeDir: root }); }],
    });
    await loader.reload();
    const created = await createAgentSession({
      cwd, agentDir, model: { ...model, maxTokens: 64 }, modelRuntime,
      resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      thinkingLevel: "off", noTools: "all",
    });
    session = created.session;
    // createAgentSession constructs the runner; bindExtensions emits session_start.
    // Without this, DS4 remains idle and the manifest comparison would be invalid.
    await session.bindExtensions({ mode: "print" });
    const prompt = syntheticUserPrompt(size);
    // No session files, actual user data, tools, or arbitrary files enter the prompt.
    await session.prompt(prompt);
    const manifest = ds4?.latestManifest();
    if (!manifest || manifest.provider !== "openrouter" || manifest.model !== model.id
      || manifest.modelAwareness?.calibration.estimator !== "o200k-base-v1"
      || manifest.planning?.mode !== "managed") {
      return { sampleIndex, model: `openrouter/${model.id}`, userChars: size, status: "invalid-manifest" };
    }
    const usage = manifest.providerUsage;
    if (!usage || manifest.actualInputTokens !== usage.totalInputTokens
      || !Number.isSafeInteger(usage.totalInputTokens) || usage.totalInputTokens <= 0) {
      return { sampleIndex, model: `openrouter/${model.id}`, userChars: size, status: "missing-usage" };
    }
    return {
      sampleIndex, model: `openrouter/${model.id}`, userChars: size, status: "ok",
      estimator: manifest.modelAwareness.calibration.estimator,
      planningMode: manifest.planning.mode,
      estimatedInputTokens: manifest.estimatedInputTokens,
      actualInputTokens: usage.totalInputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      comparison: compareEstimate(usage.totalInputTokens, manifest.estimatedInputTokens),
    };
  } catch (error) {
    // SDK errors and provider response text may contain private data; do not print them.
    return { sampleIndex, model: `openrouter/${model.id}`, userChars: size, status: "failed", errorType: error instanceof Error ? error.name : "unknown" };
  } finally {
    try { ds4?.shutdown(); } finally {
      try { session?.dispose(); } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }
}

export async function main(argv) {
  const allowed = new Set(["--live", "--comparison"]);
  if (argv.some((arg) => !allowed.has(arg)) || new Set(argv).size !== argv.length) {
    throw new Error("only --live and --comparison are supported");
  }
  const comparison = argv.includes("--comparison");
  const live = argv.includes("--live");
  const perModel = plan();
  const budget = comparison ? comparisonPlan() : {
    models: [`openrouter/${MODEL_ID}`], samplesPerModel: perModel.samples,
    calls: perModel.calls, chars: perModel.chars,
  };
  if (!live) return {
    mode: "dry-run", ...(comparison ? {} : { model: `openrouter/${MODEL_ID}` }),
    budget, requires: "--live",
  };
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  const ids = comparison ? COMPARISON_MODELS : [MODEL_ID];
  const models = ids.map((id) => modelRuntime.getModel("openrouter", id));
  if (models.some((model) => !model) || !modelRuntime.hasConfiguredAuth("openrouter")) {
    return { mode: "unavailable", models: budget.models };
  }
  // Pi's own TypeScript loader supports parameter properties used by the extension;
  // Node's strip-only TypeScript loader does not.
  const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createJiti } = requireFromPi("jiti");
  const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
  const { registerDs4ContextEngine } = await jiti.import("../src/extension/index.ts");
  const rows = [];
  for (const model of models) {
    for (const size of budget.samplesPerModel) {
      rows.push(await measureOne(size, modelRuntime, model, registerDs4ContextEngine, rows.length + 1));
      // Stop on any mismatch or missing provider usage, never infer success.
      if (rows.at(-1).status !== "ok") break;
    }
    if (rows.at(-1)?.status !== "ok") break;
  }
  return {
    mode: "live", models: budget.models, budget, callsAttempted: rows.length, rows,
    limitations: "Fresh isolated in-memory Pi session per sample; synthetic one-turn prompts only. Usage is Pi-normalized provider usage correlated by the DS4 manifest, not billed usage. No session prompts/responses or credentials are recorded.",
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`),
    () => { process.stderr.write("Probe preflight failed; no provider requests should have been made.\n"); process.exitCode = 1; },
  );
}
