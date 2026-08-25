import type {
  ContextManifest,
  ContextManifestItem,
  ContextManifestItemKind,
} from "../manifest/context-manifest.ts";
import { sha256 } from "../shared/hash.ts";

export const CONTEXT_QUALITY_SCHEMA_VERSION = 1 as const;
export const CONTEXT_QUALITY_METRICS_VERSION = "context-quality-v1";
export const LIVE_QUALITY_CORPUS_VERSION = "live-observation-v1";
export const STATIC_RANKING_STRATEGY_ID = "static-ranking-v0.1";
export const CANDIDATE_RANKING_STRATEGY_ID = "task-weighted-v0.2-candidate";

const RATE_SCALE = 1_000_000;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const REASON_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/u;

export interface QualityTaskDescriptor {
  taskId: string;
  taskType: string;
  queryTags: string[];
}

export interface QualityReplayCandidate {
  id: string;
  kind: ContextManifestItemKind;
  tokens: number;
  groupId: string;
  sourceIds: string[];
  staticScore: number;
  candidateScore?: number;
  currentRequest?: boolean;
  provenanceRequired?: boolean;
}

export interface QualityReplayFixture {
  schemaVersion: 1;
  corpusVersion: string;
  sampleId: string;
  plannerVersion: string;
  profileKey: string;
  task: QualityTaskDescriptor;
  expectedEvidenceSourceIds: string[];
  candidates: QualityReplayCandidate[];
  totalBudgetTokens: number;
  categoryBudgets: Partial<Record<ContextManifestItemKind, number>>;
  outcomeLabels?: string[];
}

export interface QualityReplayCorpus {
  schemaVersion: 1;
  corpusVersion: string;
  description: string;
  fixtures: QualityReplayFixture[];
}

export interface QualityPlanDecision {
  selectedCandidateIds: string[];
  selectionReasons: Record<string, string>;
  dropReasons: Record<string, string>;
  fallback: boolean;
  overflow: boolean;
}

export interface QualityStrategy {
  id: string;
  plan(fixture: QualityReplayFixture): QualityPlanDecision;
}

export interface QualityCountRate {
  numerator: number;
  denominator: number;
  rate: number | null;
}

export interface QualityBudgetUtilization {
  limitTokens: number;
  selectedTokens: number;
  droppedTokens: number;
  utilization: number;
}

export interface QualitySourceKindCount {
  available: number;
  selected: number;
  dropped: number;
}

export interface ContextQualityMetrics {
  evidenceRecall: QualityCountRate;
  irrelevantTokenRatio: QualityCountRate;
  duplicateEvidence: { duplicateReferences: number; selectedReferences: number };
  provenanceCoverage: QualityCountRate;
  currentRequestRetention: QualityCountRate;
  atomicGroupValidity: QualityCountRate;
  overflow: boolean;
  fallback: boolean;
  qualityScore: number;
  selectedTokens: number;
  droppedTokens: number;
  sourceKindCounts: Partial<Record<ContextManifestItemKind, QualitySourceKindCount>>;
  budgetUtilization: Partial<Record<ContextManifestItemKind, QualityBudgetUtilization>>;
  selectionReasons: Record<string, number>;
  dropReasons: Record<string, number>;
}

export interface ContextQualitySample {
  schemaVersion: 1;
  metricsVersion: string;
  sampleId: string;
  corpusVersion: string;
  strategyId: string;
  plannerVersion: string;
  profileKey: string;
  outcomeLabels: string[];
  metrics: ContextQualityMetrics;
  timing?: { planningDurationMs: number };
}

export interface ContextQualityAggregate {
  schemaVersion: 1;
  metricsVersion: string;
  sampleCount: number;
  labeledSampleCount: number;
  strategyIds: string[];
  plannerVersions: string[];
  profileKeys: string[];
  outcomeLabels: Record<string, number>;
  evidenceRecall: QualityCountRate;
  irrelevantTokenRatio: QualityCountRate;
  duplicateEvidence: { duplicateReferences: number; selectedReferences: number };
  provenanceCoverage: QualityCountRate;
  currentRequestRetention: QualityCountRate;
  atomicGroupValidity: QualityCountRate;
  overflowRate: QualityCountRate;
  fallbackRate: QualityCountRate;
  qualityScore: number;
  selectedTokens: number;
  droppedTokens: number;
  sourceKindCounts: Partial<Record<ContextManifestItemKind, QualitySourceKindCount>>;
  budgetUtilization: Partial<Record<ContextManifestItemKind, QualityBudgetUtilization>>;
  selectionReasons: Record<string, number>;
  dropReasons: Record<string, number>;
}

