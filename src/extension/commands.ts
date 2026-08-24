import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
  Ds4ContextRuntime,
  RuntimeDiagnostics,
  SummaryGraphDiagnostics,
} from "./runtime.ts";

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const SUBCOMMANDS = [
  "status",
  "tokens",
  "manifest",
  "explain",
  "included",
  "excluded",
  "summaries",
  "retrieved",
  "compaction",
  "compact-preview",
  "health",
  "rebuild-index",
] as const;

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
    `Planner:                  ${diagnostics.plannerVersion} (${diagnostics.lastManifest?.planning?.mode ?? diagnostics.contextMode})`,
    `Extension / Pi target:    ${diagnostics.extensionVersion} / ${diagnostics.supportedPiVersion}`,
    `Session:                  ${session?.sessionId ?? "unavailable"}`,
    `Session entries:          ${count(session?.totalEntries)}`,
    `Current branch entries:   ${count(session?.branchEntries)}`,
    `Model:                    ${model}`,
    `Original messages:        ${count(observation?.originalMessageCount)}`,
    `Selected messages:        ${count(observation?.messageCount)}`,
    `Original message tokens:  ${count(observation?.originalEstimatedMessageTokens)} estimated`,
    `Selected message tokens:  ${count(observation?.estimatedMessageTokens)} estimated`,
    `Planning duration:        ${observation?.planningDurationMs === undefined ? "n/a" : `${observation.planningDurationMs.toFixed(1)} ms`}`,
    `Active input budget:      ${count(budget?.activeInputBudget ?? diagnostics.lastManifest?.targetInputTokens)}`,
    `Latest manifest:          ${diagnostics.lastManifest?.id ?? "not built"}`,
    `Compaction:               ${diagnostics.compaction.phase}`,
    `Proactive compaction:     ${diagnostics.compaction.proactiveEligible ? "eligible" : "not eligible"}`,
    `Retrieved evidence:       ${count(diagnostics.retrieval.selected.length)} item(s), ${count(diagnostics.retrieval.selectedTokens)} tokens`,
    `Retrieval duration:       ${diagnostics.retrieval.durationMs.toFixed(1)} ms`,
    `Indexed entries:          ${count(diagnostics.indexed?.entries)}`,
    `Last index sync:          ${indexStatus}`,
    `Malformed JSONL lines:    ${count(diagnostics.lastIndexResult?.malformedLines)}`,
    `Database schema:          ${diagnostics.databaseSchemaVersion ?? "unavailable"}`,
    `Database:                 ${diagnostics.databasePath ?? "unavailable"}`,
    ...(diagnostics.configWarnings.length > 0
      ? [`Configuration warnings:    ${diagnostics.configWarnings.length}`]
      : []),
    ...(diagnostics.lastIndexError ? [`Index warning:             ${diagnostics.lastIndexError}`] : []),
    ...(observation?.fallbackReason ? [`Planner fallback:          ${observation.fallbackReason}`] : []),
    ...(diagnostics.lastError ? [`Runtime fallback:          ${diagnostics.lastError}`] : []),
  ].join("\n");
}

function formatTokens(diagnostics: RuntimeDiagnostics): string {
  const observation = diagnostics.observation;
  const budget = observation?.budget;
  const manifest = diagnostics.lastManifest;
  return [
    `DS4 Context Tokens (${manifest?.planning?.mode ?? diagnostics.contextMode} mode)`,
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
    `Planning mode:      ${manifest.planning?.mode ?? "observer"}`,
    `Original messages:  ${count(manifest.planning?.originalMessageCount ?? manifest.composition.messageCount)}`,
    `Selected messages:  ${count(manifest.composition.messageCount)}`,
    `Recent-tail limit:  ${count(manifest.planning?.recentTailTokenLimit)}`,
    `Planning duration:  ${manifest.planning?.durationMs === undefined ? "n/a" : `${manifest.planning.durationMs.toFixed(1)} ms`}`,
    ...(manifest.planning?.fallbackReason ? [`Fallback:           ${manifest.planning.fallbackReason}`] : []),
    `Summary sources:    ${manifest.summaryIds.length > 0 ? manifest.summaryIds.join(", ") : "none"}`,
    "",
    "Composition",
    ...composition,
  ].join("\n");
}

