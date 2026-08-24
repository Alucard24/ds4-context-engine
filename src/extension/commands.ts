import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Ds4ContextRuntime, RuntimeDiagnostics } from "./runtime.ts";

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const SUBCOMMANDS = ["status", "tokens", "manifest", "health", "rebuild-index"] as const;

function count(value: number | undefined): string {
  return value === undefined ? "n/a" : NUMBER_FORMAT.format(value);
}

function present(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else console.log(message);
}

function formatStatus(diagnostics: RuntimeDiagnostics): string {
  const session = diagnostics.session;
  const observation = diagnostics.observation;
  const budget = observation?.budget;
  const model = diagnostics.model ? `${diagnostics.model.provider}/${diagnostics.model.id}` : "not selected";
  const indexStatus = diagnostics.lastIndexResult
    ? `${diagnostics.lastIndexResult.mode} (${diagnostics.lastIndexResult.reason})`
    : "not run";

  return [
    "DS4 Context Engine",
    "",
    `State:                    ${diagnostics.phase}`,
    `Planner:                  ${diagnostics.plannerVersion} (pass-through)`,
    `Extension / Pi target:    ${diagnostics.extensionVersion} / ${diagnostics.supportedPiVersion}`,
    `Session:                  ${session?.sessionId ?? "unavailable"}`,
    `Session entries:          ${count(session?.totalEntries)}`,
    `Current branch entries:   ${count(session?.branchEntries)}`,
    `Model:                    ${model}`,
    `Observed messages:        ${count(observation?.messageCount)}`,
    `Observed message tokens:  ${count(observation?.estimatedMessageTokens)} estimated`,
    `Active input budget:      ${count(budget?.activeInputBudget ?? diagnostics.lastManifest?.targetInputTokens)}`,
    `Latest manifest:          ${diagnostics.lastManifest?.id ?? "not built"}`,
    `Indexed entries:          ${count(diagnostics.indexed?.entries)}`,
    `Last index sync:          ${indexStatus}`,
    `Malformed JSONL lines:    ${count(diagnostics.lastIndexResult?.malformedLines)}`,
    `Database schema:          ${diagnostics.databaseSchemaVersion ?? "unavailable"}`,
    `Database:                 ${diagnostics.databasePath ?? "unavailable"}`,
    ...(diagnostics.configWarnings.length > 0
      ? [`Configuration warnings:    ${diagnostics.configWarnings.length}`]
      : []),
    ...(diagnostics.lastIndexError ? [`Index warning:             ${diagnostics.lastIndexError}`] : []),
    ...(diagnostics.lastError ? [`Fallback reason:           ${diagnostics.lastError}`] : []),
  ].join("\n");
}

function formatTokens(diagnostics: RuntimeDiagnostics): string {
  const observation = diagnostics.observation;
  const budget = observation?.budget;
  const manifest = diagnostics.lastManifest;
  return [
    "DS4 Context Tokens (observer mode)",
    "",
    `System prompt:            ${count(manifest?.composition.systemTokens)}`,
    `Tool definitions:         ${count(manifest?.composition.toolTokens)}`,
    `AgentMessage[]:           ${count(manifest?.composition.messageTokens)}`,
    `Estimated provider input: ${count(manifest?.estimatedInputTokens)}`,
    `Actual provider input:    ${count(manifest?.actualInputTokens)}`,
    `Pi reported context:      ${count(manifest?.piReportedContextTokens ?? observation?.reportedTokens)}`,
    `Model context window:     ${count(budget?.contextWindow ?? manifest?.contextWindow)}`,
    `Output reserve:           ${count(budget?.outputReserve ?? manifest?.outputReserve)}`,
    `Safety margin:            ${count(budget?.safetyMargin)}`,
    `Soft input limit:         ${count(budget?.softInputLimit)}`,
    `Hard input limit:         ${count(budget?.hardInputLimit ?? manifest?.hardInputLimit)}`,
    `Preferred input target:   ${count(budget?.preferredInputTarget ?? manifest?.targetInputTokens)}`,
    `Active input budget:      ${count(budget?.activeInputBudget ?? manifest?.targetInputTokens)}`,
    "",
    "Estimates cover Pi's effective system prompt, active tool schemas, and AgentMessage[] before provider rendering.",
  ].join("\n");
}