export interface ContextQualityComparison {
  schemaVersion: 1;
  metricsVersion: string;
  corpusVersion: string;
  fixtureCount: number;
  strategies: Array<{
    strategyId: string;
    aggregate: ContextQualityAggregate;
  }>;
  deltasFromBaseline: Array<{
    strategyId: string;
    qualityScore: number;
    evidenceRecall: number;
    irrelevantTokenRatio: number;
    fallbackRate: number;
  }>;
}

export interface ContextQualityDiagnostics {
  enabled: boolean;
  metricsVersion: string;
  storedSamples: number;
  ignoredSamples: number;
  aggregate: ContextQualityAggregate;
  timing: {
    timedSamples: number;
    meanPlanningDurationMs?: number;
    p95PlanningDurationMs?: number;
    latestPlanningDurationMs?: number;
  };
  lastError?: string;
}

function rounded(value: number): number {
  return Math.round(value * RATE_SCALE) / RATE_SCALE;
}

function countRate(numerator: number, denominator: number): QualityCountRate {
  return {
    numerator,
    denominator,
    rate: denominator > 0 ? rounded(numerator / denominator) : null,
  };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function increment(counts: Record<string, number>, key: string, amount = 1): void {
  counts[key] = (counts[key] ?? 0) + amount;
}

function sortedCounts(counts: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts)
      .filter(([, value]) => Number.isSafeInteger(value) && value >= 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function sortedKinds<T>(values: Readonly<Partial<Record<ContextManifestItemKind, T>>>): Partial<Record<ContextManifestItemKind, T>> {
  return Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => left.localeCompare(right)),
  ) as Partial<Record<ContextManifestItemKind, T>>;
}

function metricRate(metric: QualityCountRate, defaultValue = 1): number {
  return metric.rate ?? defaultValue;
}

function qualityScore(input: {
  evidenceRecall: QualityCountRate;
  irrelevantTokenRatio: QualityCountRate;
  provenanceCoverage: QualityCountRate;
  currentRequestRetention: QualityCountRate;
  atomicGroupValidity: QualityCountRate;
  overflowRate: number;
  fallbackRate: number;
}): number {
  const evidence = metricRate(input.evidenceRecall);
  const relevance = 1 - metricRate(input.irrelevantTokenRatio, 0);
  const provenance = metricRate(input.provenanceCoverage);
  const current = metricRate(input.currentRequestRetention);
  const atomic = metricRate(input.atomicGroupValidity);
  const reliability = Math.max(0, 1 - Math.max(input.overflowRate, input.fallbackRate));
  return rounded(
    evidence * 0.35
    + relevance * 0.2
    + provenance * 0.15
    + current * 0.15
    + atomic * 0.1
    + reliability * 0.05,
  );
}

function validateIdentifier(value: string, name: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) throw new Error(`${name} is not a safe quality identifier`);
}

export function validateQualityFixture(fixture: QualityReplayFixture): void {
  if (fixture.schemaVersion !== CONTEXT_QUALITY_SCHEMA_VERSION) {
    throw new Error("Unsupported quality fixture schema version");
  }
  for (const [name, value] of [
    ["corpusVersion", fixture.corpusVersion],
    ["sampleId", fixture.sampleId],
    ["plannerVersion", fixture.plannerVersion],
    ["profileKey", fixture.profileKey],
    ["task.taskId", fixture.task.taskId],
    ["task.taskType", fixture.task.taskType],
  ] as const) validateIdentifier(value, name);
  if (!Number.isSafeInteger(fixture.totalBudgetTokens) || fixture.totalBudgetTokens < 0) {
    throw new Error("Quality fixture totalBudgetTokens must be a non-negative integer");
  }
  const candidateIds = new Set<string>();
  for (const candidate of fixture.candidates) {
    validateIdentifier(candidate.id, "candidate.id");
    validateIdentifier(candidate.groupId, "candidate.groupId");
    if (candidateIds.has(candidate.id)) throw new Error(`Duplicate quality candidate ID: ${candidate.id}`);
    candidateIds.add(candidate.id);
    if (!Number.isSafeInteger(candidate.tokens) || candidate.tokens < 0) {
      throw new Error(`Quality candidate ${candidate.id} has invalid tokens`);
    }
    if (!Number.isFinite(candidate.staticScore)
      || (candidate.candidateScore !== undefined && !Number.isFinite(candidate.candidateScore))) {
      throw new Error(`Quality candidate ${candidate.id} has invalid score metadata`);
    }
    for (const sourceId of candidate.sourceIds) validateIdentifier(sourceId, "candidate.sourceId");
  }
  for (const sourceId of fixture.expectedEvidenceSourceIds) validateIdentifier(sourceId, "expectedEvidenceSourceId");
  for (const tag of fixture.task.queryTags) validateIdentifier(tag, "task.queryTag");
  for (const label of fixture.outcomeLabels ?? []) validateIdentifier(label, "outcomeLabel");
  for (const [kind, limit] of Object.entries(fixture.categoryBudgets)) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error(`Invalid category budget for ${kind}`);
  }
}

