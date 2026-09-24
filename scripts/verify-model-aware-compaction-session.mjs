#!/usr/bin/env node
/** One-request compaction-boundary probe inside the already authorized 15/80k/350k budget. */
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
export const PREVIOUS = Object.freeze({ calls: 9, tokens: 169_006 });
const MODEL_ID = "openai/gpt-4o-mini";
const SUMMARY_MARKER = "COMPACTED_FACT cobalt-713 expiry is 42 days";

export function reserve(budget, tokens) {
  if (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens > LIMITS.perCall
    || budget.calls >= LIMITS.calls || budget.tokens + tokens > LIMITS.total) {
    throw new Error("Authorized probe budget exhausted before provider transport");
  }
  budget.calls++;
  budget.tokens += tokens;
}

export async function main(argv) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--live")) {
    throw new Error("Only --live is supported");
  }
  if (argv.length === 0) return { mode: "dry-run", limits: LIMITS, previous: PREVIOUS };
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  const model = modelRuntime.getModel("openrouter", MODEL_ID);
  if (!model || !modelRuntime.hasConfiguredAuth("openrouter")) return { mode: "unavailable", limits: LIMITS };
  const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createJiti } = requireFromPi("jiti");
  const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
  const { registerDs4ContextEngine } = await jiti.import("../src/extension/index.ts");
  const { O200K_ESTIMATOR } = await jiti.import("../src/pi-adapter/bpe-token-estimator.ts");
  const root = mkdtempSync(join(tmpdir(), "ds4-compaction-probe-"));
  const budget = { ...PREVIOUS };
  let session;
  try {
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    mkdirSync(cwd);
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "ds4-context.json"), JSON.stringify({
      project: { enabled: false }, memory: { enabled: false }, artifacts: { enabled: false },
      compaction: { enabled: false }, modelAwareness: { autoTune: false,
        overrides: { [`openrouter/${MODEL_ID}`]: { tokenEstimator: "o200k-base-v1" } } },
    }));
    const manager = SessionManager.create(cwd, join(root, "sessions"));
    manager.appendMessage({ role: "user", content: "RAW_OLD_DECISION cobalt-713 expiry is 42 days.", timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Recorded." }],
      api: model.api, provider: model.provider, model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now() });
    const kept = manager.appendMessage({ role: "user", content: "Retain this recent turn.", timestamp: Date.now() });
    manager.appendCompaction(SUMMARY_MARKER, kept, 30_000);
    const before = buildSessionContext(manager.getEntries(), manager.getLeafId()).messages;
    if (!before.some((message) => message.role === "compactionSummary" && message.summary.includes(SUMMARY_MARKER))
      || JSON.stringify(before).includes("RAW_OLD_DECISION")) {
      throw new Error("Canonical Pi context does not cross the intended compaction boundary");
    }
    let ds4;
    const loader = new DefaultResourceLoader({ cwd, agentDir,
      systemPrompt: "Synthetic compaction measurement. Reply only OK. Do not quote history.",
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => { ds4 = registerDs4ContextEngine(pi, { agentDir, homeDir: root, logSink: () => {} }); }],
    });
    await loader.reload();
    const created = await createAgentSession({ cwd, agentDir, model: { ...model, maxTokens: 64 },
      modelRuntime, resourceLoader: loader, sessionManager: manager,
      settingsManager: SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } }),
      thinkingLevel: "off", noTools: "all" });
    session = created.session;
    await session.bindExtensions({ mode: "print" });
    const prompt = "What does the compacted summary say about cobalt-713? Reply only OK.";
    const preflight = O200K_ESTIMATOR.estimateMessagesTokens([
      ...before, { role: "user", content: prompt, timestamp: Date.now() },
    ]) + 12_000;
    reserve(budget, preflight);
    try {
      await session.prompt(prompt);
    } catch {
      return { mode: "live", status: "request-error", callsAttempted: budget.calls - PREVIOUS.calls,
        totalCalls: budget.calls, totalReserved: budget.tokens };
    }
    const manifest = ds4?.latestManifest();
    return { mode: "live", status: manifest?.planning?.mode === "managed"
        && manifest?.modelAwareness?.calibration.estimator === "o200k-base-v1"
        && manifest?.providerUsage?.totalInputTokens > 0
        && manifest?.included.some((item) => item.role === "compactionSummary") ? "ok" : "not-verified",
      callsAttempted: budget.calls - PREVIOUS.calls, totalCalls: budget.calls,
      totalReserved: budget.tokens, preflight,
      estimated: manifest?.estimatedInputTokens, actual: manifest?.providerUsage?.totalInputTokens,
      summaryIncluded: manifest?.included.some((item) => item.role === "compactionSummary") ?? false,
      note: "Synthetic temporary Pi JSONL, no raw transcript or credentials in report; usage is Pi-normalized provider input.",
    };
  } finally {
    session?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`),
    () => { process.stderr.write("Probe failed; account for attempts before retrying.\n"); process.exitCode = 1; },
  );
}
