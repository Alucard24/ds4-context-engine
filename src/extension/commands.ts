import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  isPrivacyClassification,
  type PrivacyClassification,
} from "ds4-context-core/privacy/privacy-policy";
import type { StorageDiagnostics } from "ds4-context-core/persistence/storage-diagnostics";
import { DEFAULT_CONFIG } from "ds4-context-core/config/config";
import { CONFIG_FIELD_DOCS, getConfigValue } from "ds4-context-core/config/config-catalog";
import type {
  ConfigSnapshot,
  Ds4ContextRuntime,
  RuntimeDiagnostics,
  SummaryGraphDiagnostics,
} from "./runtime.ts";

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const SUBCOMMANDS = [
  "status",
  "config",
  "adapter",
  "tokens",
  "manifest",
  "explain",
  "included",
  "excluded",
  "summaries",
  "retrieved",
  "project",
  "pins",
  "pin",
  "unpin",
  "memory",
  "privacy",
  "model",
  "quality",
  "ranking",
  "continuation",
  "artifacts",
  "compaction",
  "compact-preview",
  "storage",
  "health",
  "rebuild-index",
] as const;

function classificationOption(value: string | undefined): PrivacyClassification | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!isPrivacyClassification(normalized)) {
    throw new Error("Classification must be normal, internal, sensitive, or local-only");
  }
  return normalized;
}

function count(value: number | undefined): string {
  return value === undefined ? "n/a" : NUMBER_FORMAT.format(value);
}