function planWithScore(
  fixture: QualityReplayFixture,
  strategyId: string,
  scoreFor: (candidate: QualityReplayCandidate) => number,
): QualityPlanDecision {
  validateQualityFixture(fixture);
  const groups = new Map<string, QualityReplayCandidate[]>();
  for (const candidate of fixture.candidates) {
    const group = groups.get(candidate.groupId) ?? [];
    group.push(candidate);
    groups.set(candidate.groupId, group);
  }
  const orderedGroups = [...groups.entries()]
    .map(([groupId, candidates]) => ({
      groupId,
      candidates: [...candidates].sort((left, right) => left.id.localeCompare(right.id)),
      mandatory: candidates.some((candidate) => candidate.currentRequest === true),
      score: Math.max(...candidates.map(scoreFor)),
      tokens: candidates.reduce((total, candidate) => total + candidate.tokens, 0),
    }))
    .sort((left, right) =>
      Number(right.mandatory) - Number(left.mandatory)
      || right.score - left.score
      || left.groupId.localeCompare(right.groupId)
    );

  const selected = new Set<string>();
  const selectedByKind: Partial<Record<ContextManifestItemKind, number>> = {};
  let selectedTokens = 0;
  let fallback = false;
  for (const group of orderedGroups) {
    const categoryAdditions: Partial<Record<ContextManifestItemKind, number>> = {};
    for (const candidate of group.candidates) {
      categoryAdditions[candidate.kind] = (categoryAdditions[candidate.kind] ?? 0) + candidate.tokens;
    }
    const fitsTotal = selectedTokens + group.tokens <= fixture.totalBudgetTokens;
    const fitsCategories = Object.entries(categoryAdditions).every(([kind, tokens]) => {
      const limit = fixture.categoryBudgets[kind as ContextManifestItemKind];
      return limit === undefined || (selectedByKind[kind as ContextManifestItemKind] ?? 0) + tokens <= limit;
    });
    if (!fitsTotal || !fitsCategories) {
      if (group.mandatory) fallback = true;
      continue;
    }
    for (const candidate of group.candidates) {
      selected.add(candidate.id);
      selectedByKind[candidate.kind] = (selectedByKind[candidate.kind] ?? 0) + candidate.tokens;
    }
    selectedTokens += group.tokens;
  }

  if (fallback) {
    for (const candidate of fixture.candidates) selected.add(candidate.id);
    selectedTokens = fixture.candidates.reduce((total, candidate) => total + candidate.tokens, 0);
  }

  const selectionReasons: Record<string, string> = {};
  const dropReasons: Record<string, string> = {};
  for (const candidate of fixture.candidates) {
    if (selected.has(candidate.id)) {
      selectionReasons[candidate.id] = fallback
        ? "fail-open-retained"
        : candidate.currentRequest
          ? "mandatory-current-request"
          : `${strategyId}-selected`;
    } else {
      dropReasons[candidate.id] = "strategy-or-budget-drop";
    }
  }
  return {
    selectedCandidateIds: [...selected].sort((left, right) => left.localeCompare(right)),
    selectionReasons,
    dropReasons,
    fallback,
    overflow: selectedTokens > fixture.totalBudgetTokens,
  };
}

export function staticRankingStrategy(): QualityStrategy {
  return {
    id: STATIC_RANKING_STRATEGY_ID,
    plan: (fixture) => planWithScore(fixture, STATIC_RANKING_STRATEGY_ID, (candidate) => candidate.staticScore),
  };
}

export function taskWeightedCandidateStrategy(): QualityStrategy {
  return {
    id: CANDIDATE_RANKING_STRATEGY_ID,
    plan: (fixture) => planWithScore(
      fixture,
      CANDIDATE_RANKING_STRATEGY_ID,
      (candidate) => candidate.candidateScore ?? candidate.staticScore,
    ),
  };
}

