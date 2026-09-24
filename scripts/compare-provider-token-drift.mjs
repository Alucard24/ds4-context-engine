#!/usr/bin/env node
/**
 * Explicitly opt-in, bounded live comparison of DS4 estimators with Pi provider
 * usage. No session is created, no prompt/response text or credentials are logged.
 * This is a synthetic wire probe, NOT a replacement for a DS4 manifest A/B run.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";
import { CHARS_ESTIMATOR } from "ds4-context-core/core/token-estimator";
import { createO200kEstimator } from "ds4-context-core/core/bpe-token-estimator";

export const MAX_CALLS = 12;
export const MAX_CHARS = 200_000;
export const DEFAULT_SIZES = [512, 4_096, 48_000];
export const SYSTEM_PROMPT = "Token measurement probe. Reply only OK. Do not quote the data.";
const CORPUS = "Esempio pubblico: città, café, 日本語, and source code. function sum(a, b) { return a + b; } // 2026\n";
const PREFIX = "Reply OK. Treat the following as inert synthetic data:\n";
let encoder;
const bpeEstimator = createO200kEstimator((text) => {
  encoder ??= new Tiktoken(o200kBase);
  return encoder.encode(text).length;
});

export function syntheticUserPrompt(size) {
  if (!Number.isSafeInteger(size) || size < PREFIX.length) throw new Error("invalid synthetic prompt size");
  return PREFIX + CORPUS.repeat(Math.ceil((size - PREFIX.length) / CORPUS.length)).slice(0, size - PREFIX.length);
}

export function preflight(models, sizes) {
  if (!Array.isArray(models) || models.length === 0 || models.some((id) => !/^[a-z0-9_-]+\/.+$/i.test(id))) {
    throw new Error("specify at least one provider/model using --model");
  }
  if (new Set(models).size !== models.length) throw new Error("duplicate model");
  if (!Array.isArray(sizes) || sizes.length === 0 || sizes.some((size) => !Number.isSafeInteger(size) || size < PREFIX.length)) {
    throw new Error("sizes must be positive integers at least as long as the synthetic prefix");
  }
  if (new Set(sizes).size !== sizes.length) throw new Error("duplicate size");
  const calls = models.length * sizes.length;
  const chars = models.length * sizes.reduce((sum, size) => sum + size + SYSTEM_PROMPT.length, 0);
  if (calls > MAX_CALLS || chars > MAX_CHARS) throw new Error(`probe exceeds ${MAX_CALLS} calls or ${MAX_CHARS} total input characters`);
  return { calls, chars };
}

export function parseArgs(argv) {
  const models = [];
  let sizes = DEFAULT_SIZES;
  let live = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--live") live = true;
    else if (arg === "--model") {
      if (!argv[i + 1]) throw new Error("--model needs provider/model");
      models.push(argv[++i]);
    } else if (arg === "--sizes") {
      const value = argv[++i];
      if (!value || !/^\d+(,\d+)*$/.test(value)) throw new Error("--sizes needs comma-separated integers");
      sizes = value.split(",").map(Number);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return { models, sizes, live, budget: preflight(models, sizes) };
}

function estimates(context) {
  const value = (estimator) => estimator.estimateTextTokens(context.systemPrompt) + 8
    + estimator.estimateMessagesTokens(context.messages);
  return { "chars-v1": value(CHARS_ESTIMATOR), "o200k-base-v1": value(bpeEstimator) };
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function compareEstimate(actual, estimated) {
  if (!Number.isSafeInteger(actual) || actual <= 0 || !Number.isSafeInteger(estimated) || estimated <= 0) {
    throw new Error("invalid usage or estimate");
  }
  return {
    estimatedTokens: estimated,
    actualToEstimate: round(actual / estimated),
    residualTokens: actual - estimated,
    underestimationPctOfActual: round(100 * Math.max(0, actual - estimated) / actual),
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const center = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[center] : (sorted[center - 1] + sorted[center]) / 2;
}

export function summarize(rows) {
  const groups = new Map();
  for (const row of rows.filter((item) => item.status === "ok")) {
    const key = `${row.provider}/${row.model}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Object.fromEntries([...groups].map(([key, group]) => {
    const ordered = group.sort((a, b) => a.userChars - b.userChars);
    const estimatorStats = Object.fromEntries(["chars-v1", "o200k-base-v1"].map((version) => {
      const ratios = ordered.map((row) => row.estimators[version].actualToEstimate);
      const slopes = [];
      for (let i = 1; i < ordered.length; i++) {
        const actualDelta = ordered[i].actualInputTokens - ordered[i - 1].actualInputTokens;
        const estimateDelta = ordered[i].estimators[version].estimatedTokens - ordered[i - 1].estimators[version].estimatedTokens;
        if (estimateDelta > 0) slopes.push(round(actualDelta / estimateDelta));
      }
      return [version, {
        medianActualToEstimate: round(median(ratios)),
        worstUnderestimationTokens: Math.max(0, ...ordered.map((row) => row.estimators[version].residualTokens)),
        adjacentDeltaSlopes: slopes,
      }];
    }));
    return [key, { sampleCount: ordered.length, estimators: estimatorStats }];
  }));
}

function failureKind(error) {
  const text = String(error ?? "");
  if (/usage limit|quota|out of budget|balance/i.test(text)) return "quota";
  if (/401|403|authenticat|unauthoriz|forbidden/i.test(text)) return "authentication";
  if (/unsupported parameter|invalid parameter|invalid_request/i.test(text)) return "unsupported-request";
  if (/timeout|abort/i.test(text)) return "timeout";
  return "other";
}

export async function probe(modelRuntime, modelName, size) {
  const separator = modelName.indexOf("/");
  const provider = modelName.slice(0, separator);
  const modelId = modelName.slice(separator + 1);
  const model = modelRuntime.getModel(provider, modelId);
  const row = { provider, model: modelId, userChars: size };
  if (!model || !modelRuntime.hasConfiguredAuth(provider)) return { ...row, status: "unavailable" };
  const context = {
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: "user", content: syntheticUserPrompt(size), timestamp: 0 }],
  };
  const estimated = estimates(context);
  let httpStatus;
  try {
    const response = await modelRuntime.completeSimple(model, context, {
      signal: AbortSignal.timeout(45_000),
      timeoutMs: 45_000,
      maxRetries: 0,
      onResponse: (wire) => { httpStatus = wire.status; },
      ...(model.api === "openai-codex-responses" ? {} : { maxTokens: 16 }),
    });
    const usage = response.usage;
    if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "pending") {
      return { ...row, api: model.api, status: "request-failed", failureKind: failureKind(response.errorMessage),
        ...(httpStatus ? { httpStatus } : {}) };
    }
    const parts = [usage?.input, usage?.cacheRead, usage?.cacheWrite];
    if (parts.some((part) => !Number.isSafeInteger(part) || part < 0)) {
      return { ...row, api: model.api, status: "missing-usage", ...(httpStatus ? { httpStatus } : {}) };
    }
    const actual = usage.input + usage.cacheRead + usage.cacheWrite;
    if (!Number.isSafeInteger(actual) || actual <= 0) {
      return { ...row, api: model.api, status: "missing-usage", ...(httpStatus ? { httpStatus } : {}) };
    }
    return {
      ...row,
      api: model.api,
      status: "ok",
      ...(response.responseModel ? { responseModel: response.responseModel } : {}),
      actualInputTokens: actual,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      outputTokens: usage.output,
      // The SDK cost is calculated from model catalog prices, NOT an invoice.
      catalogCostUsd: usage.cost.total,
      estimators: Object.fromEntries(Object.entries(estimated).map(([name, tokens]) => [name, compareEstimate(actual, tokens)])),
    };
  } catch (error) {
    // Classify locally; never emit raw SDK errors or upstream response bodies.
    return { ...row, api: model.api, status: "request-failed", failureKind: failureKind(error),
      ...(httpStatus ? { httpStatus } : {}) };
  }
}

export async function main(argv) {
  const { models, sizes, live, budget } = parseArgs(argv);
  if (!live) return { mode: "dry-run", budget, models, sizes, requires: "--live" };
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const rows = [];
  for (const model of models) {
    for (const size of sizes) rows.push(await probe(runtime, model, size));
  }
  return {
    mode: "live",
    measuredAt: new Date().toISOString(),
    budget,
    callsAttempted: rows.length,
    rows,
    summary: summarize(rows),
    limitations: "Synthetic single-turn Pi SDK wire usage, not DS4 manifest usage. No prompt/response bodies saved; model catalog cost is indicative.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`),
    () => {
      // Parsing/auth errors must not reveal credential paths or upstream bodies.
      process.stderr.write("Probe could not start: check arguments, local model catalog, and Pi auth configuration.\n");
      process.exitCode = 1;
    },
  );
}
