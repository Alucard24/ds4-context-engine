#!/usr/bin/env node
/** One authorized, bounded OpenRouter/Pi+DS4 run for the three native 1.05M profiles. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  buildSessionContext, createAgentSession, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

export const MODELS = Object.freeze(["openai/gpt-6-sol", "openai/gpt-6-luna", "openai/gpt-5.6-terra"]);
export const LIMITS = Object.freeze({ calls: 42, inputPerCall: 600_000, inputTotal: 4_800_000,
  charsPerCall: 2_500_000, charsTotal: 15_000_000 });
export const OCCUPANCY_THRESHOLD = 441_000; // 0.6 * 0.7 * 1,050,000 (nominal provider units)
export const MIN_SELECTED_USER_TOKENS = 470_000; // headroom for estimator/provider drift
export const RECORDED_CONSUMPTION = Object.freeze({ calls: 42, input: 3_296_138, chars: 9_357_266 });
export function assertHistoricalAuthorizationAvailable() {
  if (RECORDED_CONSUMPTION.calls >= LIMITS.calls) {
    throw new Error("Previous 42-call authorization exhausted; no live calls permitted");
  }
}
const TOOL_NAME = "synthetic_lookup";
const OVERHEAD = 12_000;
const SYSTEM_PROMPT = "Synthetic Pi context probe. Reply only OK unless asked to call synthetic_lookup. Never quote context.";

export function buildHighInput(estimator, prefix, block, minimum = MIN_SELECTED_USER_TOKENS) {
  const blockTokens = estimator.estimateTextTokens(block);
  if (!Number.isSafeInteger(blockTokens) || blockTokens < 1 || !Number.isSafeInteger(minimum) || minimum < 1) {
    throw new Error("Invalid synthetic high-input sizing");
  }
  let parts = Math.max(1, Math.ceil((minimum - estimator.estimateTextTokens(prefix)) / blockTokens));
  while (parts <= 2_000) {
    const prompt = prefix + block.repeat(parts);
    if (estimator.estimateTextTokens(prompt) >= minimum) return prompt;
    parts++;
  }
  throw new Error("Synthetic high-input sizing exceeded preflight bound");
}

export function selectedCurrentUserTokens(messages, estimator) {
  const last = messages?.at(-1);
  if (last?.role !== "user") return 0;
  const content = typeof last.content === "string" ? last.content
    : Array.isArray(last.content) ? last.content.filter((part) => part.type === "text")
      .map((part) => part.text).join("\n") : "";
  return estimator.estimateTextTokens(content);
}

export function reserve(budget, estimatedInput, controlledChars) {
  if (!Number.isSafeInteger(estimatedInput) || estimatedInput < 1 || estimatedInput > LIMITS.inputPerCall
    || !Number.isSafeInteger(controlledChars) || controlledChars < 0 || controlledChars > LIMITS.charsPerCall
    || budget.calls >= LIMITS.calls || budget.input + estimatedInput > LIMITS.inputTotal
    || budget.chars + controlledChars > LIMITS.charsTotal) {
    throw new Error("Authorized per-request or cumulative provider budget exceeded BEFORE transport");
  }
  budget.calls++;
  budget.input += estimatedInput;
  budget.chars += controlledChars;
}

function assistant(model, content, stopReason = "stop") {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now() };
}
function filler(turn) {
  return Array.from({ length: 155 }, (_, i) => `record-${turn}-${i.toString(36).padStart(3, "0")}-status-ok`).join(" ");
}
export function seed(manager, model, turns = 28) {
  const decisionId = manager.appendMessage({ role: "user", content: "DECISION cobalt-713 expires in 42 days.", timestamp: Date.now() });
  manager.appendMessage(assistant(model, [{ type: "text", text: "Acknowledged." }]));
  for (let turn = 0; turn < turns; turn++) {
    manager.appendMessage({ role: "user", content: `Synthetic turn ${turn}: ${filler(turn)}`, timestamp: Date.now() });
    manager.appendMessage(assistant(model, [{ type: "text", text: `OK ${turn}` }]));
  }
  manager.appendMessage({ role: "user", content: "Run synthetic build check.", timestamp: Date.now() });
  const toolEntryId = manager.appendMessage(assistant(model, [{ type: "toolCall", id: "historical-call",
    name: "synthetic_build_check", arguments: { target: "cobalt-713" } }], "toolUse"));
  manager.appendMessage({ role: "toolResult", toolCallId: "historical-call", toolName: "synthetic_build_check",
    content: [{ type: "text", text: `SYNTH_BUILD_OK ${filler(200)}` }], isError: false, timestamp: Date.now() });
  manager.appendMessage(assistant(model, [{ type: "text", text: "OK" }]));
  return { decisionId, toolEntryId };
}

export async function main(argv) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--live")) throw new Error("Only --live is supported");
  if (argv.length === 0) return { mode: "dry-run", models: MODELS, limits: LIMITS,
    nativeWindow: 1_050_000, occupancyThreshold: OCCUPANCY_THRESHOLD,
    stagesPerModel: "8-9 calibration, long, two-request live tool cycle, high occupancy, withdrawal" };
  // The original joint 42-call authorization is exhausted. Keep the probe
  // reproducible but block transport until an explicit new budget is obtained
  // and encoded in a separate authorized run; never reset this counter.
  assertHistoricalAuthorizationAvailable();
  const budget = { calls: 0, input: 0, chars: 0 };
  const results = [];
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  const models = MODELS.map((id) => modelRuntime.getModel("openrouter", id));
  if (models.some((model) => !model || model.contextWindow !== 1_050_000)
    || !modelRuntime.hasConfiguredAuth("openrouter")) {
    return { mode: "unavailable", reason: "model-metadata-or-auth-missing", limits: LIMITS, budget };
  }
  const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createJiti } = requireFromPi("jiti");
  const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
  const { registerDs4ContextEngine } = await jiti.import("../src/extension/index.ts");
  const { O200K_ESTIMATOR } = await jiti.import("../src/pi-adapter/bpe-token-estimator.ts");
  const originalStream = modelRuntime.streamSimple.bind(modelRuntime);
  let activeId;
  let activeStage;
  let requestRows;
  // Pi may issue a second request after a tool call. Gate EVERY request at the
  // runtime's provider boundary, not only the outer session.prompt() call.
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
    // DS4 may omit raw history. Check the *selected* current user text at the
    // transport boundary; otherwise a large raw estimate can waste a live call.
    if (activeStage === "high-provider-usage"
      && selectedCurrentUserTokens(context.messages, O200K_ESTIMATOR) < MIN_SELECTED_USER_TOKENS) {
      throw new Error("Selected high-input request below required preflight threshold");
    }
    reserve(budget, preflight, chars);
    requestRows?.push({ preflight, chars, schemaPresent: (context.tools ?? []).some((t) => t.name === TOOL_NAME),
      actualToolResult: (context.messages ?? []).some((m) => m.role === "toolResult" && m.toolName === TOOL_NAME) });
    return originalStream(activeModel, context, options);
  };
  for (const model of models) {
    if (!model) break;
    activeId = model.id;
    const root = mkdtempSync(join(tmpdir(), "ds4-triad-"));
    let session;
    let unsubscribe;
    const rows = [];
    const requests = [];
    requestRows = requests;
    let stopAll = false;
    try {
      const cwd = join(root, "project");
      const agentDir = join(root, "agent");
      mkdirSync(cwd);
      mkdirSync(agentDir);
      writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
        project: { enabled: false }, memory: { enabled: false }, artifacts: { enabled: false },
        compaction: { enabled: false },
        modelAwareness: { autoTune: true,
          overrides: { [`openrouter/${model.id}`]: { tokenEstimator: "o200k-base-v1" } } },
      }));
      const manager = SessionManager.create(cwd, join(root, "sessions"));
      const { decisionId, toolEntryId } = seed(manager, model); // before runner construction
      let ds4;
      let executed = 0;
      const loader = new DefaultResourceLoader({ cwd, agentDir, systemPrompt: SYSTEM_PROMPT,
        noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [
          (pi) => { ds4 = registerDs4ContextEngine(pi, { agentDir, homeDir: root, logSink: () => {} }); },
          (pi) => pi.registerTool({ name: TOOL_NAME, label: "Synthetic Lookup",
            description: "Return a fixed synthetic build result for the requested key.",
            parameters: Type.Object({ key: Type.String() }),
            async execute() { executed++; return { content: [{ type: "text", text: "SYNTH_BUILD_OK cobalt-713" }], details: { synthetic: true } }; },
          }),
        ],
      });
      await loader.reload();
      const created = await createAgentSession({ cwd, agentDir, model: { ...model, maxTokens: 64 },
        modelRuntime, resourceLoader: loader, sessionManager: manager,
        settingsManager: SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } }),
        thinkingLevel: "off", noTools: "builtin", tools: [TOOL_NAME],
      });
      session = created.session;
      await session.bindExtensions({ mode: "print" });
      session.setActiveToolsByName([]);
      const usageRows = [];
      unsubscribe = session.subscribe((event) => {
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const usage = event.message.usage;
          usageRows.push({ actual: (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0),
            stopReason: event.message.stopReason });
        }
      });
      const question = "Why is cobalt-713 expiry 42 days? What did SYNTH_BUILD_OK report? Reply only OK.";
      async function ask(prompt, stage, expected) {
        const canonical = buildSessionContext(manager.getEntries(), manager.getLeafId()).messages;
        if (canonical.length < 60) throw new Error("Canonical long branch missing");
        const callStart = requests.length;
        activeStage = stage;
        try { await session.prompt(prompt); } catch {
          rows.push({ stage, status: "request-error", attempted: requests.length - callStart });
          stopAll = true; return false;
        } finally {
          activeStage = undefined;
        }
        const manifest = ds4?.latestManifest();
        if (!manifest || manifest.provider !== "openrouter" || manifest.model !== model.id
          || manifest.modelAwareness?.contextWindow !== 1_050_000
          || manifest.planning?.mode !== "managed" || manifest.planning.originalMessageCount < 60
          || manifest.modelAwareness?.calibration.estimator !== "o200k-base-v1"
          || !manifest.providerUsage || manifest.providerUsage.totalInputTokens <= 0) {
          rows.push({ stage, status: "invalid-manifest-or-usage", attempted: requests.length - callStart });
          stopAll = true; return false;
        }
        const row = { stage, status: "ok", requests: requests.length - callStart,
          estimated: manifest.estimatedInputTokens, actual: manifest.providerUsage.totalInputTokens,
          accepted: manifest.modelAwareness.calibration.acceptedSamples,
          autoTune: manifest.modelAwareness.autoTune?.status ?? "disabled",
          appliedRatio: manifest.modelAwareness.calibration.appliedRatio,
          recentTailTokens: manifest.modelAwareness.adaptive.recentTailTokens,
          originalMessages: manifest.planning.originalMessageCount,
          retrieved: ds4.retrievalDiagnostics().selected.some((item) => item.entryId === decisionId),
          historicalCall: manifest.included.some((item) => item.sourceId === toolEntryId),
          historicalResult: manifest.included.some((item) => item.role === "toolResult"),
        };
        if (expected && !expected(row)) row.status = "scenario-failed";
        rows.push(row);
        return row.status === "ok";
      }
      for (let turn = 0; turn < 9; turn++) {
        if (!await ask(`${question} Calibration turn ${turn}.`, `calibration-${turn + 1}`,
          (row) => row.requests === 1 && ["insufficient-samples", "expanded"].includes(row.autoTune))) break;
        // A manifest for the just-finished turn only sees usage from preceding turns.
        if (rows.at(-1)?.accepted >= 8) break;
      }
      if (!stopAll && rows.at(-1)?.status === "ok" && rows.at(-1)?.accepted >= 8) {
        if (await ask(question, "calibrated-long", (row) => row.requests === 1 && row.autoTune === "expanded"
          && row.accepted >= 8 && row.retrieved && row.historicalCall && row.historicalResult)) {
          // Execute tools BEFORE the high-usage turn, so the two tool-cycle
          // requests do not both resend the giant prior user message.
          session.setActiveToolsByName([TOOL_NAME]);
          let toolVerified = false;
          if (!session.getActiveToolNames().includes(TOOL_NAME)) {
            rows.push({ stage: "live-tool", status: "tool-unavailable" });
          } else {
            const callStart = requests.length;
            const usageStart = usageRows.length;
            const worked = await ask("Call synthetic_lookup exactly once with key cobalt-713, then answer only OK.",
              "live-tool", (row) => row.requests === 2);
            const toolCalls = requests.slice(callStart);
            const observedUsage = usageRows.slice(usageStart);
            const row = rows.at(-1);
            toolVerified = worked && executed === 1 && toolCalls.length === 2 && toolCalls[0]?.schemaPresent
              && toolCalls[1]?.actualToolResult && observedUsage.length === 2
              && observedUsage.every((entry) => entry.actual > 0);
            if (worked && !toolVerified && row) row.status = "scenario-failed";
            if (row) { row.toolExecutions = executed; row.toolRequests = toolCalls.length;
              row.toolSchemaOnFirst = toolCalls[0]?.schemaPresent ?? false;
              row.actualResultOnSecond = toolCalls[1]?.actualToolResult ?? false; }
          }
          session.setActiveToolsByName([]);
          if (toolVerified) {
            // Size the current turn itself, never the raw history DS4 can omit.
            const high = buildHighInput(O200K_ESTIMATOR,
              "Synthetic high-occupancy test. Reply only OK.\n", filler(700) + "\n");
            const rawPreflight = O200K_ESTIMATOR.estimateMessagesTokens([
              ...buildSessionContext(manager.getEntries(), manager.getLeafId()).messages,
              { role: "user", content: high, timestamp: Date.now() },
            ]) + OVERHEAD;
            // Conservative upper bound; the runtime gate still checks selected
            // text, per-request and cumulative token/character limits.
            if (rawPreflight > LIMITS.inputPerCall) {
              rows.push({ stage: "high-provider-usage", status: "preflight-too-large" });
            } else if (await ask(high, "high-provider-usage", (row) =>
              row.requests === 1 && row.autoTune === "expanded" && row.actual > OCCUPANCY_THRESHOLD)) {
              await ask("After high occupancy, reply only OK.", "withdrawal", (row) =>
                row.requests === 1 && row.autoTune === "no-headroom");
            }
          }
        }
      }
    } catch {
      rows.push({ stage: "setup-or-preflight", status: "error-no-raw-details" });
      stopAll = true;
    } finally {
      unsubscribe?.();
      session?.dispose();
      rmSync(root, { recursive: true, force: true });
    }
    results.push({ model: `openrouter/${model.id}`, rows, complete: ["calibrated-long", "high-provider-usage", "withdrawal", "live-tool"]
      .every((stage) => rows.some((row) => row.stage === stage && row.status === "ok")),
      attempts: requests.length });
    if (stopAll) break;
  }
  return { mode: "live", limits: LIMITS, budget, results,
    complete: results.length === MODELS.length && results.every((item) => item.complete),
    note: "Synthetic temporary Pi sessions only. Per-request transport gate; aggregate metadata, no prompt/response or raw upstream errors. Usage is Pi-normalized, not billed." };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`),
    () => { process.stderr.write("Probe initialization failed. No automatic retry; account for any attempted calls.\n"); process.exitCode = 1; },
  );
}