function bytes(value: number | undefined): string {
  if (value === undefined) return "n/a";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit++;
  }
  const digits = unit === 0 ? 0 : scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${units[unit]}`;
}

function describeConfigValue(value: unknown): string {
  if (value === undefined) return "unset";
  const text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
  return text.length > 26 ? `${text.slice(0, 25)}…` : text;
}

function formatConfig(snapshot: ConfigSnapshot): string {
  const lines = [
    `DS4 Context Configuration (${snapshot.contractVersion})`,
    "",
    `Enabled:                   ${snapshot.config.enabled ? "yes" : "no"}`,
    `Global file:               ${snapshot.globalPath}${snapshot.loadedFiles.includes(snapshot.globalPath) ? " (loaded)" : ""}`,
    `Project file:              ${snapshot.projectPath || "unavailable"}${snapshot.projectPath && snapshot.loadedFiles.includes(snapshot.projectPath) ? " (loaded)" : ""}`,
    `Configuration warnings:    ${snapshot.warnings.length}`,
    ...(snapshot.warnings.length > 0 ? snapshot.warnings.map((warning) => `  - ${warning}`) : []),
    "",
  ];
  let section = "";
  for (const doc of CONFIG_FIELD_DOCS) {
    const head = doc.path.split(".")[0] ?? doc.path;
    if (head !== section) {
      section = head;
      lines.push(`[${section}]`);
    }
    const active = getConfigValue(snapshot.config, doc.path);
    const fallback = getConfigValue(DEFAULT_CONFIG, doc.path);
    const hints: string[] = [];
    if (doc.values && doc.values.length > 0) hints.push(doc.values.join("|"));
    hints.push(doc.kind);
    if (doc.optional) hints.push("optional");
    lines.push(
      `${doc.path.padEnd(48)}  ${describeConfigValue(active).padEnd(28)}  ${describeConfigValue(fallback).padEnd(28)}  ${hints.join(" ")}`,
    );
  }
  lines.push(
    "",
    "Set:   /context config set <path> <value> [--global]",
    "Unset: /context config unset <path> [--global]",
    "JSON values must be quoted, e.g. /context config set compaction.model '{\"provider\":\"openai-codex\",\"id\":\"gpt-5.4-mini\"}'",
  );
  return lines.join("\n");
}

function present(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else console.log(message);
}

interface ParsedCommandArgs {
  positionals: string[];
  options: Map<string, string>;
}

function commandTokens(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | undefined;
  let escaped = false;
  for (const character of value.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Unterminated quote in /context arguments");
  if (current) tokens.push(current);
  return tokens;
}

function parseCommandArgs(value: string): ParsedCommandArgs {
  const tokens = commandTokens(value);
  const positionals: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? "";
    if (token === "--") {
      positionals.push(...tokens.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    if (equals > 2) {
      options.set(token.slice(2, equals).toLowerCase(), token.slice(equals + 1));
      continue;
    }
    const name = token.slice(2).toLowerCase();
    const next = tokens[index + 1];
    if (!next || next.startsWith("--")) {
      options.set(name, "true");
      continue;
    }
    options.set(name, next);
    index++;
  }
  return { positionals, options };
}

function sourceIds(value: string | undefined): string[] {
  return value ? [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))] : [];
}

function splitCommand(value: string, fallback = ""): { command: string; args: string } {
  const match = value.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/u);
  return match
    ? { command: (match[1] ?? fallback).toLowerCase(), args: match[2] ?? "" }
    : { command: fallback, args: "" };
}

function assertOptions(options: ReadonlyMap<string, string>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = [...options.keys()].filter((name) => !allowedSet.has(name));
  if (unknown.length > 0) throw new Error(`Unknown option(s): ${unknown.map((name) => `--${name}`).join(", ")}`);
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
    `Adapter contract:         ${diagnostics.adapter.contractVersion}`,
    `Adapter capabilities:     ${diagnostics.adapter.enabled.length} enabled / ${diagnostics.adapter.disabled.length} disabled`,
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
    `Project knowledge:        ${diagnostics.project.status}`,
    `Project snippets:         ${count(diagnostics.project.selected.length)} item(s), ${count(diagnostics.project.selectedTokens)} tokens`,
    `Project index files:       ${count(diagnostics.project.stats?.files)}`,
    `Stale project snippets:    ${count(diagnostics.project.stats?.staleSnippets)}`,
    `Pins active / selected:    ${count(diagnostics.memory.activePins)} / ${count(diagnostics.memory.selectedPins.length)}`,
    `Memory active / selected:  ${count(diagnostics.memory.activeMemories)} / ${count(diagnostics.memory.selectedMemories.length)}`,
    `Memory tokens:             ${count(diagnostics.memory.selectedPinTokens + diagnostics.memory.selectedMemoryTokens)}`,
    `Privacy enforcement:       ${diagnostics.privacy.enforcement}`,
    `Privacy blocked/redacted:  ${count(diagnostics.privacy.blockedBlocks)} / ${count(diagnostics.privacy.secretRedactions)}`,
    `Estimator calibration:     ${diagnostics.modelAwareness?.calibration.calibrated ? `x${diagnostics.modelAwareness.calibration.appliedRatio.toFixed(3)}` : "collecting/neutral"}`,
    `Calibration samples:       ${count(diagnostics.modelAwareness?.calibration.acceptedSamples)} accepted`,
    `Native continuation:       ${diagnostics.nativeContinuation.status} (${diagnostics.nativeContinuation.last?.mode ?? "no request"})`,
    `Continuation saved items:  ${count(diagnostics.nativeContinuation.last?.omittedInputItems)}`,
    `Quality metrics:           ${diagnostics.quality.enabled ? `${count(diagnostics.quality.storedSamples)} sample(s)` : "disabled"}`,
    `Learned ranking:           ${diagnostics.ranking.status} (${diagnostics.ranking.modelLoaded ? diagnostics.ranking.modelId ?? "loaded" : "no model"})`,
    `Artifact offload:          ${count(diagnostics.artifacts.offloadedCount)} result(s), ${count(diagnostics.artifacts.offloadedBytes)} bytes`,
    `Artifact tokens saved:     ${count(diagnostics.artifacts.estimatedTokensSaved)} estimated`,
    `Artifact objects / refs:   ${count(diagnostics.artifacts.stats.objects)} / ${count(diagnostics.artifacts.stats.references)}`,
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
  const tokensFor = (kind: string) => manifest?.included
    .filter((item) => item.kind === kind)
    .reduce((total, item) => total + item.tokens, 0);
  return [
    `DS4 Context Tokens (${manifest?.planning?.mode ?? diagnostics.contextMode} mode)`,
    "",
    `System prompt:            ${count(manifest?.composition.systemTokens)}`,
    `Tool definitions:         ${count(manifest?.composition.toolTokens)}`,
    `AgentMessage[]:           ${count(manifest?.composition.messageTokens)}`,
    `  Recent verbatim:        ${count(tokensFor("recent"))}`,
    `  Pinned context:         ${count(tokensFor("pin"))}`,
    `  Durable memory:         ${count(tokensFor("memory"))}`,
    `  Historical retrieval:   ${count(tokensFor("retrieval"))}`,
    `  Project snippets:       ${count(tokensFor("project"))}`,
    `  Artifactized results*:  ${count(manifest?.artifacts?.reduce((total, artifact) => total + artifact.condensedTokens, 0))}`,
    `  Active summaries:       ${count(tokensFor("summary"))}`,
    `  Current request:        ${count(tokensFor("current"))}`,
    `Estimated provider input: ${count(manifest?.estimatedInputTokens)}`,
    `Actual provider input:    ${count(manifest?.actualInputTokens)}`,
    `  Uncached input:         ${count(manifest?.providerUsage?.inputTokens)}`,
    `  Cache read / write:     ${count(manifest?.providerUsage?.cacheReadTokens)} / ${count(manifest?.providerUsage?.cacheWriteTokens)}`,
    `Pi reported context:      ${count(manifest?.piReportedContextTokens ?? observation?.reportedTokens)}`,
    `Model context window:     ${count(budget?.contextWindow ?? manifest?.contextWindow)}`,
    `Output reserve:           ${count(budget?.outputReserve ?? manifest?.outputReserve)}`,
    `Safety margin:            ${count(budget?.safetyMargin)}`,
    `Estimator calibration:    ${budget?.calibrationRatio === undefined ? "n/a" : `x${budget.calibrationRatio.toFixed(3)} (${count(budget.calibrationSamples)} samples)`}`,
    `Nominal soft / hard:      ${count(budget?.nominalSoftInputLimit)} / ${count(budget?.nominalHardInputLimit)}`,
    `Soft input limit:         ${count(budget?.softInputLimit)}`,
    `Hard input limit:         ${count(budget?.hardInputLimit ?? manifest?.hardInputLimit)}`,
    `Preferred input target:   ${count(budget?.preferredInputTarget ?? manifest?.targetInputTokens)}`,
    `Active input budget:      ${count(budget?.activeInputBudget ?? manifest?.targetInputTokens)}`,
    "",
    "Estimates cover Pi's effective system prompt, active tool schemas, and AgentMessage[] before provider rendering.",
    "* Artifactized result tokens are already included in AgentMessage[] and the recent/current categories.",
  ].join("\n");
}

function formatManifest(diagnostics: RuntimeDiagnostics): string {
  const manifest = diagnostics.lastManifest;
  if (!manifest) return "No Context Manifest has been built for this session yet.";

  const inventory = manifest.persistedInventory;
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
    `Usage input/cache:  ${count(manifest.providerUsage?.inputTokens)} / ${count(manifest.providerUsage?.cacheReadTokens)} read / ${count(manifest.providerUsage?.cacheWriteTokens)} write`,
    `Target / hard:      ${count(manifest.targetInputTokens)} / ${count(manifest.hardInputLimit)}`,
    `Included / excluded:${count(manifest.included.length)} / ${count(inventory?.excluded.total ?? manifest.excluded.length)}`,
    `Persisted inventory: ${inventory?.completeness ?? "complete"}`,
    ...(inventory?.completeness === "excluded-rollup" ? [
      `Excluded details:  ${count(inventory.excluded.retained)} / ${count(inventory.excluded.total)} retained in persisted projection`,
    ] : []),
    `Planning mode:      ${manifest.planning?.mode ?? "observer"}`,
    `Original messages:  ${count(manifest.planning?.originalMessageCount ?? manifest.composition.messageCount)}`,
    `Selected messages:  ${count(manifest.composition.messageCount)}`,
    `Recent-tail limit:  ${count(manifest.planning?.recentTailTokenLimit)}`,
    `Planning duration:  ${manifest.planning?.durationMs === undefined ? "n/a" : `${manifest.planning.durationMs.toFixed(1)} ms`}`,
    ...(manifest.planning?.fallbackReason ? [`Fallback:           ${manifest.planning.fallbackReason}`] : []),
    `Summary sources:    ${manifest.summaryIds.length > 0 ? manifest.summaryIds.join(", ") : "none"}`,
    `Project snippets:   ${count(manifest.projectSnippets.length)}`,
    `Project revision:   ${manifest.projectRevision?.head ?? "non-git/unavailable"}${manifest.projectRevision?.dirty ? " (dirty)" : ""}`,
    `Pins / memories:    ${count(manifest.pins?.length ?? 0)} / ${count(manifest.memories?.length ?? 0)}`,
    `Artifacts:          ${count(manifest.artifacts?.length ?? 0)}`,
    `Privacy:            ${manifest.privacy?.enforcement ?? "disabled"}${manifest.privacy ? ` (${manifest.privacy.destination})` : ""}`,
    `Model calibration:  ${manifest.modelAwareness?.calibration.calibrated ? `x${manifest.modelAwareness.calibration.appliedRatio.toFixed(3)}` : "neutral/collecting"}`,
    `Adaptive tail/hist/project: ${count(manifest.modelAwareness?.adaptive.recentTailTokens)} / ${count(manifest.modelAwareness?.adaptive.maxRetrievedHistoryTokens)} / ${count(manifest.modelAwareness?.adaptive.maxProjectTokens)}`,
    `Continuation:       ${manifest.nativeContinuation?.mode ?? "disabled"}; sent/full ${count(manifest.nativeContinuation?.sentInputItems)} / ${count(manifest.nativeContinuation?.fullInputItems)}`,
    "",
    "Composition",
    ...composition,
  ].join("\n");
}

function formatManifestItems(diagnostics: RuntimeDiagnostics, type: "included" | "excluded"): string {
  const manifest = diagnostics.lastManifest;
  if (!manifest) return "No Context Manifest has been built for this session yet.";
  const items = manifest[type];
  const inventory = manifest.persistedInventory;
  return [
    `DS4 Context ${type === "included" ? "Included" : "Excluded"} Items`,
    "",
    ...(type === "excluded" && inventory?.completeness === "excluded-rollup"
      ? [`Persisted projection: ${count(inventory.excluded.retained)} / ${count(inventory.excluded.total)} excluded details retained; this is not the complete historical inventory.`, ""]
      : []),
    ...(items.length === 0
      ? ["none"]
      : items.map((item, index) => {
          const score = item.score === undefined ? "-" : item.score.toFixed(3);
          const source = item.sourceId ?? "transient";
          const group = item.groupId ? ` group=${item.groupId}` : "";
          const classification = item.classification ? ` class=${item.classification}` : "";
          return `${String(index + 1).padStart(3)}. ${item.kind.padEnd(8)} ${count(item.tokens).padStart(8)} tok score=${score} source=${source}${group}${classification}\n     ${item.reason}`;
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
    ...(planning.rescuedImmediatePredecessor
      ? ["Rescued predecessor:  yes (immediate previous turn kept beyond the recent-tail cap within the input budget)"]
      : []),
    ...(planning.oversizedTurnExclusions
      ? [`Oversized turn excl:  ${count(planning.oversizedTurnExclusions)} (turn group(s) at/above the recent-tail cap; recovered by retrieval only if it fits)`]
      : []),
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
    `Direct update nodes:      ${count(graph.taskStateNodes)}`,
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
    `Lexical / vector / fused: ${count(retrieval.semantic.lexicalCandidates)} / ${count(retrieval.semantic.vectorCandidates)} / ${count(retrieval.semantic.fusedCandidates)}`,
    `Embedding model:          ${retrieval.semantic.provider && retrieval.semantic.model ? `${retrieval.semantic.provider}/${retrieval.semantic.model}` : "disabled"}`,
    `Embedding dimensions/mode:${count(retrieval.semantic.dimensions).padStart(9)} / ${retrieval.semantic.destination ?? "n/a"}`,
    `Vector index/cache hit:   ${retrieval.semantic.indexFresh ? "fresh" : "stale/unavailable"} / ${retrieval.semantic.queryCacheHit ? "yes" : "no"}`,
    `Embedding calls source/query:${count(retrieval.semantic.sourceEmbeddingCalls).padStart(6)} / ${count(retrieval.semantic.queryEmbeddingCalls)}`,
    ...(retrieval.semantic.fallbackReason ? [`Semantic fallback:        ${retrieval.semantic.fallbackReason}`] : []),
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

function formatProject(diagnostics: RuntimeDiagnostics): string {
  const project = diagnostics.project;
  const revision = project.revision;
  const sync = project.lastSync;
  return [
    "DS4 Project Knowledge",
    "",
    `Status / trusted:          ${project.status} / ${project.trusted ? "yes" : "no"}`,
    `Project:                   ${project.projectPath ?? "not indexed"}`,
    `Git branch / HEAD:         ${revision?.branch ?? "n/a"} / ${revision?.head ?? "n/a"}`,
    `Working tree:              ${revision?.dirty ? "dirty" : "clean or non-git"}`,
    `Changed files:             ${count(revision?.changedFiles.length)}`,
    `Current / deleted files:   ${count(project.stats?.files)} / ${count(project.stats?.deletedFiles)}`,
    `Current / stale snippets:  ${count(project.stats?.currentSnippets)} / ${count(project.stats?.staleSnippets)}`,
    `Indexed snippet tokens:    ${count(project.stats?.indexedTokens)}`,
    `Last sync mode:            ${sync?.mode ?? "not run"}`,
    `Indexed / unchanged files: ${count(sync?.indexedFiles)} / ${count(sync?.unchangedFiles)}`,
    `Skipped large/binary/secret:${count(sync?.skippedLarge).padStart(7)} / ${count(sync?.skippedBinary)} / ${count(sync?.skippedSensitive)}`,
    `Query terms:               ${project.queryTerms.length > 0 ? project.queryTerms.join(", ") : "none"}`,
    `Candidates / duplicates:   ${count(project.candidateCount)} / ${count(project.duplicateCandidates)}`,
    `Lexical / vector / fused:  ${count(project.semantic.lexicalCandidates)} / ${count(project.semantic.vectorCandidates)} / ${count(project.semantic.fusedCandidates)}`,
    `Embedding model:           ${project.semantic.provider && project.semantic.model ? `${project.semantic.provider}/${project.semantic.model}` : "disabled"}`,
    `Embedding dimensions/mode: ${count(project.semantic.dimensions)} / ${project.semantic.destination ?? "n/a"}`,
    `Vector index/cache hit:    ${project.semantic.indexFresh ? "fresh" : "stale/unavailable"} / ${project.semantic.queryCacheHit ? "yes" : "no"}`,
    ...(project.semantic.fallbackReason ? [`Semantic fallback:         ${project.semantic.fallbackReason}`] : []),
    `Invalidated / reindexed:   ${count(project.invalidatedSnippets)} / ${count(project.reindexedFiles)}`,
    `Planner exclusions:        ${count(project.plannerExcludedCount)}`,
    `Selected / maximum tokens: ${count(project.selectedTokens)} / ${count(project.maxTokens)}`,
    `Index/retrieval duration:  ${sync?.durationMs.toFixed(3) ?? "n/a"} / ${project.durationMs.toFixed(3)} ms`,
    ...(project.fallbackReason ? [`Fallback:                  ${project.fallbackReason}`] : []),
    ...project.warnings.map((warning) => `Warning:                   ${warning}`),
    "",
    ...(project.selected.length === 0
      ? ["No project snippets were injected into the latest managed context."]
      : project.selected.flatMap((evidence, index) => [
          `${index + 1}. ${evidence.path}:${evidence.startLine}-${evidence.endLine} score=${evidence.score.toFixed(3)} tokens=${count(evidence.estimatedTokens)}${evidence.modified ? " modified" : ""}`,
          `   ${evidence.reason}`,
          `   ${evidence.excerpt.replace(/\s+/gu, " ").slice(0, 500)}${evidence.excerpt.length > 500 ? "…" : ""}`,
        ])),
  ].join("\n");
}

function formatPins(runtime: Ds4ContextRuntime): string {
  const pins = runtime.listPins(false);
  return [
    "DS4 Persistent Pins",
    "",
    ...(pins.length === 0
      ? ["No pins are available for this session/project."]
      : pins.map((pin, index) => [
          `${index + 1}. ${pin.id}  ${pin.scope}  ${pin.status} class=${pin.classification ?? "default"}${pin.supersededBy ? ` -> ${pin.supersededBy}` : ""}`,
          `   created=${new Date(pin.createdAt).toISOString()}${pin.branchLeafId ? ` branch=${pin.branchLeafId}` : ""}`,
          `   ${pin.content.slice(0, 500)}${pin.content.length > 500 ? "…" : ""}`,
          ...(pin.statusReason ? [`   reason: ${pin.statusReason}`] : []),
        ].join("\n"))),
    "",
    "Create: /context pin [--scope session|branch|project] [--classification LEVEL] [--source ENTRY] [--file PATH] <content>",
    "Replace: add --supersedes PIN_ID. Remove: /context unpin PIN_ID [reason]",
  ].join("\n");
}

function formatMemory(runtime: Ds4ContextRuntime, diagnostics: RuntimeDiagnostics): string {
  const memories = runtime.listMemories(false);
  return [
    "DS4 Durable Memory",
    "",
    `Status:                   ${diagnostics.memory.status}`,
    `Active / inactive:        ${count(diagnostics.memory.activeMemories)} / ${count(diagnostics.memory.inactiveMemories)}`,
    `Selected / excluded:      ${count(diagnostics.memory.selectedMemories.length)} / ${count(diagnostics.memory.excludedMemories)}`,
    `Selected tokens:          ${count(diagnostics.memory.selectedMemoryTokens)}`,
    `Cross-session:            ${diagnostics.memory.crossSession.status} (${count(diagnostics.memory.crossSession.contributingSessions)} contributing / ${count(diagnostics.memory.crossSession.discoveredSessions)} discovered)`,
    ...diagnostics.memory.warnings.map((warning) => `Warning:                  ${warning}`),
    "",
    ...(memories.length === 0
      ? ["No memory items are available for this session/project."]
      : memories.map((memory, index) => [
          `${index + 1}. ${memory.id}  ${memory.scope}  ${memory.status} class=${memory.classification ?? "default"}${memory.key ? ` key=${memory.key}` : ""}${memory.supersededBy ? ` -> ${memory.supersededBy}` : ""}`,
          `   sources=${memory.sourceEntryIds.join(",") || "mutation"}`,
          `   ${memory.claim.slice(0, 500)}${memory.claim.length > 500 ? "…" : ""}`,
          ...(memory.statusReason ? [`   reason: ${memory.statusReason}`] : []),
        ].join("\n"))),
    "",
    "Add: /context memory add [--scope session|project] [--classification LEVEL] [--key KEY] [--source ID,ID] <claim>",
    "Replace: /context memory supersede MEMORY_ID [--classification LEVEL] [--source ID,ID] <new claim>",
    "Invalidate/expire: /context memory invalidate|expire MEMORY_ID [reason]",
    "Sources: /context memory sources|exclude SESSION_ID [reason]|include SESSION_ID",
  ].join("\n");
}

function formatProjectMemorySources(runtime: Ds4ContextRuntime, diagnostics: RuntimeDiagnostics): string {
  const cross = diagnostics.memory.crossSession;
  const sources = runtime.projectMemorySources();
  return [
    "DS4 Cross-Session Project Memory Sources",
    "",
    `Enabled / status:         ${cross.enabled ? "yes" : "no"} / ${cross.status}`,
    `Discovered / contributing:${count(cross.discoveredSessions).padStart(8)} / ${count(cross.contributingSessions)}`,
    `Excluded / unavailable:  ${count(cross.excludedSessions).padStart(8)} / ${count(cross.unavailableSessions)}`,
    `Incremental / rebuilt:   ${count(cross.incrementalSessions).padStart(8)} / ${count(cross.rebuiltSessions)}`,
    ...cross.warnings.map((warning) => `Warning:                  ${warning}`),
    "",
    ...(sources.length === 0
      ? ["No project memory source sessions have been discovered."]
      : sources.map((source, index) => [
          `${index + 1}. ${source.sessionId}  ${source.status}  mutations=${count(source.indexedMutations)} active=${count(source.activeProjectMemories + source.activeProjectPins)}`,
          `   records=${count(source.indexedRecords)} malformed=${count(source.malformedLines)} file=${JSON.stringify(source.sessionFile)}`,
          ...(source.exclusionReason ? [`   exclusion: ${source.exclusionReason}`] : []),
          ...(source.lastError ? [`   error: ${source.lastError}`] : []),
        ].join("\n"))),
    "",
    "Exclude: /context memory exclude SESSION_ID [reason]",
    "Restore: /context memory include SESSION_ID",
  ].join("\n");
}

function formatPrivacy(diagnostics: RuntimeDiagnostics): string {
  const privacy = diagnostics.privacy;
  const selected = Object.entries(privacy.selectedClassifications)
    .map(([classification, value]) => `${classification}=${count(value)}`)
    .join(", ");
  return [
    "DS4 Privacy and Provider Policy",
    "",
    `Enabled:                    ${privacy.enabled ? "yes" : "no"}`,
    `Provider / destination:     ${privacy.provider ?? "n/a"} / ${privacy.destination ?? "n/a"}`,
    `Allowed classifications:    ${privacy.allowedClassifications.join(", ") || "none"}`,
    `Selected classifications:   ${selected}`,
    `Inspected messages:         ${count(privacy.inspectedMessages)}`,
    `Blocked classified blocks:  ${count(privacy.blockedBlocks)}`,
    `Excluded source slices:     ${count(privacy.excludedSources)}`,
    `Credential redactions:      ${count(privacy.secretRedactions)}`,
    `Provider final checks:      ${count(privacy.providerChecks)}`,
    `Provider payload redactions:${count(privacy.providerPayloadRedactions).padStart(8)}`,
    `Enforcement:                ${privacy.enforcement}`,
    ...privacy.warnings.map((warning) => `Warning:                    ${warning}`),
    "",
    "Classification markers: [ds4:local-only]...[/ds4:local-only] (also normal, internal, sensitive).",
    "Pin/memory commands accept --classification. Local-only is never permitted by a remote allow rule.",
  ].join("\n");
}

function formatModelAwareness(diagnostics: RuntimeDiagnostics): string {
  const awareness = diagnostics.modelAwareness;
  if (!awareness) return "No active model profile has been resolved for this session yet.";
  const calibration = awareness.calibration;
  const cache = calibration.cache;
  const usage = diagnostics.lastManifest?.providerUsage;
  const modelSwitch = awareness.switch;
  return [
    "DS4 Advanced Model Awareness",
    "",
    `Enabled:                    ${awareness.enabled ? "yes" : "no"}`,
    `Profile:                    ${awareness.profileKey}`,
    `Overrides:                  ${awareness.overrideKeys.join(", ") || "none"}`,
    `Context / max output:       ${count(awareness.contextWindow)} / ${count(awareness.maxOutputTokens)}`,
    `Safety margin:              ${count(awareness.safetyMarginTokens)}`,
    `Estimator:                  ${calibration.estimator}`,
    `Calibration ratio:          ${calibration.calibrated ? `x${calibration.appliedRatio.toFixed(6)}` : "x1.000000 (neutral)"}`,
    `Samples observed/accepted:  ${count(calibration.observedSamples)} / ${count(calibration.acceptedSamples)}`,
    `Samples rejected/outliers:  ${count(calibration.rejectedSamples)} / ${count(calibration.outlierSamples)}`,
    `Calibration bounds/window:  ${calibration.lowerRatioBound.toFixed(2)}-${calibration.upperRatioBound.toFixed(2)} / ${count(calibration.windowSize)}`,
    `Adaptive recent tail:       ${count(awareness.adaptive.recentTailTokens)} (nominal ${count(awareness.adaptive.nominalRecentTailTokens)})`,
    `Adaptive history retrieval: ${count(awareness.adaptive.maxRetrievedHistoryTokens)} (nominal ${count(awareness.adaptive.nominalRetrievedHistoryTokens)})`,
    `Adaptive project retrieval: ${count(awareness.adaptive.maxProjectTokens)} (nominal ${count(awareness.adaptive.nominalProjectTokens)})`,
    `Cache window read/write:     ${count(cache.cacheReadTokens)} / ${count(cache.cacheWriteTokens)}`,
    `Cache window shares:         ${(cache.cacheReadShare * 100).toFixed(2)}% read / ${(cache.cacheWriteShare * 100).toFixed(2)}% write`,
    `Latest input/cache read/write:${count(usage?.inputTokens).padStart(8)} / ${count(usage?.cacheReadTokens)} / ${count(usage?.cacheWriteTokens)}`,
    `Model switch:                ${modelSwitch ? `${modelSwitch.source}; ${modelSwitch.switched ? "cold model switch" : modelSwitch.cacheDisposition}; profile ${modelSwitch.profileReused ? "reused" : "new"}` : "n/a"}`,
    ...(modelSwitch?.previousProvider && modelSwitch.previousModel
      ? [`Previous profile:            ${modelSwitch.previousProvider}/${modelSwitch.previousModel}`]
      : []),
    "",
    "Calibration is isolated by exact provider/model and uses bounded median/MAD outlier rejection.",
    "Provider cache state is an optimization; Pi JSONL and DS4 provenance remain canonical.",
  ].join("\n");
}

function formatQuality(diagnostics: RuntimeDiagnostics): string {
  const quality = diagnostics.quality;
  const aggregate = quality.aggregate;
  const percentage = (rate: number | null): string => rate === null ? "n/a" : `${(rate * 100).toFixed(2)}%`;
  const reasonSummary = (reasons: Readonly<Record<string, number>>): string => {
    const entries = Object.entries(reasons);
    return entries.length > 0
      ? entries.map(([reason, total]) => `${reason}=${count(total)}`).join(", ")
      : "none";
  };
  const budgetLines = Object.entries(aggregate.budgetUtilization).map(([kind, budget]) =>
    `  ${kind.padEnd(12)} ${count(budget.selectedTokens)} / ${count(budget.limitTokens)} (${(budget.utilization * 100).toFixed(2)}%), dropped ${count(budget.droppedTokens)}`
  );
  return [
    "DS4 Context Quality",
    "",
    `Status:                    ${quality.enabled ? "enabled" : "disabled (opt-in)"}`,
    `Metrics version:           ${quality.metricsVersion}`,
    `Samples stored/labeled:    ${count(quality.storedSamples)} / ${count(aggregate.labeledSampleCount)}`,
    `Corrupt samples ignored:   ${count(quality.ignoredSamples)}`,
    `Primary quality score:     ${(aggregate.qualityScore * 100).toFixed(2)}%`,
    `Evidence recall:           ${percentage(aggregate.evidenceRecall.rate)} (${count(aggregate.evidenceRecall.numerator)}/${count(aggregate.evidenceRecall.denominator)})`,
    `Irrelevant-token ratio:    ${percentage(aggregate.irrelevantTokenRatio.rate)}`,
    `Duplicate references:      ${count(aggregate.duplicateEvidence.duplicateReferences)} / ${count(aggregate.duplicateEvidence.selectedReferences)}`,
    `Provenance coverage:       ${percentage(aggregate.provenanceCoverage.rate)}`,
    `Current request retained:  ${percentage(aggregate.currentRequestRetention.rate)}`,
    `Atomic groups valid:       ${percentage(aggregate.atomicGroupValidity.rate)}`,
    `Overflow / fallback rate:  ${percentage(aggregate.overflowRate.rate)} / ${percentage(aggregate.fallbackRate.rate)}`,
    `Selected / dropped tokens: ${count(aggregate.selectedTokens)} / ${count(aggregate.droppedTokens)}`,
    `Planning mean / p95:       ${quality.timing.meanPlanningDurationMs === undefined ? "n/a" : `${quality.timing.meanPlanningDurationMs.toFixed(3)} ms`} / ${quality.timing.p95PlanningDurationMs === undefined ? "n/a" : `${quality.timing.p95PlanningDurationMs.toFixed(3)} ms`}`,
    "Category budget utilization:",
    ...(budgetLines.length > 0 ? budgetLines : ["  no samples"]),
    `Selection reasons:         ${reasonSummary(aggregate.selectionReasons)}`,
    `Drop reasons:              ${reasonSummary(aggregate.dropReasons)}`,
    ...(quality.lastError ? [`Last quality warning:       ${quality.lastError}`] : []),
    "",
    "Quality storage contains counts, versions, labels and timings only; prompt and evidence text are never persisted.",
  ].join("\n");
}

function formatRanking(diagnostics: RuntimeDiagnostics): string {
  const ranking = diagnostics.ranking;
  return [
    "DS4 Learned Ranking",
    "",
    `Mode / status:             ${ranking.mode} / ${ranking.status}`,
    `Feature schema:            ${ranking.featureVersion}`,
    `Model:                     ${ranking.modelId ?? "unavailable"}`,
    `Model path:                ${ranking.modelPath ?? "unavailable"}`,
    `Loaded / promoted:         ${ranking.modelLoaded ? "yes" : "no"} / ${ranking.promoted ? "yes" : "no"}`,
    `Training samples:          ${count(ranking.trainingSamples)}`,
    `Malformed / duplicate:     ${count(ranking.malformedFeedback)} / ${count(ranking.duplicateFeedback)}`,
    `Latest candidates:         ${count(ranking.candidateCount)}`,
    `Top changed in shadow:     ${ranking.topChanged ? "yes" : "no"}`,
    `Pairwise disagreements:    ${count(ranking.pairwiseDisagreements)}`,
    `Mean rank shift:           ${ranking.meanRankShift.toFixed(6)}`,
    `Inference duration:        ${ranking.durationMs.toFixed(3)} ms`,
    ...(ranking.fallbackReason ? [`Static fallback:            ${ranking.fallbackReason}`] : []),
    ...ranking.warnings.map((warning) => `Warning:                    ${warning}`),
    "",
    "Feedback stores only bounded numeric features, hashes, label, version, and classification in Pi JSONL.",
    "Shadow mode records aggregate comparison only and never changes selected context.",
  ].join("\n");
}

function formatNativeContinuation(diagnostics: RuntimeDiagnostics): string {
  const continuation = diagnostics.nativeContinuation;
  const latest = continuation.last;
  return [
    "DS4 Optional Native Continuation",
    "",
    `Enabled / storage consent: ${continuation.enabled ? "yes" : "no"} / ${continuation.allowProviderStorage ? "yes" : "no"}`,
    `Strategy:                  ${continuation.strategy}`,
    `Status / state:            ${continuation.status} / ${continuation.stateAvailable ? "ready" : "cold"}`,
    `Profiles:                  ${continuation.profiles.join(", ") || "none"}`,
    `Provider wrappers:         ${continuation.registeredProviders.join(", ") || "none"}`,
    `Requests full/native:      ${count(continuation.fullReplayRequests)} / ${count(continuation.continuationRequests)}`,
    `Native successes:          ${count(continuation.continuationSuccesses)}`,
    `Invalidations:             ${count(continuation.invalidations)}`,
    `Retry attempts/success/fail:${count(continuation.retryAttempts).padStart(7)} / ${count(continuation.retrySuccesses)} / ${count(continuation.retryFailures)}`,
    `Latest provider/model:     ${continuation.lastProvider && continuation.lastModel ? `${continuation.lastProvider}/${continuation.lastModel}` : "n/a"}`,
    `Latest mode:               ${latest?.mode ?? "n/a"}`,
    `Latest full/sent/omitted:  ${count(latest?.fullInputItems)} / ${count(latest?.sentInputItems)} / ${count(latest?.omittedInputItems)}`,
    `Latest retry:              ${latest?.retry ?? "n/a"}`,
    ...(latest?.stateAgeMs !== undefined ? [`Latest state age:          ${count(latest.stateAgeMs)} ms`] : []),
    ...(latest?.fallbackReason ? [`Latest fallback:           ${latest.fallbackReason}`] : []),
    ...(latest?.invalidationReason ? [`Latest invalidation:       ${latest.invalidationReason}`] : []),
    ...continuation.warnings.map((warning) => `Warning:                    ${warning}`),
    "",
    "Provider response IDs and payload content are never included in these diagnostics or Context Manifests.",
    "Eligible OpenAI Responses calls use store=true only after explicit configuration consent.",
  ].join("\n");
}

function formatArtifacts(diagnostics: RuntimeDiagnostics): string {
  const artifacts = diagnostics.artifacts;
  return [
    "DS4 Artifact Store",
    "",
    `Enabled:                  ${artifacts.enabled ? "yes" : "no"}`,
    `Store:                    ${artifacts.storePath ?? "unavailable"}`,
    `Objects / references:     ${count(artifacts.stats.objects)} / ${count(artifacts.stats.references)}`,
    `Stored bytes:             ${count(artifacts.stats.bytes)}`,
    `Missing / corrupt:        ${count(artifacts.stats.missing)} / ${count(artifacts.stats.corrupt)}`,
    `Current branch references:${count(artifacts.currentBranchReferences).padStart(8)}`,
    `Latest offloaded:         ${count(artifacts.offloadedCount)}`,
    `Latest bytes offloaded:   ${count(artifacts.offloadedBytes)}`,
    `Estimated tokens saved:   ${count(artifacts.estimatedTokensSaved)}`,
    `Latest failures:          ${count(artifacts.failedCount)}`,
    ...artifacts.warnings.map((warning) => `Warning:                  ${warning}`),
    "",
    ...(artifacts.references.length === 0
      ? ["No artifacts are referenced by the active branch."]
      : artifacts.references.slice(0, 50).map((artifact, index) =>
          `${index + 1}. ${artifact.artifactId}  ${JSON.stringify(artifact.toolName)}/${JSON.stringify(artifact.toolCallId)}  ${count(artifact.sizeBytes)} bytes  ${artifact.originalTokens}->${artifact.condensedTokens} tokens  ${artifact.mimeType}${artifact.isError ? " error" : ""}`
        )),
    ...(artifacts.references.length > 50 ? [`... ${artifacts.references.length - 50} older reference(s) omitted`] : []),
    "",
    "Use context_artifact_search with an Artifact ID and a narrow literal query.",
  ].join("\n");
}

function formatAdapter(diagnostics: RuntimeDiagnostics): string {
  const negotiation = diagnostics.adapter;
  return [
    "DS4 Runtime Adapter",
    "",
    `Runtime:             Pi`,
    `Contract:            ${negotiation.contractVersion}`,
    `Enabled requested:   ${count(negotiation.enabled.length)}`,
    `Disabled requested:  ${count(negotiation.disabled.length)}`,
    "",
    ...negotiation.statuses.map((status) =>
      `${status.id}: ${status.supported ? `supported (${status.version ?? "unversioned"})` : `unavailable (${status.reason ?? "no reason"})`}; ${status.enabled ? "enabled" : status.requested ? "disabled safely" : "not requested"}`
    ),
    ...(negotiation.diagnostics.length > 0
      ? ["", ...negotiation.diagnostics.map((diagnostic) =>
          `${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`
        )]
      : []),
  ].join("\n");
}

function formatStorage(storage: StorageDiagnostics, databasePath?: string): string {
  if (storage.status === "unavailable") {
    return [
      "DS4 Storage",
      "",
      "Status:                     unavailable",
      `Database:                   ${databasePath ?? "unavailable"}`,
      "Pi fallback remains active; no storage mutation was attempted.",
    ].join("\n");
  }
  return [
    "DS4 Storage",
    "",
    `Status:                     ${storage.status}`,
    `Database:                   ${databasePath ?? "unavailable"}`,
    `Schema / journal:           ${storage.schemaVersion ?? "n/a"} / ${storage.journalMode ?? "n/a"}`,
    `Database / WAL / SHM:       ${bytes(storage.databaseBytes)} / ${bytes(storage.walBytes)} / ${bytes(storage.shmBytes)}`,
    `Allocated / reusable:       ${bytes(storage.allocatedBytes)} / ${bytes(storage.reusableBytes)}`,
    `Pages total / reusable:     ${count(storage.pageCount)} / ${count(storage.freePages)}`,
    `Manifests:                  ${count(storage.manifests.rows)} / target ${count(storage.manifests.retainedLimit)}`,
    `Manifest payload:           ${bytes(storage.manifests.serializedBytes)}`,
    `Rolled-up manifests:        ${count(storage.manifests.rolledUpRows)}`,
    `Calibration samples/profiles: ${count(storage.calibration.rows)} / ${count(storage.calibration.profiles)} (limit ${count(storage.calibration.retainedPerProfile)}/profile)`,
    `Sessions:                   ${count(storage.sessions)}`,
    `Artifact objects / refs:    ${count(storage.artifacts.objects)} / ${count(storage.artifacts.references)}`,
    `Artifact bytes:             ${bytes(storage.artifacts.bytes)}`,
    ...(storage.activeProject ? [
      `Active project files:       ${count(storage.activeProject.files)}`,
      `Project snippets/stale:     ${count(storage.activeProject.snippets)} / ${count(storage.activeProject.staleSnippets)}`,
      `Project indexed tokens:     ${count(storage.activeProject.indexedTokens)}`,
    ] : []),
    `Retention converged:        ${storage.retention.converged ? "yes" : "no"}`,
    `Offline maintenance:       ${storage.maintenance.recommended ? "recommended" : "not required"}`,
    ...storage.maintenance.reasons.map((reason) => `Reason:                     ${reason}`),
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
    `Compaction model:        ${compaction.provider && compaction.model ? `${compaction.provider}/${compaction.model}` : "n/a"}`,
    `Chosen path:             ${compaction.path ?? "n/a"}`,
    `Input budget mode:       ${compaction.inputBudgetMode ?? "n/a"}`,
    `Input budget:            ${count(compaction.inputBudgetTokens)}`,
    `Whole-source prompt:     ${count(compaction.sourcePromptTokens)}`,
    `Direct-update prompt:    ${count(compaction.directPromptTokens)}`,
    `Segment concurrency cap: ${count(compaction.maxConcurrentSegments)}`,
    `Summary calls:           ${count(compaction.summaryCalls)}`,
    `Generated segments:      ${count(compaction.segmentCount)}`,
    `Aggregate calls:         ${count(compaction.aggregateCalls)}`,
    `Transport retries:       ${count(compaction.transportRetries)}`,
    ...(compaction.timings ? [
      `DS4 hook time (ms):      ${compaction.timings.totalMs.toFixed(1)}`,
      `Prepare/generate (ms):   ${compaction.timings.preparationMs.toFixed(1)} / ${compaction.timings.generationMs.toFixed(1)}`,
      `Aggregate/persist (ms):  ${compaction.timings.aggregationMs.toFixed(1)} / ${compaction.timings.persistenceMs.toFixed(1)}`,
    ] : []),
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
      const parsedCommand = splitCommand(args, "status");
      const subcommand = parsedCommand.command;
      const subcommandArgs = parsedCommand.args;

      try {
        if (subcommand === "status") {
          const diagnostics = runtime.diagnostics(ctx);
          const level = diagnostics.phase === "degraded" ? "warning" : "info";
          present(ctx, formatStatus(diagnostics), level);
          return;
        }

        if (subcommand === "config") {
          const nested = splitCommand(subcommandArgs, "show");
          if (nested.command === "set") {
            const parsed = parseCommandArgs(nested.args);
            assertOptions(parsed.options, ["global"]);
            const path = parsed.positionals[0];
            if (!path || parsed.positionals.length < 2) {
              throw new Error("Usage: /context config set <path> <value> [--global]");
            }
            const rawValue = parsed.positionals.slice(1).join(" ");
            const result = runtime.setConfigValue(
              path,
              rawValue,
              parsed.options.has("global") ? "global" : "project",
              { projectTrusted: ctx.isProjectTrusted(), cwd: ctx.cwd },
            );
            present(ctx, [
              `Set ${path} = ${result.value} in ${result.file} (${result.global ? "global" : "project"} configuration).`,
              "The active session keeps the previous configuration; the change applies when the next Pi session starts.",
              ...(result.warnings.length > 0
                ? ["", ...result.warnings.map((warning) => `Warning: ${warning}`)]
                : []),
            ].join("\n"));
            return;
          }
          if (nested.command === "unset") {
            const parsed = parseCommandArgs(nested.args);
            assertOptions(parsed.options, ["global"]);
            const path = parsed.positionals[0];
            if (!path || parsed.positionals.length > 1) {
              throw new Error("Usage: /context config unset <path> [--global]");
            }
            const result = runtime.unsetConfigValue(
              path,
              parsed.options.has("global") ? "global" : "project",
              { projectTrusted: ctx.isProjectTrusted(), cwd: ctx.cwd },
            );
            present(ctx, [
              `Unset ${path} in ${result.file} (${result.global ? "global" : "project"} configuration).`,
              "The active session keeps the previous configuration; the change applies when the next Pi session starts.",
              ...(result.warnings.length > 0
                ? ["", ...result.warnings.map((warning) => `Warning: ${warning}`)]
                : []),
            ].join("\n"));
            return;
          }
          if (nested.command !== "show") {
            throw new Error("Usage: /context config [show|set|unset] (show is the default)");
          }
          present(ctx, formatConfig(runtime.configSnapshot()));
          return;
        }

        if (subcommand === "adapter") {
          present(ctx, formatAdapter(runtime.diagnostics(ctx)));
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

        if (subcommand === "project") {
          present(ctx, formatProject(runtime.diagnostics(ctx)));
          return;
        }

        if (subcommand === "pins") {
          present(ctx, formatPins(runtime));
          return;
        }

        if (subcommand === "pin") {
          const parsed = parseCommandArgs(subcommandArgs);
          assertOptions(parsed.options, ["scope", "source", "file", "supersedes", "classification"]);
          const scope = (parsed.options.get("scope") ?? "session").toLowerCase();
          const classification = classificationOption(parsed.options.get("classification"));
          if (scope !== "session" && scope !== "branch" && scope !== "project") {
            throw new Error("Pin scope must be session, branch, or project");
          }
          const result = runtime.createPin({
            content: parsed.positionals.join(" "),
            scope,
            ...(parsed.options.get("source") ? { sourceEntryId: parsed.options.get("source") } : {}),
            ...(parsed.options.get("file") ? { sourceFile: parsed.options.get("file") } : {}),
            ...(parsed.options.get("supersedes") ? { supersedes: parsed.options.get("supersedes") } : {}),
            ...(classification ? { classification } : {}),
          }, ctx, (customType, data) => pi.appendEntry(customType, data));
          present(
            ctx,
            `${result.duplicate ? "Existing" : "Created"} ${result.pin.scope} pin ${result.pin.id}`,
          );
          return;
        }

        if (subcommand === "unpin") {
          const parsed = parseCommandArgs(subcommandArgs);
          assertOptions(parsed.options, []);
          const pinId = parsed.positionals[0];
          if (!pinId) throw new Error("Usage: /context unpin PIN_ID [reason]");
          const pin = runtime.unpin(
            pinId,
            parsed.positionals.slice(1).join(" ") || undefined,
            ctx,
            (customType, data) => pi.appendEntry(customType, data),
          );
          present(ctx, `Pin ${pin.id} is ${pin.status}`);
          return;
        }

        if (subcommand === "memory") {
          const nested = splitCommand(subcommandArgs, "list");
          if (nested.command === "list") {
            present(ctx, formatMemory(runtime, runtime.diagnostics(ctx)));
            return;
          }
          if (nested.command === "sources") {
            present(ctx, formatProjectMemorySources(runtime, runtime.diagnostics(ctx)));
            return;
          }
          const parsed = parseCommandArgs(nested.args);
          if (nested.command === "exclude" || nested.command === "include") {
            assertOptions(parsed.options, []);
            const sessionId = parsed.positionals[0];
            if (!sessionId) {
              throw new Error(`Usage: /context memory ${nested.command} SESSION_ID${nested.command === "exclude" ? " [reason]" : ""}`);
            }
            runtime.setProjectMemorySourceExcluded(
              sessionId,
              nested.command === "exclude",
              nested.command === "exclude"
                ? parsed.positionals.slice(1).join(" ") || undefined
                : undefined,
            );
            present(ctx, `Project memory source ${sessionId} ${nested.command === "exclude" ? "excluded" : "restored"}`);
            return;
          }
          if (nested.command === "add") {
            assertOptions(parsed.options, ["scope", "key", "source", "classification"]);
            const scope = (parsed.options.get("scope") ?? "session").toLowerCase();
            const classification = classificationOption(parsed.options.get("classification"));
            if (scope !== "session" && scope !== "project") {
              throw new Error("Memory scope must be session or project");
            }
            const result = runtime.createMemory({
              claim: parsed.positionals.join(" "),
              scope,
              ...(parsed.options.get("key") ? { key: parsed.options.get("key") } : {}),
              ...(classification ? { classification } : {}),
              sourceEntryIds: sourceIds(parsed.options.get("source")),
            }, ctx, (customType, data) => pi.appendEntry(customType, data));
            present(
              ctx,
              `${result.duplicate ? "Existing" : "Created"} ${result.memory.scope} memory ${result.memory.id}`,
            );
            return;
          }
          if (nested.command === "supersede") {
            assertOptions(parsed.options, ["source", "classification"]);
            const previousId = parsed.positionals[0];
            const claim = parsed.positionals.slice(1).join(" ");
            if (!previousId || !claim) {
              throw new Error("Usage: /context memory supersede MEMORY_ID [--source ID,ID] <new claim>");
            }
            const memory = runtime.supersedeMemory(
              previousId,
              claim,
              sourceIds(parsed.options.get("source")),
              classificationOption(parsed.options.get("classification")),
              ctx,
              (customType, data) => pi.appendEntry(customType, data),
            );
            present(ctx, `Memory ${previousId} superseded by ${memory.id}`);
            return;
          }
          if (nested.command === "invalidate" || nested.command === "expire") {
            assertOptions(parsed.options, []);
            const memoryId = parsed.positionals[0];
            if (!memoryId) throw new Error(`Usage: /context memory ${nested.command} MEMORY_ID [reason]`);
            const memory = runtime.setMemoryStatus(
              memoryId,
              nested.command === "invalidate" ? "invalid" : "expired",
              parsed.positionals.slice(1).join(" ") || undefined,
              ctx,
              (customType, data) => pi.appendEntry(customType, data),
            );
            present(ctx, `Memory ${memory.id} is ${memory.status}`);
            return;
          }
          throw new Error("Usage: /context memory [list|sources|exclude|include|add|supersede|invalidate|expire]");
        }

        if (subcommand === "privacy") {
          present(ctx, formatPrivacy(runtime.diagnostics(ctx)));
          return;
        }

        if (subcommand === "model") {
          present(ctx, formatModelAwareness(runtime.diagnostics(ctx)));
          return;
        }

        if (subcommand === "quality") {
          present(ctx, formatQuality(runtime.diagnostics(ctx)));
          return;
        }

        if (subcommand === "ranking") {
          const nested = splitCommand(subcommandArgs, "status");
          if (nested.command === "status") {
            if (nested.args.trim()) throw new Error("Usage: /context ranking [status|feedback|train]");
            present(ctx, formatRanking(runtime.diagnostics(ctx)));
            return;
          }
          if (nested.command === "feedback") {
            const parsed = parseCommandArgs(nested.args);
            assertOptions(parsed.options, ["classification"]);
            const label = parsed.positionals[0];
            const candidateId = parsed.positionals[1];
            if ((label !== "useful" && label !== "irrelevant") || !candidateId || parsed.positionals.length !== 2) {
              throw new Error("Usage: /context ranking feedback useful|irrelevant CANDIDATE_ID [--classification CLASS]");
            }
            const feedback = runtime.recordRankingFeedback(
              candidateId,
              label,
              classificationOption(parsed.options.get("classification")),
              ctx,
              (customType, data) => pi.appendEntry(customType, data),
            );
            present(ctx, `Ranking feedback ${feedback.feedbackId} recorded as ${feedback.label} (${feedback.classification})`);
            return;
          }
          if (nested.command === "train") {
            if (nested.args.trim()) throw new Error("Usage: /context ranking train");
            await ctx.waitForIdle();
            const result = runtime.trainRankingModel(ctx);
            present(ctx, [
              "DS4 Ranking Model Trained",
              "",
              `Model:              ${result.modelId}`,
              `Samples:            ${count(result.sampleCount)} (${count(result.positiveSamples)} useful / ${count(result.negativeSamples)} irrelevant)`,
              `Repositories:       ${count(result.repositoryCount)}`,
              `Artifact:           ${result.modelPath}`,
              ...(result.warnings.length > 0 ? [`Warnings:           ${result.warnings.length}`] : []),
              "Active mode remains gated until held-out promotion succeeds.",
            ].join("\n"));
            return;
          }
          throw new Error("Usage: /context ranking [status|feedback|train]");
        }

        if (subcommand === "continuation") {
          present(ctx, formatNativeContinuation(runtime.diagnostics(ctx)));
          return;
        }

        if (subcommand === "artifacts") {
          present(ctx, formatArtifacts(runtime.diagnostics(ctx)));
          return;
        }

        if (subcommand === "compaction" || subcommand === "compact-preview") {
          present(ctx, formatCompaction(runtime.diagnostics(ctx), subcommand === "compact-preview"));
          return;
        }

        if (subcommand === "storage") {
          const diagnostics = runtime.diagnostics(ctx);
          const storage = runtime.storageDiagnostics();
          present(
            ctx,
            formatStorage(storage, diagnostics.databasePath),
            storage.status === "ok" ? "info" : "warning",
          );
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
              `Project files:       ${count(runtime.diagnostics(ctx).project.stats?.files)}`,
              `Project snippets:    ${count(runtime.diagnostics(ctx).project.stats?.currentSnippets)}`,
              `Pins / memories:     ${count(runtime.diagnostics(ctx).memory.activePins)} / ${count(runtime.diagnostics(ctx).memory.activeMemories)}`,
              `Artifact references: ${count(runtime.diagnostics(ctx).artifacts.stats.references)}`,
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
          runtime.verifyArtifactHealth(ctx);
          const diagnostics = runtime.diagnostics(ctx);
          const storage = runtime.storageDiagnostics();
          const staleProjectSnippets = diagnostics.project.stats?.staleSnippets ?? 0;
          const artifactIntegrityIssues = diagnostics.artifacts.stats.missing + diagnostics.artifacts.stats.corrupt;
          const healthy = health.ok
            && staleProjectSnippets === 0
            && diagnostics.project.status !== "failed"
            && diagnostics.memory.status !== "failed"
            && diagnostics.memory.warnings.length === 0
            && diagnostics.privacy.warnings.length === 0
            && diagnostics.nativeContinuation.warnings.length === 0
            && diagnostics.quality.ignoredSamples === 0
            && diagnostics.quality.lastError === undefined
            && diagnostics.ranking.warnings.length === 0
            && artifactIntegrityIssues === 0
            && diagnostics.artifacts.warnings.length === 0
            && storage.status === "ok";
          present(
            ctx,
            [
              "DS4 Context Engine Health",
              "",
              `Status:              ${healthy ? "OK" : "WARN"}`,
              `SQLite quick_check:  ${health.quickCheck}`,
              `Journal mode:        ${health.journalMode}`,
              `Foreign keys:        ${health.foreignKeys ? "enabled" : "disabled"}`,
              `Schema version:      ${health.schemaVersion}`,
              `Applied migrations:  ${health.appliedMigrations}`,
              `Storage status:      ${storage.status}`,
              `Maintenance recommended: ${storage.maintenance.recommended ? "yes" : "no"}`,
              `Project stale snippets: ${count(staleProjectSnippets)}`,
              `Memory/pin warnings: ${count(diagnostics.memory.warnings.length)}`,
              `Privacy enforcement:  ${diagnostics.privacy.enforcement}`,
              `Privacy warnings:     ${count(diagnostics.privacy.warnings.length)}`,
              `Continuation warnings: ${count(diagnostics.nativeContinuation.warnings.length)}`,
              `Quality samples/ignored: ${count(diagnostics.quality.storedSamples)} / ${count(diagnostics.quality.ignoredSamples)}`,
              `Quality warning:         ${diagnostics.quality.lastError ?? "none"}`,
              `Ranking status/warnings:  ${diagnostics.ranking.status} / ${count(diagnostics.ranking.warnings.length)}`,
              `Artifact missing/corrupt: ${count(diagnostics.artifacts.stats.missing)} / ${count(diagnostics.artifacts.stats.corrupt)}`,
              `Artifact warnings:     ${count(diagnostics.artifacts.warnings.length)}`,
            ].join("\n"),
            healthy ? "info" : "warning",
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