export function evaluateQualityPlan(
  fixture: QualityReplayFixture,
  strategyId: string,
  plan: QualityPlanDecision,
  planningDurationMs?: number,
): ContextQualitySample {
  validateQualityFixture(fixture);
  validateIdentifier(strategyId, "strategyId");
  const byId = new Map(fixture.candidates.map((candidate) => [candidate.id, candidate]));
  const selectedIds = new Set(plan.selectedCandidateIds);
  for (const id of selectedIds) {
    if (!byId.has(id)) throw new Error(`Quality plan selected unknown candidate: ${id}`);
  }
  const selected = fixture.candidates.filter((candidate) => selectedIds.has(candidate.id));
  const dropped = fixture.candidates.filter((candidate) => !selectedIds.has(candidate.id));
  const expected = new Set(fixture.expectedEvidenceSourceIds);
  const currentSources = new Set(
    fixture.candidates.flatMap((candidate) => candidate.currentRequest ? candidate.sourceIds : []),
  );
  const relevant = new Set([...expected, ...currentSources]);
  const selectedSources = new Set(selected.flatMap((candidate) => candidate.sourceIds));
  const evidenceSelected = [...expected].filter((sourceId) => selectedSources.has(sourceId)).length;
  const selectedTokens = selected.reduce((total, candidate) => total + candidate.tokens, 0);
  const droppedTokens = dropped.reduce((total, candidate) => total + candidate.tokens, 0);
  const irrelevantTokens = expected.size === 0
    ? 0
    : selected.reduce((total, candidate) =>
        candidate.currentRequest || candidate.sourceIds.some((sourceId) => relevant.has(sourceId))
          ? total
          : total + candidate.tokens, 0);

  const sourceReferences = selected.flatMap((candidate) => candidate.sourceIds);
  const duplicateReferences = sourceReferences.length - new Set(sourceReferences).size;
  const provenanceEligible = selected.filter((candidate) => candidate.provenanceRequired !== false);
  const provenanceCovered = provenanceEligible.filter((candidate) => candidate.sourceIds.length > 0).length;
  const currentCandidates = fixture.candidates.filter((candidate) => candidate.currentRequest === true);
  const retainedCurrent = currentCandidates.filter((candidate) => selectedIds.has(candidate.id)).length;

  const atomicGroups = new Map<string, QualityReplayCandidate[]>();
  for (const candidate of fixture.candidates) {
    const group = atomicGroups.get(candidate.groupId) ?? [];
    group.push(candidate);
    atomicGroups.set(candidate.groupId, group);
  }
  const multiCandidateGroups = [...atomicGroups.values()].filter((group) => group.length > 1);
  const validAtomicGroups = multiCandidateGroups.filter((group) => {
    const selectedCount = group.filter((candidate) => selectedIds.has(candidate.id)).length;
    return selectedCount === 0 || selectedCount === group.length;
  }).length;

  const sourceKindCounts: Partial<Record<ContextManifestItemKind, QualitySourceKindCount>> = {};
  for (const candidate of fixture.candidates) {
    const counts = sourceKindCounts[candidate.kind] ?? { available: 0, selected: 0, dropped: 0 };
    counts.available++;
    if (selectedIds.has(candidate.id)) counts.selected++;
    else counts.dropped++;
    sourceKindCounts[candidate.kind] = counts;
  }

  const budgetUtilization: Partial<Record<ContextManifestItemKind, QualityBudgetUtilization>> = {};
  for (const [kindValue, limitTokens] of Object.entries(fixture.categoryBudgets)) {
    const kind = kindValue as ContextManifestItemKind;
    const categorySelected = selected
      .filter((candidate) => candidate.kind === kind)
      .reduce((total, candidate) => total + candidate.tokens, 0);
    const categoryDropped = dropped
      .filter((candidate) => candidate.kind === kind)
      .reduce((total, candidate) => total + candidate.tokens, 0);
    budgetUtilization[kind] = {
      limitTokens,
      selectedTokens: categorySelected,
      droppedTokens: categoryDropped,
      utilization: limitTokens > 0 ? rounded(categorySelected / limitTokens) : categorySelected > 0 ? 1 : 0,
    };
  }

  const selectionReasonCounts: Record<string, number> = {};
  const dropReasonCounts: Record<string, number> = {};
  for (const candidate of selected) {
    const reason = plan.selectionReasons[candidate.id] ?? "selected-unspecified";
    increment(selectionReasonCounts, REASON_PATTERN.test(reason) ? reason : "selected-unspecified");
  }
  for (const candidate of dropped) {
    const reason = plan.dropReasons[candidate.id] ?? "dropped-unspecified";
    increment(dropReasonCounts, REASON_PATTERN.test(reason) ? reason : "dropped-unspecified");
  }

  const evidenceRecall = countRate(evidenceSelected, expected.size);
  const irrelevantTokenRatio = countRate(irrelevantTokens, expected.size > 0 ? selectedTokens : 0);
  const provenanceCoverage = countRate(provenanceCovered, provenanceEligible.length);
  const currentRequestRetention = countRate(retainedCurrent, currentCandidates.length);
  const atomicGroupValidity = countRate(validAtomicGroups, multiCandidateGroups.length);
  const overflow = plan.overflow || selectedTokens > fixture.totalBudgetTokens;
  const fallback = plan.fallback;
  const metrics: ContextQualityMetrics = {
    evidenceRecall,
    irrelevantTokenRatio,
    duplicateEvidence: { duplicateReferences, selectedReferences: sourceReferences.length },
    provenanceCoverage,
    currentRequestRetention,
    atomicGroupValidity,
    overflow,
    fallback,
    qualityScore: qualityScore({
      evidenceRecall,
      irrelevantTokenRatio,
      provenanceCoverage,
      currentRequestRetention,
      atomicGroupValidity,
      overflowRate: overflow ? 1 : 0,
      fallbackRate: fallback ? 1 : 0,
    }),
    selectedTokens,
    droppedTokens,
    sourceKindCounts: sortedKinds(sourceKindCounts),
    budgetUtilization: sortedKinds(budgetUtilization),
    selectionReasons: sortedCounts(selectionReasonCounts),
    dropReasons: sortedCounts(dropReasonCounts),
  };

  return {
    schemaVersion: CONTEXT_QUALITY_SCHEMA_VERSION,
    metricsVersion: CONTEXT_QUALITY_METRICS_VERSION,
    sampleId: fixture.sampleId,
    corpusVersion: fixture.corpusVersion,
    strategyId,
    plannerVersion: fixture.plannerVersion,
    profileKey: fixture.profileKey,
    outcomeLabels: sortedUnique(fixture.outcomeLabels ?? []),
    metrics,
    ...(planningDurationMs !== undefined && Number.isFinite(planningDurationMs) && planningDurationMs >= 0
      ? { timing: { planningDurationMs: rounded(planningDurationMs) } }
      : {}),
  };
}

