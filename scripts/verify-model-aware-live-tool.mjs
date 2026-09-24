#!/usr/bin/env node
/** One bounded Pi tool-cycle probe under the remaining 15/80k/350k authorization. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

export const LIMITS = Object.freeze({ calls: 15, perCall: 80_000, total: 350_000 });
export const PREVIOUS = Object.freeze({ calls: 11, tokens: 292_818 });
const MODEL_ID = "openai/gpt-4o-mini";
const TOOL_NAME = "synthetic_lookup";

export function reserve(budget, tokens) {
  if (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens > LIMITS.perCall
    || budget.calls >= LIMITS.calls || budget.tokens + tokens > LIMITS.total) {
    throw new Error("Authorized per-request provider budget exhausted before transport");
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
  const root = mkdtempSync(join(tmpdir(), "ds4-live-tool-probe-"));
  const budget = { ...PREVIOUS };
  const requests = [];
  let session;
  let unsubscribe;
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
    let ds4;
    let executed = 0;
    const loader = new DefaultResourceLoader({ cwd, agentDir,
      systemPrompt: "Synthetic tool protocol. Call synthetic_lookup once, then answer only OK. No other tools.",
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [
        (pi) => { ds4 = registerDs4ContextEngine(pi, { agentDir, homeDir: root, logSink: () => {} }); },
        (pi) => pi.registerTool({
          name: TOOL_NAME, label: "Synthetic Lookup",
          description: "Return a fixed synthetic build result for the requested key.",
          parameters: Type.Object({ key: Type.String() }),
          async execute() {
            executed++;
            return { content: [{ type: "text", text: "SYNTH_BUILD_OK cobalt-713" }], details: { synthetic: true } };
          },
        }),
      ],
    });
    await loader.reload();
    // Pi's SDK invokes modelRuntime.streamSimple for EVERY agent-loop model request,
    // including the post-tool continuation. Gate there, not merely at prompt().
    const originalStream = modelRuntime.streamSimple.bind(modelRuntime);
    modelRuntime.streamSimple = (activeModel, context, options) => {
      const toolSchemaChars = JSON.stringify(context.tools ?? []).length;
      const preflight = O200K_ESTIMATOR.estimateMessagesTokens(context.messages)
        + O200K_ESTIMATOR.estimateTextTokens(context.systemPrompt ?? "")
        + Math.ceil(toolSchemaChars / 4) + 12_000;
      reserve(budget, preflight);
      requests.push({ preflight, hasToolResult: context.messages.some((message) =>
        message.role === "toolResult" && message.toolName === TOOL_NAME),
        toolSchemaPresent: (context.tools ?? []).some((tool) => tool.name === TOOL_NAME) });
      return originalStream(activeModel, context, options);
    };
    const created = await createAgentSession({ cwd, agentDir,
      model: { ...model, maxTokens: 64 }, modelRuntime, resourceLoader: loader,
      sessionManager: SessionManager.create(cwd, join(root, "sessions")),
      settingsManager: SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } }),
      thinkingLevel: "off", noTools: "builtin", tools: [TOOL_NAME],
    });
    session = created.session;
    await session.bindExtensions({ mode: "print" });
    if (!session.getActiveToolNames().includes(TOOL_NAME)) {
      return { mode: "unavailable", reason: "synthetic-tool-not-active", totalCalls: budget.calls };
    }
    const usageRows = [];
    unsubscribe = session.subscribe((event) => {
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const usage = event.message.usage;
        usageRows.push({ actual: (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0),
          stopReason: event.message.stopReason });
      }
    });
    try {
      await session.prompt("Call synthetic_lookup exactly once with key cobalt-713. After its result, answer only OK.");
    } catch {
      return { mode: "live", status: "request-error", totalCalls: budget.calls,
        totalReserved: budget.tokens, requests, executed, usageRows };
    }
    const manifest = ds4?.latestManifest();
    const verified = executed === 1 && requests.length === 2
      && requests[0]?.toolSchemaPresent && requests[1]?.hasToolResult
      && usageRows.length >= 2 && usageRows.every((row) => row.actual > 0)
      && manifest?.modelAwareness?.calibration.estimator === "o200k-base-v1";
    return { mode: "live", status: verified ? "ok" : "not-verified",
      callsAttempted: budget.calls - PREVIOUS.calls, totalCalls: budget.calls,
      totalReserved: budget.tokens, requests, executed, usageRows,
      manifestEstimated: manifest?.estimatedInputTokens,
      note: "Only temporary synthetic tool and Pi session; per-request modelRuntime gate prevents over-budget provider transport. No prompt, response or credentials in report.",
    };
  } finally {
    unsubscribe?.();
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