function formatManifestItems(diagnostics: RuntimeDiagnostics, type: "included" | "excluded"): string {
  const manifest = diagnostics.lastManifest;
  if (!manifest) return "No Context Manifest has been built for this session yet.";
  const items = manifest[type];
  return [
    `DS4 Context ${type === "included" ? "Included" : "Excluded"} Items`,
    "",
    ...(items.length === 0
      ? ["none"]
      : items.map((item, index) => {
          const score = item.score === undefined ? "-" : item.score.toFixed(3);
          const source = item.sourceId ?? "transient";
          const group = item.groupId ? ` group=${item.groupId}` : "";
          return `${String(index + 1).padStart(3)}. ${item.kind.padEnd(8)} ${count(item.tokens).padStart(8)} tok score=${score} source=${source}${group}\n     ${item.reason}`;
        })),
  ].join("\n");
}

function formatExplain(diagnostics: RuntimeDiagnostics): string {
  const planning = diagnostics.lastManifest?.planning;
  if (!planning) {
    return "Latest context used observer mode; no managed-context selection was applied.";
  }
  return [
    "DS4 Context Plan",
    "",
    `Mode:                 ${planning.mode}`,
    `Original messages:    ${count(planning.originalMessageCount)}`,
    `Original tokens:      ${count(planning.originalMessageTokens)}`,
    `Fixed system/tools:   ${count(planning.fixedTokens)}`,
    `Message target:       ${count(planning.messageTargetTokens)}`,
    `Message hard limit:   ${count(planning.messageHardLimitTokens)}`,
    `Recent-tail limit:    ${count(planning.recentTailTokenLimit)}`,
    `Selected groups:      ${count(planning.selectedGroupCount)}`,
    `Excluded groups:      ${count(planning.excludedGroupCount)}`,
    `Duration:             ${planning.durationMs === undefined ? "n/a" : `${planning.durationMs.toFixed(1)} ms`}`,
    ...(planning.fallbackReason ? [`Fallback reason:       ${planning.fallbackReason}`] : []),
    "",
    "Use /context included or /context excluded for item-level provenance.",
    "Label an active Pi entry with 'ds4:pin' to make its atomic turn mandatory.",
  ].join("\n");
}

function formatSummaryGraph(graph: SummaryGraphDiagnostics): string {
  const recentNodes = graph.nodes.slice(0, 24);
  return [
    "DS4 Hierarchical Summary Graph",
    "",
    `Nodes:                   ${count(graph.totalNodes)}`,
    `Committed/prepared/failed: ${count(graph.committedNodes)} / ${count(graph.preparedNodes)} / ${count(graph.failedNodes)}`,
    `Segment/aggregate/branch:  ${count(graph.segmentNodes)} / ${count(graph.aggregateNodes)} / ${count(graph.branchNodes)}`,
    `Maximum graph level:     ${count(graph.maxGraphLevel)}`,
    `Active summary:          ${graph.activeSummaryId ?? "none on current branch"}`,
    `Active path nodes:       ${count(graph.activePathIds.length)}`,
    `Committed roots:         ${graph.rootSummaryIds.length > 0 ? graph.rootSummaryIds.join(", ") : "none"}`,
    "",
    "Recent nodes (* = current branch active path)",
    ...(recentNodes.length === 0
      ? ["none"]
      : recentNodes.map((node) => {
          const marker = node.activePath ? "*" : " ";
          const children = node.children.length > 0 ? node.children.join(",") : "-";
          return `${marker} ${node.id}  ${node.kind} L${node.graphLevel} ${node.lifecycleStatus}/${node.validationStatus} sources=${node.sourceEntries} children=${children}`;
        })),
    ...(graph.nodes.length > recentNodes.length ? [`... ${graph.nodes.length - recentNodes.length} older node(s) omitted`] : []),
  ].join("\n");
}