export function aggregateContextQuality(samples: readonly ContextQualitySample[]): ContextQualityAggregate {
  const valid = samples.filter(isContextQualitySample);
  const evidenceNumerator = valid.reduce((total, sample) => total + sample.metrics.evidenceRecall.numerator, 0);
  const evidenceDenominator = valid.reduce((total, sample) => total + sample.metrics.evidenceRecall.denominator, 0);
  const irrelevantNumerator = valid.reduce((total, sample) => total + sample.metrics.irrelevantTokenRatio.numerator, 0);
  const irrelevantDenominator = valid.reduce((total, sample) => total + sample.metrics.irrelevantTokenRatio.denominator, 0);
  const provenanceNumerator = valid.reduce((total, sample) => total + sample.metrics.provenanceCoverage.numerator, 0);
  const provenanceDenominator = valid.reduce((total, sample) => total + sample.metrics.provenanceCoverage.denominator, 0);
  const currentNumerator = valid.reduce((total, sample) => total + sample.metrics.currentRequestRetention.numerator, 0);
  const currentDenominator = valid.reduce((total, sample) => total + sample.metrics.currentRequestRetention.denominator, 0);
  const atomicNumerator = valid.reduce((total, sample) => total + sample.metrics.atomicGroupValidity.numerator, 0);
  const atomicDenominator = valid.reduce((total, sample) => total + sample.metrics.atomicGroupValidity.denominator, 0);
  const evidenceRecall = countRate(evidenceNumerator, evidenceDenominator);
  const irrelevantTokenRatio = countRate(irrelevantNumerator, irrelevantDenominator);
  const provenanceCoverage = countRate(provenanceNumerator, provenanceDenominator);
  const currentRequestRetention = countRate(currentNumerator, currentDenominator);
  const atomicGroupValidity = countRate(atomicNumerator, atomicDenominator);
  const overflowRate = countRate(valid.filter((sample) => sample.metrics.overflow).length, valid.length);
  const fallbackRate = countRate(valid.filter((sample) => sample.metrics.fallback).length, valid.length);
  const sourceKindCounts: Partial<Record<ContextManifestItemKind, QualitySourceKindCount>> = {};
  const budgetTotals: Partial<Record<ContextManifestItemKind, Omit<QualityBudgetUtilization, "utilization">>> = {};
  const selectionReasons: Record<string, number> = {};
  const dropReasons: Record<string, number> = {};
  const outcomeLabels: Record<string, number> = {};
  for (const sample of valid) {
    for (const [kindValue, counts] of Object.entries(sample.metrics.sourceKindCounts)) {
      const kind = kindValue as ContextManifestItemKind;
      const aggregate = sourceKindCounts[kind] ?? { available: 0, selected: 0, dropped: 0 };
      aggregate.available += counts.available;
      aggregate.selected += counts.selected;
      aggregate.dropped += counts.dropped;
      sourceKindCounts[kind] = aggregate;
    }
    for (const [kindValue, utilization] of Object.entries(sample.metrics.budgetUtilization)) {
      const kind = kindValue as ContextManifestItemKind;
      const aggregate = budgetTotals[kind] ?? { limitTokens: 0, selectedTokens: 0, droppedTokens: 0 };
      aggregate.limitTokens += utilization.limitTokens;
      aggregate.selectedTokens += utilization.selectedTokens;
      aggregate.droppedTokens += utilization.droppedTokens;
      budgetTotals[kind] = aggregate;
    }
    for (const [reason, count] of Object.entries(sample.metrics.selectionReasons)) increment(selectionReasons, reason, count);
    for (const [reason, count] of Object.entries(sample.metrics.dropReasons)) increment(dropReasons, reason, count);
    for (const label of sample.outcomeLabels) increment(outcomeLabels, label);
  }
  const budgetUtilization: Partial<Record<ContextManifestItemKind, QualityBudgetUtilization>> = {};
  for (const [kindValue, totals] of Object.entries(budgetTotals)) {
    const kind = kindValue as ContextManifestItemKind;
    budgetUtilization[kind] = {
      ...totals,
      utilization: totals.limitTokens > 0
        ? rounded(totals.selectedTokens / totals.limitTokens)
        : totals.selectedTokens > 0 ? 1 : 0,
    };
  }
  const duplicateReferences = valid.reduce(
    (total, sample) => total + sample.metrics.duplicateEvidence.duplicateReferences,
    0,
  );
  const selectedReferences = valid.reduce(
    (total, sample) => total + sample.metrics.duplicateEvidence.selectedReferences,
    0,
  );

  return {
    schemaVersion: CONTEXT_QUALITY_SCHEMA_VERSION,
    metricsVersion: CONTEXT_QUALITY_METRICS_VERSION,
    sampleCount: valid.length,
    labeledSampleCount: valid.filter((sample) => sample.metrics.evidenceRecall.denominator > 0).length,
    strategyIds: sortedUnique(valid.map((sample) => sample.strategyId)),
    plannerVersions: sortedUnique(valid.map((sample) => sample.plannerVersion)),
    profileKeys: sortedUnique(valid.map((sample) => sample.profileKey)),
    outcomeLabels: sortedCounts(outcomeLabels),
    evidenceRecall,
    irrelevantTokenRatio,
    duplicateEvidence: { duplicateReferences, selectedReferences },
    provenanceCoverage,
    currentRequestRetention,
    atomicGroupValidity,
    overflowRate,
    fallbackRate,
    qualityScore: valid.length > 0 && evidenceDenominator > 0
      ? qualityScore({
          evidenceRecall,
          irrelevantTokenRatio,
          provenanceCoverage,
          currentRequestRetention,
          atomicGroupValidity,
          overflowRate: overflowRate.rate ?? 0,
          fallbackRate: fallbackRate.rate ?? 0,
        })
      : 0,
    selectedTokens: valid.reduce((total, sample) => total + sample.metrics.selectedTokens, 0),
    droppedTokens: valid.reduce((total, sample) => total + sample.metrics.droppedTokens, 0),
    sourceKindCounts: sortedKinds(sourceKindCounts),
    budgetUtilization: sortedKinds(budgetUtilization),
    selectionReasons: sortedCounts(selectionReasons),
    dropReasons: sortedCounts(dropReasons),
  };
}

