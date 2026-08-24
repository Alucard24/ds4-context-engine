import {
  sessionEntryToContextMessages,
  type ContextEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ContextConfig } from "../config/config.ts";
import { calculateContextBudget } from "../core/budget-manager.ts";
import { createModelProfile } from "../core/model-profile.ts";
import { estimateMessageTokens } from "../core/token-estimator.ts";
import {
  buildObserverManifest,
  type ExcludedContextSource,
  type ObservedMessageSource,
  type ObservedTool,
} from "../manifest/observer.ts";
import type { ContextManifest, ContextManifestItemKind } from "../manifest/context-manifest.ts";
import { sha256 } from "../shared/hash.ts";
import { stableStringify } from "../shared/stable-json.ts";
import { snapshotModel, snapshotSession } from "./session-reader.ts";

interface SourceCandidate {
  entry: SessionEntry;
  message: unknown;
  fingerprint: string;
  role?: string;
  tokens: number;
  used: boolean;
}

export interface BuildPiObserverManifestOptions {
  pi: ExtensionAPI;
  event: ContextEvent;
  ctx: ExtensionContext;
  contextConfig: ContextConfig;
  manifestId: string;
  createdAt: number;
  policyVersion: string;
  plannerVersion: string;
}

function roleOf(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || !("role" in message)) return undefined;
  return typeof message.role === "string" ? message.role : undefined;
}

function sourceKind(entry: SessionEntry, role?: string): ContextManifestItemKind {
  if (entry.type === "compaction" || entry.type === "branch_summary" || role === "compactionSummary" || role === "branchSummary") {
    return "summary";
  }
  return "history";
}

function fingerprint(message: unknown): string {
  return sha256(stableStringify(message));
}

function sourceCandidates(entries: readonly SessionEntry[]): SourceCandidate[] {
  const candidates: SourceCandidate[] = [];
  for (const entry of entries) {
    for (const message of sessionEntryToContextMessages(entry)) {
      candidates.push({
        entry,
        message,
        fingerprint: fingerprint(message),
        ...(roleOf(message) ? { role: roleOf(message) } : {}),
        tokens: estimateMessageTokens(message),
        used: false,
      });
    }
  }
  return candidates;
}

function mapMessageSources(messages: readonly unknown[], candidates: SourceCandidate[]): ObservedMessageSource[] {
  const queues = new Map<string, SourceCandidate[]>();
  for (const candidate of candidates) {
    const queue = queues.get(candidate.fingerprint) ?? [];
    queue.push(candidate);
    queues.set(candidate.fingerprint, queue);
  }

  return messages.map((message) => {
    const exact = queues.get(fingerprint(message))?.find((candidate) => !candidate.used);
    if (exact) {
      exact.used = true;
      return {
        sourceId: exact.entry.id,
        ...(exact.role ? { role: exact.role } : {}),
        mappingReason: "Exact fingerprint match to Pi session entry",
      };
    }

    const role = roleOf(message);
    const fallback = candidates.find((candidate) => !candidate.used && candidate.role === role);
    if (fallback) {
      fallback.used = true;
      return {
        sourceId: fallback.entry.id,
        ...(role ? { role } : {}),
        mappingReason: "Role/order match after an earlier context extension transformed the message",
      };
    }

    return {
      ...(role ? { role } : {}),
      mappingReason: "Transient or extension-injected message without a Pi session entry",
    };
  });
}

function excludedSources(
  branchEntries: readonly SessionEntry[],
  contextEntries: readonly SessionEntry[],
  candidates: readonly SourceCandidate[],
): ExcludedContextSource[] {
  const activeIds = new Set(contextEntries.map((entry) => entry.id));
  const excluded: ExcludedContextSource[] = [];

  for (const entry of branchEntries) {
    if (!activeIds.has(entry.id)) {
      const messages = sessionEntryToContextMessages(entry);
      excluded.push({
        sourceId: entry.id,
        ...(roleOf(messages[0]) ? { role: roleOf(messages[0]) } : {}),
        tokens: messages.reduce((total, message) => total + estimateMessageTokens(message), 0),
        kind: sourceKind(entry, roleOf(messages[0])),
        reason: "Excluded by Pi branch/compaction context reconstruction",
      });
      continue;
    }

    if (sessionEntryToContextMessages(entry).length === 0) {
      excluded.push({
        sourceId: entry.id,
        tokens: 0,
        kind: sourceKind(entry),
        reason: "Pi session metadata entry does not participate in model context",
      });
    }
  }

  for (const candidate of candidates) {
    if (candidate.used) continue;
    excluded.push({
      sourceId: candidate.entry.id,
      ...(candidate.role ? { role: candidate.role } : {}),
      tokens: candidate.tokens,
      kind: sourceKind(candidate.entry, candidate.role),
      reason: "Message was removed by an earlier Pi context extension",
    });
  }

  return excluded;
}

function activeTools(pi: ExtensionAPI): ObservedTool[] {
  const allTools = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
  return pi.getActiveTools().flatMap((name) => {
    const tool = allTools.get(name);
    if (!tool) return [];
    return [{
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      source: tool.sourceInfo.source,
    }];
  });
}

export function buildPiObserverManifest(options: BuildPiObserverManifestOptions): ContextManifest {
  const session = snapshotSession(options.ctx);
  const model = snapshotModel(options.ctx);
  if (!model) throw new Error("Cannot build a Context Manifest without an active Pi model");

  const profile = createModelProfile(model);
  const budget = calculateContextBudget(profile, options.contextConfig);
  const contextEntries = options.ctx.sessionManager.buildContextEntries();
  const candidates = sourceCandidates(contextEntries);
  const messageSources = mapMessageSources(options.event.messages, candidates);
  const usage = options.ctx.getContextUsage();

  return buildObserverManifest({
    id: options.manifestId,
    sessionId: session.sessionId,
    ...(session.leafId ? { branchLeafId: session.leafId } : {}),
    profile,
    budget,
    systemPrompt: options.ctx.getSystemPrompt(),
    tools: activeTools(options.pi),
    messages: options.event.messages,
    messageSources,
    excludedSources: excludedSources(
      options.ctx.sessionManager.getBranch(),
      contextEntries,
      candidates,
    ),
    summaryIds: contextEntries
      .filter((entry) => entry.type === "compaction" || entry.type === "branch_summary")
      .map((entry) => entry.id),
    ...(usage?.tokens !== null && usage?.tokens !== undefined
      ? { piReportedContextTokens: usage.tokens }
      : {}),
    policyVersion: options.policyVersion,
    plannerVersion: options.plannerVersion,
    createdAt: options.createdAt,
  });
}
