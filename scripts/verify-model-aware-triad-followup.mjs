#!/usr/bin/env node
/** Remaining authorized calls after the first triad run: three retrieval + tool-cycle checks. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildSessionContext, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { assertHistoricalAuthorizationAvailable, buildHighInput, LIMITS,
  MIN_SELECTED_USER_TOKENS, MODELS, reserve, seed, selectedCurrentUserTokens } from "./verify-model-aware-triad.mjs";

// Observed, reserved input and controlled characters in the one prior triad invocation.
export const PREVIOUS = Object.freeze({ calls: 30, input: 1_433_445, chars: 3_679_430 });
export const PREVIOUS_LARGE = Object.freeze({ calls: 39, input: 2_115_378, chars: 5_632_585 });
const TOOL_NAME = "synthetic_lookup";
const OVERHEAD = 12_000;

export async function main(argv) {
  if (argv.length > 1 || (argv.length === 1 && !["--live", "--plan-large", "--live-large-only"].includes(argv[0]))) {
    throw new Error("Only --live, --plan-large or --live-large-only is supported");
  }
  if (argv.length === 0) return { mode: "dry-run", models: MODELS, limits: LIMITS, previous: PREVIOUS,
    maximumAdditionalCalls: 9, scenario: "retrieval and real two-request synthetic tool cycle; no auto-tune withdrawal" };
  if (argv[0] === "--plan-large") return { mode: "dry-run-large", models: MODELS, limits: LIMITS,
    previous: PREVIOUS_LARGE, maximumAdditionalCalls: 3, scenario: "one native-window high-input request per model; no auto-tune withdrawal" };
  // Both historical follow-up rounds consumed the joint 42-call authorization.
  // A future run requires a new explicit budget and new cumulative accounting.
  assertHistoricalAuthorizationAvailable();
  const largeOnly = argv[0] === "--live-large-only";
  const budget = { ...(largeOnly ? PREVIOUS_LARGE : PREVIOUS) };
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
    if (activeStage === "native-window-large"
      && selectedCurrentUserTokens(context.messages, O200K_ESTIMATOR) < MIN_SELECTED_USER_TOKENS) {
      throw new Error("Selected large-input request below required preflight threshold");
    }
    reserve(budget, preflight, chars);
    requestRows?.push({ preflight, chars,
      schemaPresent: (context.tools ?? []).some((tool) => tool.name === TOOL_NAME),
      actualToolResult: (context.messages ?? []).some((message) => message.role === "toolResult" && message.toolName === TOOL_NAME),
    });
    return originalStream(activeModel, context, options);
  };
  let stopAll = false;
  for (const model of models) {
    if (!model) break;
    activeId = model.id;
    const root = mkdtempSync(join(tmpdir(), "ds4-triad-followup-"));
    const rows = [];
    const requests = [];
    requestRows = requests;
    let session;
    let unsubscribe;
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
      const { decisionId, toolEntryId } = seed(manager, model, 70); // 70 long turns exceed default 64k tail
      let ds4;
      let executed = 0;
      const loader = new DefaultResourceLoader({ cwd, agentDir,
        systemPrompt: "Synthetic context check. Reply only OK. Call synthetic_lookup only when explicitly requested.",
        noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [
          (pi) => { ds4 = registerDs4ContextEngine(pi, { agentDir, homeDir: root, logSink: () => {} }); },
          (pi) => pi.registerTool({ name: TOOL_NAME, label: "Synthetic Lookup",
            description: "Return a synthetic build status for the requested key.",
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
          usageRows.push({ actual: (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0) });
        }
      });
      async function ask(prompt, stage, expectedRequests) {
        const start = requests.length;
        activeStage = stage;
        try { await session.prompt(prompt); } catch {
          rows.push({ stage, status: "request-error", requests: requests.length - start });
          stopAll = true; return null;
        } finally {
          activeStage = undefined;
        }
        const manifest = ds4?.latestManifest();
        if (!manifest || manifest.provider !== "openrouter" || manifest.model !== model.id
          || manifest.modelAwareness?.contextWindow !== 1_050_000
          || manifest.planning?.mode !== "managed" || manifest.planning.originalMessageCount < 140
          || manifest.modelAwareness?.calibration.estimator !== "o200k-base-v1"
          || !manifest.providerUsage || manifest.providerUsage.totalInputTokens <= 0) {
          rows.push({ stage, status: "invalid-manifest-or-usage", requests: requests.length - start });
          stopAll = true; return null;
        }
        const row = { stage, status: requests.length - start === expectedRequests ? "ok" : "scenario-failed",
          requests: requests.length - start, estimated: manifest.estimatedInputTokens,
          actual: manifest.providerUsage.totalInputTokens, originalMessages: manifest.planning.originalMessageCount,
          retrieved: ds4.retrievalDiagnostics().selected.some((item) => item.entryId === decisionId),
          decisionIncluded: manifest.included.some((item) => item.sourceId === decisionId),
          historicalCall: manifest.included.some((item) => item.sourceId === toolEntryId),
          historicalResult: manifest.included.some((item) => item.role === "toolResult"),
          currentIncluded: manifest.included.some((item) => item.kind === "current"),
        };
        rows.push(row);
        return row;
      }
      if (largeOnly) {
        const block = Array.from({ length: 155 }, (_, i) => `record-700-${i.toString(36).padStart(3, "0")}-status-ok`).join(" ") + "\n";
        const prefix = "Synthetic native-window input measurement. Reply only OK.\n";
        const prompt = buildHighInput(O200K_ESTIMATOR, prefix, block);
        const rawPreflight = O200K_ESTIMATOR.estimateMessagesTokens([
          ...buildSessionContext(manager.getEntries(), manager.getLeafId()).messages,
          { role: "user", content: prompt, timestamp: Date.now() },
        ]) + OVERHEAD;
        if (rawPreflight > LIMITS.inputPerCall) {
          rows.push({ stage: "native-window-large", status: "preflight-too-large" });
        } else {
          const high = await ask(prompt, "native-window-large", 1);
          if (high && !(high.status === "ok" && high.actual > 441_000 && high.currentIncluded)) {
            high.status = "scenario-failed";
          }
        }
      } else {
      const history = await ask("Why does cobalt-713 expire in 42 days? Reply only OK.", "retrieval", 1);
      if (history?.status === "ok" && history.retrieved && history.decisionIncluded
        && history.historicalCall && history.historicalResult) {
        session.setActiveToolsByName([TOOL_NAME]);
        if (!session.getActiveToolNames().includes(TOOL_NAME)) {
          rows.push({ stage: "live-tool", status: "tool-unavailable" });
        } else {
          const start = requests.length;
          const usageStart = usageRows.length;
          const tool = await ask("Call synthetic_lookup exactly once with key cobalt-713, then reply only OK.", "live-tool", 2);
          const toolRequests = requests.slice(start);
          const usages = usageRows.slice(usageStart);
          if (tool) {
            tool.toolExecutions = executed;
            tool.schemaOnFirst = toolRequests[0]?.schemaPresent ?? false;
            tool.resultOnSecond = toolRequests[1]?.actualToolResult ?? false;
            if (!(executed === 1 && toolRequests.length === 2 && tool.schemaOnFirst && tool.resultOnSecond
              && usages.length === 2 && usages.every((entry) => entry.actual > 0))) tool.status = "scenario-failed";
          }
        }
      } else if (history?.status === "ok") {
        history.status = "scenario-failed";
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
    results.push({ model: `openrouter/${model.id}`, attempts: requests.length, rows,
      complete: (largeOnly ? ["native-window-large"] : ["retrieval", "live-tool"])
        .every((stage) => rows.some((row) => row.stage === stage && row.status === "ok")) });
    if (stopAll) break;
  }
  return { mode: largeOnly ? "live-large-only" : "live-followup", limits: LIMITS,
    previous: largeOnly ? PREVIOUS_LARGE : PREVIOUS, budget, results,
    complete: results.length === MODELS.length && results.every((result) => result.complete),
    note: "No compaction or auto-tune withdrawal in this round. Only synthetic temporary Pi data; per-request transport gate, aggregate metadata only; no raw upstream errors." };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`),
    () => { process.stderr.write("Follow-up probe initialization failed; no automatic retry.\n"); process.exitCode = 1; },
  );
}
