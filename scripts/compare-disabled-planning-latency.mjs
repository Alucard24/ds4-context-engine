import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const baselineRoot = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!baselineRoot) {
  throw new Error("Usage: npm run latency:check -- /path/to/node_modules/ds4-context-core@0.1.2");
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const candidateRoot = join(repositoryRoot, "packages", "core");
const baselinePackage = JSON.parse(readFileSync(join(baselineRoot, "package.json"), "utf8"));
const candidatePackage = JSON.parse(readFileSync(join(candidateRoot, "package.json"), "utf8"));
if (baselinePackage.name !== "ds4-context-core" || baselinePackage.version !== "0.1.2") {
  throw new Error(`Latency baseline must be ds4-context-core@0.1.2, received ${String(baselinePackage.name)}@${String(baselinePackage.version)}`);
}
if (candidatePackage.name !== "ds4-context-core" || !String(candidatePackage.version).startsWith("0.2.0")) {
  throw new Error("Latency candidate must be a local ds4-context-core 0.2.0 build");
}

async function loadCore(root) {
  const planner = await import(pathToFileURL(join(root, "dist", "planner", "context-planner.js")).href);
  const config = await import(pathToFileURL(join(root, "dist", "config", "config.js")).href);
  return { plan: planner.planManagedContext, defaults: config.createDefaultConfig() };
}

const baseline = await loadCore(baselineRoot);
const candidate = await loadCore(candidateRoot);
if (candidate.defaults.retrieval.semantic !== false
  || candidate.defaults.memory.crossSession !== false
  || candidate.defaults.quality.enabled !== false
  || candidate.defaults.ranking.mode !== "off"
  || candidate.defaults.localKvReuse.enabled !== false) {
  throw new Error("Candidate feature-disabled defaults are not compatible with the 0.1 baseline");
}

const messages = Array.from({ length: 401 }, (_, index) => ({
  role: index % 2 === 0 ? "user" : "assistant",
  content: index === 400
    ? "CURRENT-LATENCY-REQUEST"
    : `${index} ${"deterministic planning payload ".repeat(8)}`,
}));
const budget = {
  contextWindow: 32_000,
  outputReserve: 4_096,
  safetyMargin: 1_024,
  modelInputHardLimit: 26_880,
  hardInputLimit: 24_000,
  softInputLimit: 21_000,
  preferredInputTarget: 18_000,
  activeInputBudget: 18_000,
};

function input(defaults) {
  return {
    messages,
    fixedTokens: 512,
    budget,
    config: { ...defaults.context, recentTailTokens: 8_000 },
  };
}

function verify(core) {
  const plan = core.plan(input(core.defaults));
  if (plan.mode !== "managed"
    || plan.messages.at(-1)?.content !== "CURRENT-LATENCY-REQUEST"
    || plan.messages.length >= messages.length) {
    throw new Error("Latency fixture did not produce the expected managed plan");
  }
}
verify(baseline);
verify(candidate);

function warm(core, iterations) {
  for (let index = 0; index < iterations; index++) core.plan(input(core.defaults));
}

function measure(core, samples) {
  const durations = [];
  for (let index = 0; index < samples; index++) {
    const startedAt = performance.now();
    core.plan(input(core.defaults));
    durations.push(performance.now() - startedAt);
  }
  return durations;
}

function percentile(values, quantile) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * quantile))] ?? 0;
}

function rounded(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

warm(baseline, 200);
warm(candidate, 200);
const baselineDurations = [];
const candidateDurations = [];
for (let round = 0; round < 5; round++) {
  const first = round % 2 === 0 ? baseline : candidate;
  const second = round % 2 === 0 ? candidate : baseline;
  const firstSamples = measure(first, 200);
  const secondSamples = measure(second, 200);
  (round % 2 === 0 ? baselineDurations : candidateDurations).push(...firstSamples);
  (round % 2 === 0 ? candidateDurations : baselineDurations).push(...secondSamples);
}

const baselineP95 = percentile(baselineDurations, 0.95);
const candidateP95 = percentile(candidateDurations, 0.95);
const ratio = baselineP95 > 0 ? candidateP95 / baselineP95 : Number.POSITIVE_INFINITY;
const report = {
  schemaVersion: 1,
  fixture: "feature-disabled-planning-v1",
  baseline: { package: `${baselinePackage.name}@${baselinePackage.version}`, p95Ms: rounded(baselineP95) },
  candidate: { package: `${candidatePackage.name}@${candidatePackage.version}`, p95Ms: rounded(candidateP95) },
  sampleCount: baselineDurations.length,
  regressionRatio: rounded(ratio),
  maximumRegressionRatio: 1.1,
  passed: ratio <= 1.1,
};
console.log(JSON.stringify(report, null, 2));
if (!report.passed) {
  throw new Error(`Feature-disabled planning p95 regressed by ${rounded((ratio - 1) * 100)}%`);
}
