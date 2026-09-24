#!/usr/bin/env node
/** Pending a NEW explicit numeric authorization: real DS4/Pi withdrawal, once per native model. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { buildSessionContext, createAgentSession, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { buildHighInput, MIN_SELECTED_USER_TOKENS, MODELS, OCCUPANCY_THRESHOLD,
  seed, selectedCurrentUserTokens } from "./verify-model-aware-triad.mjs";

// The authorized round has run: 34 attempted requests reserved 3,375,536
// estimated tokens and 9,845,274 controlled characters. It is now locked.
// A later Terra-only round needs a NEW explicit numeric authorization.
export const LIMITS = Object.freeze({ calls: 39, inputPerCall: 600_000, inputTotal: 3_800_000,
  charsPerCall: 2_500_000, charsTotal: 11_000_000 });
export const CAPS = Object.freeze({ recentTailTokens: 80_000,
  maxRetrievedHistoryTokens: 40_000, maxProjectTokens: 40_000 });
export const LIVE_AUTHORIZED = false;
const OVERHEAD = 12_000;
const SYSTEM_PROMPT = "Synthetic DS4/Pi context validation. Reply only OK.";
const QUESTION = "Why does cobalt-713 expire in 42 days? Reply only OK.";

export function requireLiveAuthorization() {
  if (!LIVE_AUTHORIZED) throw new Error("New explicit numeric provider budget required; no transport permitted");
}

export function reserve(budget, estimatedInput, controlledChars, limits = LIMITS) {
  if (!Number.isSafeInteger(estimatedInput) || estimatedInput < 1
    || !Number.isSafeInteger(controlledChars) || controlledChars < 1
    || estimatedInput > limits.inputPerCall || controlledChars > limits.charsPerCall
    || budget.calls + 1 > limits.calls || budget.input + estimatedInput > limits.inputTotal
    || budget.chars + controlledChars > limits.charsTotal) {
    throw new Error("Authorized request/cumulative cap exceeded BEFORE provider transport");
  }
  budget.calls++;
  budget.input += estimatedInput;
  budget.chars += controlledChars;
}

export function untunedTail(limits, ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return undefined;
  return Math.min(CAPS.recentTailTokens,
    Math.floor(limits.nominalRecentTailTokens / Math.max(0.000001, ratio)));
}

export async function main(argv = []) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--live")) throw new Error("Only --live is supported");
  if (argv.length === 0) return { mode: "dry-run", models: MODELS, limits: LIMITS, caps: CAPS,
    stages: "8+ accepted calibration samples, real category expansion, selected 470k input, withdrawal" };
  requireLiveAuthorization();
  return runAuthorizedModels(MODELS, LIMITS, requireLiveAuthorization);
}

// Only call after a separate explicit authorization. The historic main()
// remains locked; an additional run uses an independent cumulative budget.
export async function runAuthorizedModels(modelIds, limits, authorize = requireLiveAuthorization) {
  authorize();
  if (!Array.isArray(modelIds) || !modelIds.length || modelIds.some((id) => !MODELS.includes(id))) {
    throw new Error("Unexpected model: transport blocked");
  }
  const budget = { calls: 0, input: 0, chars: 0 };
  const results = [];
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  const models = modelIds.map((id) => modelRuntime.getModel("openrouter", id));
  if (models.some((model) => !model || model.contextWindow !== 1_050_000)
    || !modelRuntime.hasConfiguredAuth("openrouter")) {
    return { mode: "unavailable", reason: "model-metadata-or-auth-missing", budget };
  }
  const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createJiti } = requireFromPi("jiti");
  const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
  const { registerDs4ContextEngine } = await jiti.import("../src/extension/index.ts");
  const { O200K_ESTIMATOR } = await jiti.import("../src/pi-adapter/bpe-token-estimator.ts");
  const originalStream = modelRuntime.streamSimple.bind(modelRuntime);
  let activeId;
  let activeStage;
  let requestCount = 0;
  // Gate at the provider boundary: if Pi retries or issues another request,
  // that request is also counted. No provider prompt, response or raw error logged.
  modelRuntime.streamSimple = (activeModel, context, options) => {
    if (activeModel.provider !== "openrouter" || activeModel.id !== activeId) {
      throw new Error("Unexpected provider/model: transport blocked");
    }
    const toolsJson = JSON.stringify(context.tools ?? []);
    const messagesJson = JSON.stringify(context.messages ?? []);
    const chars = messagesJson.length + (context.systemPrompt ?? "").length + toolsJson.length;
    const preflight = O200K_ESTIMATOR.estimateMessagesTokens(context.messages ?? [])
      + O200K_ESTIMATOR.estimateTextTokens(context.systemPrompt ?? "")
      + Math.ceil(toolsJson.length / 4) + OVERHEAD;
    if (activeStage === "high-provider-usage"
      && selectedCurrentUserTokens(context.messages, O200K_ESTIMATOR) < MIN_SELECTED_USER_TOKENS) {
      throw new Error("Selected high-input request below required preflight threshold");
    }
    reserve(budget, preflight, chars, limits);
    requestCount++;
    return originalStream(activeModel, context, options);
  };
  let stop = false;
  for (const model of models) {
    if (!model || stop) break;
    activeId = model.id;
    const root = mkdtempSync(join(tmpdir(), "ds4-withdrawal-"));
    let session;
    let unsubscribe;
    const rows = [];
    try {
      const cwd = join(root, "project");
      const agentDir = join(root, "agent");
      mkdirSync(cwd);
      mkdirSync(agentDir);
      writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
        project: { enabled: false }, memory: { enabled: false }, artifacts: { enabled: false },
        compaction: { enabled: false },
        context: CAPS, // Only opt-in ceilings raised; model context/output/hard limits unchanged.
        modelAwareness: { autoTune: true,
          overrides: { [`openrouter/${model.id}`]: { tokenEstimator: "o200k-base-v1" } } },
      }));
      const manager = SessionManager.create(cwd, join(root, "sessions"));
      const { decisionId, toolEntryId } = seed(manager, model); // seed BEFORE runner construction
      let ds4;
      const loader = new DefaultResourceLoader({ cwd, agentDir, systemPrompt: SYSTEM_PROMPT,
        noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [(pi) => { ds4 = registerDs4ContextEngine(pi,
          { agentDir, homeDir: root, logSink: () => {} }); }],
      });
      await loader.reload();
      const created = await createAgentSession({ cwd, agentDir, model: { ...model, maxTokens: 64 },
        modelRuntime, resourceLoader: loader, sessionManager: manager,
        settingsManager: SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } }),
        thinkingLevel: "off", noTools: "all",
      });
      session = created.session;
      await session.bindExtensions({ mode: "print" });
      const usages = [];
      unsubscribe = session.subscribe((event) => {
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const usage = event.message.usage;
          usages.push({ actual: (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0),
            stopReason: event.message.stopReason });
        }
      });
      async function ask(prompt, stage, expected) {
        const canonical = buildSessionContext(manager.getEntries(), manager.getLeafId()).messages;
        if (canonical.length < 60) throw new Error("Canonical long branch missing");
        const callsBefore = requestCount;
        const usagesBefore = usages.length;
        activeStage = stage;
        try { await session.prompt(prompt); } catch {
          rows.push({ stage, status: "request-error", requests: requestCount - callsBefore });
          stop = true; return false;
        } finally { activeStage = undefined; }
        const manifest = ds4?.latestManifest();
        if (!manifest || manifest.provider !== "openrouter" || manifest.model !== model.id
          || manifest.modelAwareness?.contextWindow !== 1_050_000
          || manifest.planning?.mode !== "managed" || manifest.planning.originalMessageCount < 60
          || manifest.modelAwareness?.calibration.estimator !== "o200k-base-v1"
          || !manifest.providerUsage || manifest.providerUsage.totalInputTokens <= 0
          || usages.length !== usagesBefore + 1 || usages.at(-1)?.actual <= 0) {
          rows.push({ stage, status: "invalid-manifest-or-usage", requests: requestCount - callsBefore });
          stop = true; return false;
        }
        const limits = manifest.modelAwareness.adaptive;
        const row = { stage, status: "ok", requests: requestCount - callsBefore,
          actual: manifest.providerUsage.totalInputTokens, estimated: manifest.estimatedInputTokens,
          accepted: manifest.modelAwareness.calibration.acceptedSamples,
          autoTune: manifest.modelAwareness.autoTune?.status ?? "disabled",
          appliedRatio: manifest.modelAwareness.calibration.appliedRatio,
          nominalTail: limits.nominalRecentTailTokens, tail: limits.recentTailTokens,
          untunedTail: untunedTail(limits, manifest.modelAwareness.calibration.appliedRatio),
          currentIncluded: manifest.included.some((item) => item.kind === "current"),
          decisionIncluded: manifest.included.some((item) => item.sourceId === decisionId),
          historicalCall: manifest.included.some((item) => item.sourceId === toolEntryId),
          historicalResult: manifest.included.some((item) => item.role === "toolResult"),
        };
        if (requestCount - callsBefore !== 1 || (expected && !expected(row))) row.status = "scenario-failed";
        rows.push(row);
        if (row.status !== "ok") stop = true;
        return row.status === "ok";
      }
      for (let turn = 0; turn < 10 && !stop; turn++) {
        if (!await ask(`${QUESTION} Calibration turn ${turn}.`, `calibration-${turn + 1}`,
          (row) => ["insufficient-samples", "expanded"].includes(row.autoTune))) break;
        if (rows.at(-1)?.accepted >= 8) break;
      }
      if (!stop && rows.at(-1)?.accepted >= 8
        && await ask(QUESTION, "expanded", (row) => row.accepted >= 8 && row.autoTune === "expanded"
          && row.tail > row.untunedTail && row.currentIncluded && row.historicalCall && row.historicalResult)) {
        const block = Array.from({ length: 155 }, (_, i) =>
          `record-700-${i.toString(36).padStart(3, "0")}-status-ok`).join(" ") + "\n";
        const prompt = buildHighInput(O200K_ESTIMATOR, "Synthetic high occupancy. Reply only OK.\n", block);
        const raw = [...buildSessionContext(manager.getEntries(), manager.getLeafId()).messages,
          { role: "user", content: prompt, timestamp: Date.now() }];
        const rawEstimate = O200K_ESTIMATOR.estimateMessagesTokens(raw) + OVERHEAD;
        const rawChars = JSON.stringify(raw).length;
        if (rawEstimate > limits.inputPerCall || rawChars > limits.charsPerCall) {
          rows.push({ stage: "high-provider-usage", status: "preflight-too-large" });
          stop = true;
        } else if (await ask(prompt, "high-provider-usage", (row) => row.autoTune === "expanded"
          && row.tail > row.untunedTail && row.actual > OCCUPANCY_THRESHOLD && row.currentIncluded)) {
          await ask("After the high-usage call, reply only OK.", "withdrawal", (row) =>
            row.autoTune === "no-headroom" && row.tail === row.untunedTail
            && row.tail < rows.at(-1).tail && row.currentIncluded);
        }
      } else if (!stop) {
        rows.push({ stage: "expanded", status: "insufficient-accepted-samples" });
        stop = true;
      }
    } catch {
      rows.push({ stage: "setup-or-preflight", status: "error-no-raw-details" });
      stop = true;
    } finally {
      unsubscribe?.();
      session?.dispose();
      rmSync(root, { recursive: true, force: true });
    }
    results.push({ model: `openrouter/${model.id}`, rows,
      complete: ["expanded", "high-provider-usage", "withdrawal"].every((stage) =>
        rows.some((row) => row.stage === stage && row.status === "ok")) });
  }
  return { mode: "live", limits, caps: CAPS, budget, results,
    complete: results.length === modelIds.length && results.every((item) => item.complete) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`),
    () => { process.stderr.write("Probe stopped; no raw error details or automatic retry.\n"); process.exitCode = 1; },
  );
}
