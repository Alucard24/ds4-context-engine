#!/usr/bin/env node
/** Explicit opt-in Pi+DS4 probe. New authorization: 16 calls / 80k each / 600k total estimated input. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  buildSessionContext, createAgentSession, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

export const LIMITS = Object.freeze({ calls: 16, perCall: 80_000, total: 600_000 });
const OVERHEAD = 12_000;
const MODEL_ID = "openai/gpt-4o-mini";
const SYSTEM_PROMPT = "Synthetic context probe. Reply only OK. Do not quote the transcript or tool output.";

export function reserve(budget, tokens) {
  if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > LIMITS.perCall
    || budget.calls >= LIMITS.calls || budget.tokens + tokens > LIMITS.total) {
    throw new Error("Authorized probe budget exhausted before provider transport");
  }
  budget.calls++;
  budget.tokens += tokens;
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
function highInput(parts) {
  return `Synthetic high-occupancy measurement. Reply only OK.\n${Array.from({ length: parts }, (_, i) => filler(100 + i)).join("\n")}`;
}

function seedLongBranch(manager, model) {
  const decisionId = manager.appendMessage({ role: "user",
    content: "DECISION cobalt-713 has an expiry of 42 days; never log credentials.", timestamp: Date.now() });
  manager.appendMessage(assistant(model, [{ type: "text", text: "Acknowledged." }]));
  for (let turn = 0; turn < 28; turn++) {
    manager.appendMessage({ role: "user", content: `Synthetic turn ${turn}: ${filler(turn)}`, timestamp: Date.now() });
    manager.appendMessage(assistant(model, [{ type: "text", text: `Synthetic response ${turn}.` }]));
  }
  manager.appendMessage({ role: "user", content: "Run the synthetic build check.", timestamp: Date.now() });
  const toolEntryId = manager.appendMessage(assistant(model, [{ type: "toolCall", id: "synthetic-call-1",
    name: "synthetic_build_check", arguments: { target: "cobalt-713" } }], "toolUse"));
  manager.appendMessage({ role: "toolResult", toolCallId: "synthetic-call-1", toolName: "synthetic_build_check",
    content: [{ type: "text", text: `SYNTH_BUILD_OK ${filler(200)}` }], isError: false, timestamp: Date.now() });
  manager.appendMessage(assistant(model, [{ type: "text", text: "Synthetic build passed." }]));
  return { decisionId, toolEntryId };
}

export async function main(argv) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--live")) {
    throw new Error("Only --live is supported");
  }
  if (argv.length === 0) return { mode: "dry-run", limits: LIMITS, model: `openrouter/${MODEL_ID}` };
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  const model = modelRuntime.getModel("openrouter", MODEL_ID);
  if (!model || !modelRuntime.hasConfiguredAuth("openrouter")) return { mode: "unavailable", limits: LIMITS };
  if (model.contextWindow !== 128_000) throw new Error("Model window differs from 128k probe plan");
  const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createJiti } = requireFromPi("jiti");
  const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
  const { registerDs4ContextEngine } = await jiti.import("../src/extension/index.ts");
  const { O200K_ESTIMATOR } = await jiti.import("../src/pi-adapter/bpe-token-estimator.ts");
  const root = mkdtempSync(join(tmpdir(), "ds4-calibrated-session-"));
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
    const { decisionId, toolEntryId } = seedLongBranch(manager, model); // before runner initialization
    let ds4;
    const loader = new DefaultResourceLoader({ cwd, agentDir, systemPrompt: SYSTEM_PROMPT,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => { ds4 = registerDs4ContextEngine(pi, { agentDir, homeDir: root, logSink: () => {} }); }],
    });
    await loader.reload();
    const created = await createAgentSession({
      cwd, agentDir, model: { ...model, maxTokens: 64 }, modelRuntime, resourceLoader: loader,
      sessionManager: manager,
      settingsManager: SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } }),
      thinkingLevel: "off", noTools: "all",
    });
    session = created.session;
    await session.bindExtensions({ mode: "print" });

    const estimateRaw = (prompt) => O200K_ESTIMATOR.estimateMessagesTokens([
      ...buildSessionContext(manager.getEntries(), manager.getLeafId()).messages,
      { role: "user", content: prompt, timestamp: Date.now() },
    ]) + OVERHEAD;
    async function ask(prompt, stage, expected) {
      const canonical = buildSessionContext(manager.getEntries(), manager.getLeafId()).messages;
      if (canonical.length < 60 || !canonical.some((message) =>
        message.role === "toolResult" && message.toolCallId === "synthetic-call-1")) {
        throw new Error("Canonical long/tool branch missing before transport");
      }
      const preflight = estimateRaw(prompt);
      reserve(budget, preflight); // count attempted calls before provider transport
      try {
        await session.prompt(prompt);
      } catch {
        rows.push({ stage, status: "request-error", preflight }); // no provider errors, payloads or credentials logged
        return false;
      }
      const manifest = ds4?.latestManifest();
      if (!manifest || manifest.planning?.mode !== "managed"
        || manifest.planning.originalMessageCount < 60
        || manifest.modelAwareness?.calibration.estimator !== "o200k-base-v1"
        || !manifest.providerUsage || manifest.providerUsage.totalInputTokens <= 0) {
        rows.push({ stage, status: "invalid-manifest-or-usage", preflight });
        return false;
      }
      const row = { stage, status: "ok", preflight,
        estimated: manifest.estimatedInputTokens, actual: manifest.providerUsage.totalInputTokens,
        accepted: manifest.modelAwareness.calibration.acceptedSamples,
        hardBoundSamples: manifest.modelAwareness.calibration.hardBoundSamples ?? 0,
        appliedRatio: manifest.modelAwareness.calibration.appliedRatio,
        autoTune: manifest.modelAwareness.autoTune?.status ?? "disabled",
        recentTailTokens: manifest.modelAwareness.adaptive.recentTailTokens,
        originalMessages: manifest.planning.originalMessageCount,
        selectedGroups: manifest.planning.selectedGroupCount,
        excludedGroups: manifest.planning.excludedGroupCount,
        retrievalFoundDecision: ds4.retrievalDiagnostics().selected.some((item) => item.entryId === decisionId),
        toolAssistantIncluded: manifest.included.some((item) => item.sourceId === toolEntryId),
        toolResultIncluded: manifest.included.some((item) => item.role === "toolResult"),
      };
      if (expected && !expected(row)) row.status = "scenario-failed";
      rows.push(row);
      return row.status === "ok";
    }

    const question = "Why is cobalt-713 expiry 42 days? What did SYNTH_BUILD_OK report? Reply only OK.";
    for (let turn = 0; turn < 8; turn++) {
      if (!await ask(`${question} Calibration turn ${turn}.`, `calibration-${turn + 1}`,
        (row) => row.autoTune === "insufficient-samples" && row.toolAssistantIncluded
          && row.toolResultIncluded && row.retrievalFoundDecision)) break;
    }
    if (rows.length === 8 && rows.every((row) => row.status === "ok")) {
      if (await ask(question, "calibrated-long", (row) => row.accepted >= 8 && row.autoTune === "expanded"
        && row.toolAssistantIncluded && row.toolResultIncluded && row.retrievalFoundDecision)) {
        let parts = 28;
        while (parts >= 18 && estimateRaw(highInput(parts)) > LIMITS.perCall) parts--;
        if (parts >= 18) {
          if (await ask(highInput(parts), "attempted-high-occupancy", () => true)) {
            await ask(question, "after-large-input", (row) => row.autoTune === "no-headroom");
          }
        }
      }
    }
    return {
      mode: "live", model: `openrouter/${MODEL_ID}`, limits: LIMITS,
      callsAttempted: budget.calls, estimatedInputReserved: budget.tokens,
      complete: rows.some((row) => row.stage === "after-large-input" && row.status === "ok"
        && row.autoTune === "no-headroom"), rows,
      note: "Synthetic temp Pi JSONL only. Usage is Pi-normalized provider usage, not billed usage. No prompt, response or credentials logged. Tool history is seeded, not live tool execution.",
    };
  } finally {
    session?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`),
    () => { process.stderr.write("Probe failed; do not retry without accounting for attempts.\n"); process.exitCode = 1; },
  );
}