export function compareQualityStrategies(
  corpus: QualityReplayCorpus,
  strategies: readonly QualityStrategy[],
): ContextQualityComparison {
  if (corpus.schemaVersion !== CONTEXT_QUALITY_SCHEMA_VERSION) throw new Error("Unsupported quality corpus schema");
  validateIdentifier(corpus.corpusVersion, "corpusVersion");
  if (strategies.length === 0) throw new Error("At least one quality strategy is required");
  const strategyReports = strategies.map((strategy) => {
    validateIdentifier(strategy.id, "strategy.id");
    const samples = corpus.fixtures.map((fixture) => {
      if (fixture.corpusVersion !== corpus.corpusVersion) {
        throw new Error(`Fixture ${fixture.sampleId} has a mismatched corpus version`);
      }
      return evaluateQualityPlan(fixture, strategy.id, strategy.plan(fixture));
    });
    return { strategyId: strategy.id, aggregate: aggregateContextQuality(samples) };
  });
  const baseline = strategyReports[0];
  if (!baseline) throw new Error("Quality baseline is unavailable");
  const rate = (value: number | null): number => value ?? 0;
  return {
    schemaVersion: CONTEXT_QUALITY_SCHEMA_VERSION,
    metricsVersion: CONTEXT_QUALITY_METRICS_VERSION,
    corpusVersion: corpus.corpusVersion,
    fixtureCount: corpus.fixtures.length,
    strategies: strategyReports,
    deltasFromBaseline: strategyReports.slice(1).map((report) => ({
      strategyId: report.strategyId,
      qualityScore: rounded(report.aggregate.qualityScore - baseline.aggregate.qualityScore),
      evidenceRecall: rounded(rate(report.aggregate.evidenceRecall.rate) - rate(baseline.aggregate.evidenceRecall.rate)),
      irrelevantTokenRatio: rounded(
        rate(report.aggregate.irrelevantTokenRatio.rate) - rate(baseline.aggregate.irrelevantTokenRatio.rate),
      ),
      fallbackRate: rounded(rate(report.aggregate.fallbackRate.rate) - rate(baseline.aggregate.fallbackRate.rate)),
    })),
  };
}

