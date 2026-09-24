#!/usr/bin/env node
/** Explicitly bounded, opt-in live Pi + DS4 probe. Never reads user sessions. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  buildSessionContext, createAgentSession, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

export const MAX_CALLS = 16;
export const MAX_ESTIMATED_INPUT_PER_CALL = 64_000;
export const MAX_ESTIMATED_INPUT_TOTAL = 250_000;
const PREFLIGHT_OVERHEAD = 12_000; // conservatively reserve for system prompt, wrappers and tool definitions
const MODEL_ID = "openai/gpt-4o-mini";
const SYSTEM_PROMPT = "Synthetic token measurement. Reply only OK. Do not quote any history or tool output.";

export function reserve(budget, estimatedInput) {
  if (!Number.isSafeInteger(estimatedInput) || estimatedInput <= 0
    || estimatedInput > MAX_ESTIMATED_INPUT_PER_CALL
    || budget.calls >= MAX_CALLS
    || budget.estimatedInput + estimatedInput > MAX_ESTIMATED_INPUT_TOTAL) {
    throw new Error("Probe budget exhausted; no request sent");
  }
  budget.calls++;
  budget.estimatedInput += estimatedInput;
  return budget;
}

function fakeAssistant(model, content, stopReason = "stop") {
  return {
    role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  };
}

function filler(turn) {
  return Array.from({ length: 155 }, (_, index) => `record-${turn}-${index.toString(36).padStart(3, "0")}-status-ok`).join(" ");
}

export async function main(argv) {
  const longOnly = argv[0] === "--live-long-only";
  const live = argv[0] === "--live" || longOnly;
  if (argv.length !== (longOnly ? 3 : live ? 1 : 0)
    || (argv.length > 0 && !live)) {
    throw new Error("Only --live or --live-long-only with previous budget counters is supported");
  }
  const previousCalls = longOnly ? Number(argv[1]?.replace(/^--previous-calls=/, "")) : 0;
  const previousEstimated = longOnly ? Number(argv[2]?.replace(/^--previous-estimated=/, "")) : 0;
  if (longOnly && (!argv[1]?.startsWith("--previous-calls=")
    || !argv[2]?.startsWith("--previous-estimated=")
    || !Number.isSafeInteger(previousCalls) || previousCalls < 0 || previousCalls >= MAX_CALLS
    || !Number.isSafeInteger(previousEstimated) || previousEstimated < 0
    || previousEstimated >= MAX_ESTIMATED_INPUT_TOTAL)) {
    throw new Error("Valid previous budget counters required before any provider call");
  }
  const limits = {
    calls: MAX_CALLS, estimatedInputPerCall: MAX_ESTIMATED_INPUT_PER_CALL,
    estimatedInputTotal: MAX_ESTIMATED_INPUT_TOTAL, syntheticOnly: true,
  };
  if (!live) return { mode: "dry-run", model: `openrouter/${MODEL_ID}`, limits };
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  const model = modelRuntime.getModel("openrouter", MODEL_ID);
  if (!model || !modelRuntime.hasConfiguredAuth("openrouter")) {
    return { mode: "unavailable", model: `openrouter/${MODEL_ID}`, limits };
  }
  if (model.contextWindow < 128_000) throw new Error("Requires at least a 128k model window");
  const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createJiti } = requireFromPi("jiti");
  const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
  const { registerDs4ContextEngine } = await jiti.import("../src/extension/index.ts");
  const { O200K_ESTIMATOR } = await jiti.import("../src/pi-adapter/bpe-token-estimator.ts");
  const root = mkdtempSync(join(tmpdir(), "ds4-real-session-probe-"));
  let session;
  const budget = { calls: previousCalls, estimatedInput: previousEstimated };
  const rows = [];
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
    const decisionId = manager.appendMessage({ role: "user",
      content: "DECISION cobalt-713 has an expiry of 42 days; never log credentials.", timestamp: Date.now() });
    manager.appendMessage(fakeAssistant(model, [{ type: "text", text: "Acknowledged." }]));
    let toolEntryId;
    if (longOnly) {
      // Populate the authoritative session BEFORE createAgentSession: mutating the
      // manager after construction does not update the runner's active context.
      for (let turn = 0; turn < 38; turn++) {
        manager.appendMessage({ role: "user", content: `Synthetic turn ${turn}: ${filler(turn)}`, timestamp: Date.now() });
        manager.appendMessage(fakeAssistant(model, [{ type: "text", text: `Synthetic response ${turn}.` }]));
      }
      manager.appendMessage({ role: "user", content: "Run the synthetic build check.", timestamp: Date.now() });
      toolEntryId = manager.appendMessage(fakeAssistant(model, [{ type: "toolCall", id: "synthetic-call-1",
        name: "synthetic_build_check", arguments: { target: "cobalt-713" } }], "toolUse"));
      manager.appendMessage({ role: "toolResult", toolCallId: "synthetic-call-1", toolName: "synthetic_build_check",
        content: [{ type: "text", text: `SYNTH_BUILD_OK ${filler(200)}` }], isError: false, timestamp: Date.now() });
      manager.appendMessage(fakeAssistant(model, [{ type: "text", text: "Synthetic build passed." }]));
    }
    let ds4;
    const loader = new DefaultResourceLoader({
      cwd, agentDir, systemPrompt: SYSTEM_PROMPT, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
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

    async function ask(prompt, stage) {
      const canonical = buildSessionContext(manager.getEntries(), manager.getLeafId()).messages;
      if (longOnly && (canonical.length < 80
        || !canonical.some((message) => message.role === "toolResult" && message.toolCallId === "synthetic-call-1"))) {
        throw new Error("Pi session preflight omitted the synthetic branch; no request sent");
      }
      const estimatedInput = O200K_ESTIMATOR.estimateMessagesTokens([
        ...canonical, { role: "user", content: prompt, timestamp: Date.now() },
      ]) + PREFLIGHT_OVERHEAD;
      reserve(budget, estimatedInput); // count attempted calls before any provider transport
      try {
        await session.prompt(prompt);
      } catch {
        rows.push({ stage, status: "request-error" }); // never log prompt/credentials/provider errors
        return false;
      }
      const manifest = ds4?.latestManifest();
      if (!manifest || manifest.planning?.mode !== "managed"
        || manifest.modelAwareness?.calibration.estimator !== "o200k-base-v1"
        || !manifest.providerUsage || manifest.providerUsage.totalInputTokens <= 0) {
        rows.push({ stage, status: "invalid-manifest-or-usage" });
        return false;
      }
      rows.push({ stage, status: "ok", estimatedInputTokens: manifest.estimatedInputTokens,
        actualInputTokens: manifest.providerUsage.totalInputTokens,
        calibrationSamples: manifest.modelAwareness.calibration.acceptedSamples,
        appliedRatio: manifest.modelAwareness.calibration.appliedRatio,
        autoTune: manifest.modelAwareness.autoTune?.status ?? "disabled",
        managerEntries: manager.getEntries().length,
        originalMessageCount: manifest.planning.originalMessageCount,
        selectedGroups: manifest.planning.selectedGroupCount,
        excludedGroups: manifest.planning.excludedGroupCount,
        retrievalFoundDecision: ds4.retrievalDiagnostics().selected.some((item) => item.entryId === decisionId),
        toolAssistantIncluded: toolEntryId !== undefined && manifest.included.some((item) => item.sourceId === toolEntryId),
        toolResultIncluded: manifest.included.some((item) => item.role === "toolResult"),
      });
      return true;
    }

    if (longOnly) {
      await ask("Why is cobalt-713 expiry 42 days? What did SYNTH_BUILD_OK report? Reply only OK.", "long-tool-retrieval");
    } else {
      for (let turn = 0; turn < 8; turn++) {
        if (!await ask(`Turn ${turn}: what is the cobalt-713 expiry? Reply only OK.`, `calibration-${turn + 1}`)) break;
      }
    }
    return {
      mode: "live", model: `openrouter/${MODEL_ID}`, limits,
      previousCalls, previousEstimated, callsAttempted: budget.calls - previousCalls,
      estimatedInputReserved: budget.estimatedInput - previousEstimated,
      totalCallsAccounted: budget.calls, totalEstimatedAccounted: budget.estimatedInput, rows,
      note: "Synthetic temp Pi JSONL only; actual input is Pi-normalized provider usage, not billed usage. No request or response text retained in report.",
    };
  } finally {
    session?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`),
    () => { process.stderr.write("Probe failed; inspect counters before retrying.\n"); process.exitCode = 1; },
  );
}