function formatManifest(diagnostics: RuntimeDiagnostics): string {
  const manifest = diagnostics.lastManifest;
  if (!manifest) return "No Context Manifest has been built for this session yet.";

  const kinds = new Map<string, { items: number; tokens: number }>();
  for (const item of manifest.included) {
    const aggregate = kinds.get(item.kind) ?? { items: 0, tokens: 0 };
    aggregate.items++;
    aggregate.tokens += item.tokens;
    kinds.set(item.kind, aggregate);
  }
  const composition = [...kinds.entries()]
    .map(([kind, value]) => `  ${kind.padEnd(10)} ${String(value.items).padStart(4)} item(s)  ${count(value.tokens).padStart(10)} tokens`);

  return [
    "DS4 Context Manifest",
    "",
    `ID:                 ${manifest.id}`,
    `Session / leaf:     ${manifest.sessionId} / ${manifest.branchLeafId ?? "root"}`,
    `Provider / model:   ${manifest.provider} / ${manifest.model}`,
    `Prompt hash:        ${manifest.promptHash}`,
    `Planner / policy:   ${manifest.plannerVersion} / ${manifest.policyVersion}`,
    `Estimated input:    ${count(manifest.estimatedInputTokens)}`,
    `Actual input:       ${count(manifest.actualInputTokens)}`,
    `Target / hard:      ${count(manifest.targetInputTokens)} / ${count(manifest.hardInputLimit)}`,
    `Included / excluded:${count(manifest.included.length)} / ${count(manifest.excluded.length)}`,
    `Summary sources:    ${manifest.summaryIds.length > 0 ? manifest.summaryIds.join(", ") : "none"}`,
    "",
    "Composition",
    ...composition,
  ].join("\n");
}

export function registerContextCommand(pi: ExtensionAPI, runtime: Ds4ContextRuntime): void {
  pi.registerCommand("context", {
    description: "Inspect DS4 Context Engine status, tokens, or storage health",
    getArgumentCompletions: (prefix) => {
      const matches = SUBCOMMANDS.filter((command) => command.startsWith(prefix.trim()));
      return matches.length > 0 ? matches.map((command) => ({ value: command, label: command })) : null;
    },
    handler: async (args, ctx) => {
      const subcommand = args.trim().toLowerCase() || "status";

      try {
        if (subcommand === "status") {
          const diagnostics = runtime.diagnostics(ctx);
          const level = diagnostics.phase === "degraded" ? "warning" : "info";
          present(ctx, formatStatus(diagnostics), level);
          return;
        }

        if (subcommand === "tokens") {
          present(ctx, formatTokens(runtime.diagnostics(ctx)));
          return;
        }

        if (subcommand === "manifest") {
          present(ctx, formatManifest(runtime.diagnostics(ctx)));
          return;
        }

        if (subcommand === "rebuild-index") {
          await ctx.waitForIdle();
          const result = runtime.rebuildIndex(ctx);
          present(
            ctx,
            [
              "DS4 Context Index Rebuilt",
              "",
              `Reason:              ${result.reason}`,
              `Processed entries:   ${count(result.processedEntries)}`,
              `Indexed entries:     ${count(result.totalEntries)}`,
              `Malformed lines:     ${count(result.malformedLines)}`,
              `Duration:            ${result.durationMs.toFixed(1)} ms`,
            ].join("\n"),
          );
          return;
        }

        if (subcommand === "health") {
          const health = runtime.health();
          if (!health) {
            present(ctx, "DS4 Context Engine database is unavailable; Pi fallback remains active.", "warning");
            return;
          }
          present(
            ctx,
            [
              "DS4 Context Engine Health",
              "",
              `Status:              ${health.ok ? "OK" : "WARN"}`,
              `SQLite quick_check:  ${health.quickCheck}`,
              `Journal mode:        ${health.journalMode}`,
              `Foreign keys:        ${health.foreignKeys ? "enabled" : "disabled"}`,
              `Schema version:      ${health.schemaVersion}`,
              `Applied migrations:  ${health.appliedMigrations}`,
            ].join("\n"),
            health.ok ? "info" : "warning",
          );
          return;
        }

        present(ctx, `Unknown /context command: ${subcommand}\nUsage: /context [${SUBCOMMANDS.join("|")}]`, "warning");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        present(ctx, `DS4 Context Engine diagnostics failed: ${message}`, "warning");
      }
    },
  });
}