function safeLiveIdentifier(value: string, prefix: string): string {
  return IDENTIFIER_PATTERN.test(value) ? value : `${prefix}:${sha256(value).slice(0, 24)}`;
}

function liveReason(item: ContextManifestItem, selected: boolean): string {
  if (selected) {
    if (item.kind === "current") return "mandatory-current-request";
    if (item.kind === "system") return "effective-system-prompt";
    if (item.kind === "tool") return "active-tool-definition";
    return `selected-${item.kind}`;
  }
  if (item.reason.toLowerCase().includes("privacy")) return "privacy-policy-drop";
  return `budget-or-policy-drop-${item.kind}`;
}

export function evaluateManifestQuality(
  manifest: ContextManifest,
  categoryBudgets: Partial<Record<ContextManifestItemKind, number>>,
): ContextQualitySample {
  const included = manifest.included.map((item, index): QualityReplayCandidate => ({
    id: `included:${index}`,
    kind: item.kind,
    tokens: Math.max(0, Math.floor(item.tokens)),
    groupId: item.groupId ? `group:${sha256(item.groupId).slice(0, 24)}` : `included:${index}`,
    sourceIds: item.sourceId ? [`source:${sha256(item.sourceId).slice(0, 24)}`] : [],
    staticScore: item.score ?? 0,
    currentRequest: item.kind === "current",
    provenanceRequired: item.kind !== "system" && item.kind !== "tool",
  }));
  const excluded = manifest.excluded.map((item, index): QualityReplayCandidate => ({
    id: `excluded:${index}`,
    kind: item.kind,
    tokens: Math.max(0, Math.floor(item.tokens)),
    groupId: item.groupId ? `group:${sha256(item.groupId).slice(0, 24)}` : `excluded:${index}`,
    sourceIds: item.sourceId ? [`source:${sha256(item.sourceId).slice(0, 24)}`] : [],
    staticScore: item.score ?? 0,
    currentRequest: item.kind === "current",
    provenanceRequired: item.kind !== "system" && item.kind !== "tool",
  }));
  const fixture: QualityReplayFixture = {
    schemaVersion: CONTEXT_QUALITY_SCHEMA_VERSION,
    corpusVersion: LIVE_QUALITY_CORPUS_VERSION,
    sampleId: `manifest:${sha256(manifest.id).slice(0, 24)}`,
    plannerVersion: safeLiveIdentifier(manifest.plannerVersion, "planner"),
    profileKey: safeLiveIdentifier(
      manifest.modelAwareness?.profileKey ?? `model:${manifest.provider}/${manifest.model}`,
      "profile",
    ),
    task: { taskId: "live:unlabeled", taskType: "live-observation", queryTags: [] },
    expectedEvidenceSourceIds: [],
    candidates: [...included, ...excluded],
    totalBudgetTokens: manifest.hardInputLimit,
    categoryBudgets,
    outcomeLabels: [
      `mode:${manifest.planning?.mode ?? "observer"}`,
      ...(manifest.privacy?.enabled ? ["privacy:enabled"] : []),
    ],
  };
  const selectionReasons = Object.fromEntries(
    manifest.included.map((item, index) => [`included:${index}`, liveReason(item, true)]),
  );
  const dropReasons = Object.fromEntries(
    manifest.excluded.map((item, index) => [`excluded:${index}`, liveReason(item, false)]),
  );
  return evaluateQualityPlan(fixture, safeLiveIdentifier(`planner:${manifest.plannerVersion}`, "strategy"), {
    selectedCandidateIds: included.map((candidate) => candidate.id),
    selectionReasons,
    dropReasons,
    fallback: manifest.planning?.mode === "fallback",
    overflow: manifest.estimatedInputTokens > manifest.hardInputLimit,
  }, manifest.planning?.durationMs);
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validCountRate(value: unknown): value is QualityCountRate {
  if (!value || typeof value !== "object") return false;
  const metric = value as Partial<QualityCountRate>;
  return validCount(metric.numerator)
    && validCount(metric.denominator)
    && metric.numerator <= metric.denominator
    && (metric.rate === null || (typeof metric.rate === "number" && metric.rate >= 0 && metric.rate <= 1));
}

function validReasonCounts(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([reason, count]) => REASON_PATTERN.test(reason) && validCount(count));
}

