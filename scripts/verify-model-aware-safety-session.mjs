#!/usr/bin/env node
/** Explicit opt-in probe: additional 15 calls / 80k each / 350k total estimated input. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  buildSessionContext, createAgentSession, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

export const LIMITS = Object.freeze({ calls: 15, perCall: 80_000, total: 350_000 });
const PREFLIGHT_OVERHEAD = 12_000;
const MODEL_ID = "openai/gpt-4o-mini";
const OCCUPANCY_THRESHOLD = 53_760; // 60% of the default 0.7 * 128k preferred input target

export function reserve(budget, tokens) {
  if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > LIMITS.perCall
    || budget.calls >= LIMITS.calls || budget.tokens + tokens > LIMITS.total) {
    throw new Error("Authorized probe budget exhausted before provider transport");
  }
  budget.calls++;
  budget.tokens += tokens;
}

export function readyForHigh(rows) {
  const last = rows.at(-1);
  return last?.status === "ok" && last.autoTune === "expanded" && last.accepted >= 8;
}

function filler(turn) {
  return Array.from({ length: 155 }, (_, i) => `record-${turn}-${i.toString(36).padStart(3, "0")}-status-ok`).join(" ");
}
function highInput(parts) {
  return `Synthetic occupancy probe. Reply only OK.\n${Array.from({ length: parts }, (_, i) => filler(i)).join("\n")}`;
}

export async function main(argv) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--live")) {
    throw new Error("Only --live is supported");
  }
  if (argv.length === 0) return { mode: "dry-run", limits: LIMITS,
    model: `openrouter/${MODEL_ID}`, occupancyThreshold: OCCUPANCY_THRESHOLD };
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  const model = modelRuntime.getModel("openrouter", MODEL_ID);
  if (!model || !modelRuntime.hasConfiguredAuth("openrouter")) return { mode: "unavailable", limits: LIMITS };
  if (model.contextWindow !== 128_000) throw new Error("Model window differs from 128k probe plan");
  const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createJiti } = requireFromPi("jiti");
  const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
  const { registerDs4ContextEngine } = await jiti.import("../src/extension/index.ts");
  const { O200K_ESTIMATOR } = await jiti.import("../src/pi-adapter/bpe-token-estimator.ts");
  const root = mkdtempSync(join(tmpdir(), "ds4-high-usage-probe-"));
  const budget = { calls: 0, tokens: 0 };
  const rows = [];
  let session;
  try {
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    mkdirSync(cwd);
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      project: { enabled: false }, memory: { enabled: false }, artifacts: { enabled: false },
      compaction: { enabled: false },
      modelAwareness: { autoTune: true,
        overrides: { [`openrouter/${MODEL_ID}`]: { tokenEstimator: "o200k-base-v1" } } },
    }));
    const manager = SessionManager.create(cwd, join(root, "sessions"));
    // Stable synthetic prefix keeps wrapper overhead small relative to the
    // measured body, so eight real usage ratios can be accepted reliably.
    manager.appendMessage({ role: "user", content: [filler(200), filler(201), filler(202)].join("\n"),
      timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "OK" }],
      api: model.api, provider: model.provider, model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now() });
    let ds4;
    const loader = new DefaultResourceLoader({ cwd, agentDir,
      systemPrompt: "Synthetic safety measurement. Reply only OK. Do not quote input.",
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => { ds4 = registerDs4ContextEngine(pi, { agentDir, homeDir: root, logSink: () => {} }); }],
    });
    await loader.reload();
    const created = await createAgentSession({
      cwd, agentDir, model: { ...model, maxTokens: 64 }, modelRuntime,
      resourceLoader: loader, sessionManager: manager,
      settingsManager: SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } }),
      thinkingLevel: "off", noTools: "all",
    });
    session = created.session;
    await session.bindExtensions({ mode: "print" });

    async function ask(prompt, stage, expected) {
      const canonical = buildSessionContext(manager.getEntries(), manager.getLeafId()).messages;
      const preflight = O200K_ESTIMATOR.estimateMessagesTokens([
        ...canonical, { role: "user", content: prompt, timestamp: Date.now() },
      ]) + PREFLIGHT_OVERHEAD;
      reserve(budget, preflight);
      try {
        await session.prompt(prompt);
      } catch {
        rows.push({ stage, status: "request-error", preflight });
        return false;
      }
      const manifest = ds4?.latestManifest();
      if (!manifest || manifest.planning?.mode !== "managed"
        || manifest.modelAwareness?.calibration.estimator !== "o200k-base-v1"
        || !manifest.providerUsage || manifest.providerUsage.totalInputTokens <= 0) {
        rows.push({ stage, status: "invalid-manifest-or-usage", preflight });
        return false;
      }
      const row = { stage, status: "ok", preflight,
        estimated: manifest.estimatedInputTokens, actual: manifest.providerUsage.totalInputTokens,
        accepted: manifest.modelAwareness.calibration.acceptedSamples,
        autoTune: manifest.modelAwareness.autoTune?.status ?? "disabled",
        recentTailTokens: manifest.modelAwareness.adaptive.recentTailTokens,
        hardInputLimit: manifest.hardInputLimit,
      };
      if (expected && !expected(row)) row.status = "scenario-failed";
      rows.push(row);
      return row.status === "ok";
    }

    for (let turn = 0; turn < 12; turn++) {
      const valid = await ask(`Calibration turn ${turn}. Reply only OK.`, `short-${turn + 1}`,
        (row) => row.autoTune === "insufficient-samples" || row.autoTune === "expanded");
      if (!valid || rows.at(-1)?.autoTune === "expanded") break;
    }
    // Never send the expensive high-occupancy turn based on observed count:
    // calibration may reject ratio outliers. Require eight accepted samples.
    if (readyForHigh(rows)) {
      // A single current user turn >53,760 provider tokens, while the FULL Pi
      // canonical branch and 12k overhead still fit the 80k preflight cap.
      if (await ask(highInput(50), "high-provider-usage", (row) =>
        row.accepted >= 8 && row.autoTune === "expanded" && row.actual > OCCUPANCY_THRESHOLD)) {
        await ask("After high occupancy, reply only OK.", "withdrawal", (row) =>
          row.autoTune === "no-headroom" && row.actual > 0);
      }
    }
    return { mode: "live", model: `openrouter/${MODEL_ID}`, limits: LIMITS,
      callsAttempted: budget.calls, estimatedInputReserved: budget.tokens,
      complete: rows.some((row) => row.stage === "withdrawal" && row.status === "ok"), rows,
      note: "Only synthetic temporary Pi JSONL; usage is Pi-normalized provider input, not billing. No prompt/response or credentials logged.",
    };
  } finally {
    session?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`),
    () => { process.stderr.write("Probe failed; account for attempted calls before retrying.\n"); process.exitCode = 1; },
  );
}