function formatRetrieved(diagnostics: RuntimeDiagnostics): string {
  const retrieval = diagnostics.retrieval;
  return [
    "DS4 Retrieved Historical Evidence",
    "",
    `Status:                   ${retrieval.status}`,
    `Query terms:              ${retrieval.queryTerms.length > 0 ? retrieval.queryTerms.join(", ") : "none"}`,
    `Candidates:               ${count(retrieval.candidateCount)}`,
    `Alternate-branch blocked:${count(retrieval.alternateBranchCandidates).padStart(9)}`,
    `Duplicate candidates:     ${count(retrieval.duplicateCandidates)}`,
    `Planner exclusions:       ${count(retrieval.plannerExcludedCount)}`,
    `Selected:                 ${count(retrieval.selected.length)}`,
    `Selected / maximum tokens:${count(retrieval.selectedTokens).padStart(9)} / ${count(retrieval.maxTokens)}`,
    `Duration:                 ${retrieval.durationMs.toFixed(3)} ms`,
    ...(retrieval.fallbackReason ? [`Fallback:                 ${retrieval.fallbackReason}`] : []),
    ...retrieval.warnings.map((warning) => `Warning:                  ${warning}`),
    "",
    ...(retrieval.selected.length === 0
      ? ["No historical evidence was injected into the latest managed context."]
      : retrieval.selected.flatMap((evidence, index) => [
          `${index + 1}. ${evidence.entryId}  score=${evidence.score.toFixed(3)}  tokens=${count(evidence.estimatedTokens)}  role=${evidence.role ?? "unknown"}`,
          `   ${evidence.reason}`,
          `   ${evidence.excerpt.replace(/\s+/gu, " ").slice(0, 500)}${evidence.excerpt.length > 500 ? "…" : ""}`,
        ])),
  ].join("\n");
}

function formatCompaction(diagnostics: RuntimeDiagnostics, preview: boolean): string {
  const compaction = diagnostics.compaction;
  return [
    preview ? "DS4 Compaction Preview" : "DS4 Compaction",
    "",
    `Custom compaction:       ${compaction.enabled ? "enabled" : "disabled"}`,
    `Deterministic validator: ${compaction.validate ? "enabled" : "disabled"}`,
    `Preserve recent tail:    ${compaction.preserveRecentVerbatim ? "yes" : "no"}`,
    `Segment target:          ${count(compaction.segmentTargetTokens)}`,
    `Current context tokens:  ${count(compaction.contextTokens)}`,
    `Model soft limit:        ${count(compaction.softLimitTokens)}`,
    `Proactive threshold:     ${count(compaction.proactiveThresholdTokens)}`,
    `Would compact now:       ${compaction.proactiveEligible ? "yes" : "no"}`,
    `Last phase:              ${compaction.phase}`,
    `Last trigger:            ${compaction.trigger ?? "n/a"}`,
    `Summary ID:              ${compaction.summaryId ?? "n/a"}`,
    `Source entries:          ${count(compaction.sourceEntries)}`,
    `Validation:              ${compaction.validationStatus ?? "n/a"}`,
    `First kept entry:        ${compaction.firstKeptEntryId ?? "n/a"}`,
    `Tokens before:           ${count(compaction.tokensBefore)}`,
    ...(compaction.lastError ? [`Last error:              ${compaction.lastError}`] : []),
    ...(preview
      ? ["", "Pi determines the exact cut point; DS4 preserves Pi's firstKeptEntryId and validates the generated summary before replacing history."]
      : []),
  ].join("\n");
}

export function registerContextCommand(pi: ExtensionAPI, runtime: Ds4ContextRuntime): void {
  pi.registerCommand("context", {
    description: "Inspect DS4 managed context, provenance, tokens, or storage health",
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

        if (subcommand === "explain") {
          present(ctx, formatExplain(runtime.diagnostics(ctx)));
          return;
        }

        if (subcommand === "included" || subcommand === "excluded") {
          present(ctx, formatManifestItems(runtime.diagnostics(ctx), subcommand));
          return;
        }

        if (subcommand === "summaries") {
          present(ctx, formatSummaryGraph(runtime.summaryGraph(ctx)));
          return;
        }

        if (subcommand === "retrieved") {
          present(ctx, formatRetrieved(runtime.diagnostics(ctx)));
          return;
        }

        if (subcommand === "compaction" || subcommand === "compact-preview") {
          present(ctx, formatCompaction(runtime.diagnostics(ctx), subcommand === "compact-preview"));
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