function validSourceKindCounts(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((counts) => {
    if (!counts || typeof counts !== "object") return false;
    const item = counts as Partial<QualitySourceKindCount>;
    return validCount(item.available)
      && validCount(item.selected)
      && validCount(item.dropped)
      && item.selected + item.dropped === item.available;
  });
}

function validBudgetUtilization(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((budget) => {
    if (!budget || typeof budget !== "object") return false;
    const item = budget as Partial<QualityBudgetUtilization>;
    return validCount(item.limitTokens)
      && validCount(item.selectedTokens)
      && validCount(item.droppedTokens)
      && typeof item.utilization === "number"
      && Number.isFinite(item.utilization)
      && item.utilization >= 0;
  });
}

export function isContextQualitySample(value: unknown): value is ContextQualitySample {
  if (!value || typeof value !== "object") return false;
  const sample = value as Partial<ContextQualitySample>;
  if (sample.schemaVersion !== CONTEXT_QUALITY_SCHEMA_VERSION
    || sample.metricsVersion !== CONTEXT_QUALITY_METRICS_VERSION
    || typeof sample.sampleId !== "string"
    || typeof sample.corpusVersion !== "string"
    || typeof sample.strategyId !== "string"
    || typeof sample.plannerVersion !== "string"
    || typeof sample.profileKey !== "string"
    || !Array.isArray(sample.outcomeLabels)
    || !sample.outcomeLabels.every((label) => typeof label === "string" && IDENTIFIER_PATTERN.test(label))) return false;
  try {
    validateIdentifier(sample.sampleId, "sampleId");
    validateIdentifier(sample.corpusVersion, "corpusVersion");
    validateIdentifier(sample.strategyId, "strategyId");
    validateIdentifier(sample.plannerVersion, "plannerVersion");
    validateIdentifier(sample.profileKey, "profileKey");
  } catch {
    return false;
  }
  const metrics = sample.metrics;
  if (!metrics || typeof metrics !== "object") return false;
  if (!validCountRate(metrics.evidenceRecall)
    || !validCountRate(metrics.irrelevantTokenRatio)
    || !validCountRate(metrics.provenanceCoverage)
    || !validCountRate(metrics.currentRequestRetention)
    || !validCountRate(metrics.atomicGroupValidity)
    || typeof metrics.overflow !== "boolean"
    || typeof metrics.fallback !== "boolean"
    || typeof metrics.qualityScore !== "number"
    || metrics.qualityScore < 0
    || metrics.qualityScore > 1
    || !validCount(metrics.selectedTokens)
    || !validCount(metrics.droppedTokens)
    || !metrics.duplicateEvidence
    || !validCount(metrics.duplicateEvidence.duplicateReferences)
    || !validCount(metrics.duplicateEvidence.selectedReferences)
    || metrics.duplicateEvidence.duplicateReferences > metrics.duplicateEvidence.selectedReferences
    || !validSourceKindCounts(metrics.sourceKindCounts)
    || !validBudgetUtilization(metrics.budgetUtilization)
    || !validReasonCounts(metrics.selectionReasons)
    || !validReasonCounts(metrics.dropReasons)) return false;
  return sample.timing === undefined
    || (typeof sample.timing.planningDurationMs === "number"
      && Number.isFinite(sample.timing.planningDurationMs)
      && sample.timing.planningDurationMs >= 0);
}

export function qualityTiming(samples: readonly ContextQualitySample[]): ContextQualityDiagnostics["timing"] {
  const durations = samples
    .flatMap((sample) => sample.timing ? [sample.timing.planningDurationMs] : [])
    .filter((duration) => Number.isFinite(duration) && duration >= 0)
    .sort((left, right) => left - right);
  if (durations.length === 0) return { timedSamples: 0 };
  const total = durations.reduce((sum, duration) => sum + duration, 0);
  const p95Index = Math.max(0, Math.ceil(durations.length * 0.95) - 1);
  return {
    timedSamples: durations.length,
    meanPlanningDurationMs: rounded(total / durations.length),
    p95PlanningDurationMs: rounded(durations[p95Index] ?? 0),
    latestPlanningDurationMs: rounded(samples.findLast((sample) => sample.timing)?.timing?.planningDurationMs ?? 0),
  };
}

export function disabledContextQualityDiagnostics(): ContextQualityDiagnostics {
  return {
    enabled: false,
    metricsVersion: CONTEXT_QUALITY_METRICS_VERSION,
    storedSamples: 0,
    ignoredSamples: 0,
    aggregate: aggregateContextQuality([]),
    timing: { timedSamples: 0 },
  };
}
