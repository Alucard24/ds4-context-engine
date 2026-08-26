import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { PrivacyClassification } from "../privacy/privacy-policy.ts";
import { isPrivacyClassification } from "../privacy/privacy-policy.ts";
import { sha256 } from "../shared/hash.ts";
import { stableStringify } from "../shared/stable-json.ts";

export const RANKING_FEATURE_VERSION = "ranking-features-v1";
export const RANKING_MODEL_SCHEMA_VERSION = 1 as const;
export const RANKING_FEEDBACK_SCHEMA_VERSION = 1 as const;
export const RANKING_FEEDBACK_CUSTOM_ENTRY_TYPE = "ds4-context-ranking-feedback-v1";
export const RANKING_ALGORITHM = "bounded-linear-centroid-v1";

export type RankingMode = "off" | "shadow" | "active";
export type RankingSourceKind = "memory" | "retrieval" | "project";
export type RankingFeedbackLabel = "useful" | "irrelevant";
export type RankingLabelSource = "feedback" | "replay";

export interface RankingFeatureVector {
  sourceKind: RankingSourceKind;
  /** Static-ranker score normalized to [0, 1]. */
  staticScore: number;
  exactScore: number;
  ftsScore: number;
  vectorScore: number;
  recency: number;
  branchRelation: number;
  symbolRelation: number;
  classificationEligible: number;
  tokenCost: number;
  priorSelected: number;
}

export type NumericRankingFeature = Exclude<keyof RankingFeatureVector, "sourceKind">;

export interface RankingCandidate<T = unknown> {
  id: string;
  staticScore: number;
  features: RankingFeatureVector;
  value: T;
}

export interface RankedCandidate<T = unknown> extends RankingCandidate<T> {
  staticRank: number;
  learnedRank: number;
  learnedScore: number;
  effectiveScore: number;
}

export interface LearnedRankingWeights {
  bias: number;
  features: Record<NumericRankingFeature, number>;
  sourceKinds: Record<RankingSourceKind, number>;
}

export interface RankingPromotionReport {
  reportVersion: "ranking-promotion-v1";
  fixtureCount: number;
  heldOutRepositories: number;
  minimumHeldOutRepositories: number;
  baselineQualityScore: number;
  learnedQualityScore: number;
  qualityScoreDelta: number;
  baselineExactIdentifierRecall: number;
  learnedExactIdentifierRecall: number;
  exactIdentifierRecallDelta: number;
  privacyViolationDelta: number;
  atomicityFailureDelta: number;
  overflowDelta: number;
  measuredP95LatencyMs: number;
  latencyBudgetMs: number;
  deterministic: boolean;
  eligible: boolean;
  reasons: string[];
}

export interface LearnedRankingModel {
  schemaVersion: 1;
  featureVersion: typeof RANKING_FEATURE_VERSION;
  algorithm: typeof RANKING_ALGORITHM;
  modelId: string;
  createdAt: number;
  training: {
    sampleCount: number;
    positiveSamples: number;
    negativeSamples: number;
    repositoryCount: number;
  };
  weights: LearnedRankingWeights;
  promotion?: RankingPromotionReport;
  checksum: string;
}

export interface RankingTrainingSample {
  sampleId: string;
  repositoryHash: string;
  candidateKeyHash: string;
  labelSource: RankingLabelSource;
  label: RankingFeedbackLabel;
  classification: PrivacyClassification;
  features: RankingFeatureVector;
}

export interface RankingFeedbackEntry {
  schemaVersion: 1;
  feedbackId: string;
  createdAt: number;
  repositoryHash: string;
  candidateKeyHash: string;
  labelSource: RankingLabelSource;
  label: RankingFeedbackLabel;
  classification: PrivacyClassification;
  features: RankingFeatureVector;
}

export interface RankingDiagnostics {
  mode: RankingMode;
  status: "off" | "shadow" | "active" | "fallback";
  featureVersion: typeof RANKING_FEATURE_VERSION;
  modelId?: string;
  candidateCount: number;
  topChanged: boolean;
  pairwiseDisagreements: number;
  meanRankShift: number;
  durationMs: number;
  fallbackReason?: string;
}

export interface RankingResult<T> {
  ranked: Array<RankedCandidate<T>>;
  diagnostics: RankingDiagnostics;
}

export interface RankingPromotionCandidate {
  id: string;
  groupId: string;
  tokens: number;
  relevant: boolean;
  exactIdentifier: boolean;
  staticScore: number;
  features: RankingFeatureVector;
}

export interface RankingPromotionFixture {
  fixtureId: string;
  repositoryHash: string;
  maxResults: number;
  maxTokens: number;
  candidates: RankingPromotionCandidate[];
}

export interface RankingPromotionOptions {
  measuredP95LatencyMs: number;
  latencyBudgetMs: number;
  minimumHeldOutRepositories?: number;
}

const NUMERIC_FEATURES = [
  "staticScore",
  "exactScore",
  "ftsScore",
  "vectorScore",
  "recency",
  "branchRelation",
  "symbolRelation",
  "classificationEligible",
  "tokenCost",
  "priorSelected",
] as const satisfies readonly NumericRankingFeature[];
const SOURCE_KINDS = ["memory", "retrieval", "project"] as const satisfies readonly RankingSourceKind[];
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SCORE_SCALE = 1_000_000_000;
const MAX_MODEL_WEIGHT = 16;
const MAX_RANKING_MODEL_BYTES = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function rounded(value: number): number {
  return Math.round(value * SCORE_SCALE) / SCORE_SCALE;
}

function clamp01(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return rounded(Math.max(0, Math.min(1, value)));
}

function normalizedSourceKind(value: unknown): RankingSourceKind | undefined {
  return typeof value === "string" && SOURCE_KINDS.includes(value as RankingSourceKind)
    ? value as RankingSourceKind
    : undefined;
}

export function createRankingFeatures(
  input: Partial<Omit<RankingFeatureVector, "sourceKind">> & { sourceKind: RankingSourceKind },
): RankingFeatureVector {
  return {
    sourceKind: input.sourceKind,
    staticScore: clamp01(input.staticScore),
    exactScore: clamp01(input.exactScore),
    ftsScore: clamp01(input.ftsScore),
    vectorScore: clamp01(input.vectorScore),
    recency: clamp01(input.recency),
    branchRelation: clamp01(input.branchRelation),
    symbolRelation: clamp01(input.symbolRelation),
    classificationEligible: clamp01(input.classificationEligible),
    tokenCost: clamp01(input.tokenCost),
    priorSelected: clamp01(input.priorSelected),
  };
}

export function parseRankingFeatures(value: unknown): RankingFeatureVector | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["sourceKind", ...NUMERIC_FEATURES])) return undefined;
  const sourceKind = normalizedSourceKind(value.sourceKind);
  if (!sourceKind) return undefined;
  const result = { sourceKind } as RankingFeatureVector;
  for (const feature of NUMERIC_FEATURES) {
    const featureValue = value[feature];
    if (typeof featureValue !== "number" || !Number.isFinite(featureValue)
      || featureValue < 0 || featureValue > 1) return undefined;
    result[feature] = rounded(featureValue);
  }
  return result;
}

export function hashRankingCandidateKey(candidateKey: string): string {
  return sha256(candidateKey);
}

export function createRankingFeedback(input: {
  feedbackId: string;
  createdAt: number;
  repositoryIdentity: string;
  candidateKey: string;
  labelSource?: RankingLabelSource;
  label: RankingFeedbackLabel;
  classification: PrivacyClassification;
  features: RankingFeatureVector;
}): RankingFeedbackEntry {
  if (!ID_PATTERN.test(input.feedbackId)) throw new Error("Ranking feedback ID is invalid");
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    throw new Error("Ranking feedback timestamp is invalid");
  }
  const features = parseRankingFeatures(input.features);
  if (!features) throw new Error("Ranking feedback features are invalid");
  if (!input.repositoryIdentity || !input.candidateKey) {
    throw new Error("Ranking feedback repository and candidate identities are required");
  }
  if ((input.labelSource !== undefined && input.labelSource !== "feedback" && input.labelSource !== "replay")
    || (input.label !== "useful" && input.label !== "irrelevant")
    || !isPrivacyClassification(input.classification)) {
    throw new Error("Ranking feedback label metadata is invalid");
  }
  return {
    schemaVersion: RANKING_FEEDBACK_SCHEMA_VERSION,
    feedbackId: input.feedbackId,
    createdAt: input.createdAt,
    repositoryHash: sha256(input.repositoryIdentity),
    candidateKeyHash: hashRankingCandidateKey(input.candidateKey),
    labelSource: input.labelSource ?? "feedback",
    label: input.label,
    classification: input.classification,
    features,
  };
}

export function parseRankingFeedback(value: unknown): RankingFeedbackEntry | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      "schemaVersion",
      "feedbackId",
      "createdAt",
      "repositoryHash",
      "candidateKeyHash",
      "labelSource",
      "label",
      "classification",
      "features",
    ])
    || value.schemaVersion !== RANKING_FEEDBACK_SCHEMA_VERSION) return undefined;
  if (typeof value.feedbackId !== "string" || !ID_PATTERN.test(value.feedbackId)) return undefined;
  if (typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) {
    return undefined;
  }
  if (typeof value.repositoryHash !== "string" || !HASH_PATTERN.test(value.repositoryHash)) return undefined;
  if (typeof value.candidateKeyHash !== "string" || !HASH_PATTERN.test(value.candidateKeyHash)) return undefined;
  if (value.labelSource !== "feedback" && value.labelSource !== "replay") return undefined;
  if (value.label !== "useful" && value.label !== "irrelevant") return undefined;
  if (typeof value.classification !== "string" || !isPrivacyClassification(value.classification)) return undefined;
  const features = parseRankingFeatures(value.features);
  if (!features) return undefined;
  return {
    schemaVersion: RANKING_FEEDBACK_SCHEMA_VERSION,
    feedbackId: value.feedbackId,
    createdAt: value.createdAt,
    repositoryHash: value.repositoryHash,
    candidateKeyHash: value.candidateKeyHash,
    labelSource: value.labelSource,
    label: value.label,
    classification: value.classification,
    features,
  };
}

export function rankingTrainingSample(entry: RankingFeedbackEntry): RankingTrainingSample {
  return {
    sampleId: entry.feedbackId,
    repositoryHash: entry.repositoryHash,
    candidateKeyHash: entry.candidateKeyHash,
    labelSource: entry.labelSource,
    label: entry.label,
    classification: entry.classification,
    features: { ...entry.features },
  };
}

function emptyFeatureWeights(): Record<NumericRankingFeature, number> {
  return Object.fromEntries(NUMERIC_FEATURES.map((feature) => [feature, 0])) as Record<NumericRankingFeature, number>;
}

function emptySourceWeights(): Record<RankingSourceKind, number> {
  return { memory: 0, retrieval: 0, project: 0 };
}

function boundedWeight(value: number): number {
  return rounded(Math.max(-MAX_MODEL_WEIGHT, Math.min(MAX_MODEL_WEIGHT, value)));
}

function modelPayload(model: Omit<LearnedRankingModel, "checksum">): Omit<LearnedRankingModel, "checksum"> {
  return {
    schemaVersion: model.schemaVersion,
    featureVersion: model.featureVersion,
    algorithm: model.algorithm,
    modelId: model.modelId,
    createdAt: model.createdAt,
    training: { ...model.training },
    weights: {
      bias: model.weights.bias,
      features: { ...model.weights.features },
      sourceKinds: { ...model.weights.sourceKinds },
    },
    ...(model.promotion ? { promotion: structuredClone(model.promotion) } : {}),
  };
}

function sealModel(
  input: Omit<LearnedRankingModel, "modelId" | "checksum">,
): LearnedRankingModel {
  const identityPayload = { ...input, modelId: "" };
  const modelId = `ranking-${sha256(stableStringify(identityPayload)).slice(0, 16)}`;
  const payload = modelPayload({ ...input, modelId });
  return { ...payload, checksum: sha256(stableStringify(payload)) };
}

function assertFiniteWeight(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_MODEL_WEIGHT;
}

export function parseLearnedRankingModel(value: unknown): LearnedRankingModel | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      "schemaVersion",
      "featureVersion",
      "algorithm",
      "modelId",
      "createdAt",
      "training",
      "weights",
      "promotion",
      "checksum",
    ])
    || value.schemaVersion !== RANKING_MODEL_SCHEMA_VERSION
    || value.featureVersion !== RANKING_FEATURE_VERSION
    || value.algorithm !== RANKING_ALGORITHM
    || typeof value.modelId !== "string"
    || !/^ranking-[a-f0-9]{16}$/u.test(value.modelId)
    || typeof value.createdAt !== "number"
    || !Number.isSafeInteger(value.createdAt)
    || value.createdAt < 0
    || typeof value.checksum !== "string"
    || !HASH_PATTERN.test(value.checksum)
    || !isRecord(value.training)
    || !isRecord(value.weights)
    || !isRecord(value.weights.features)
    || !isRecord(value.weights.sourceKinds)
    || !hasOnlyKeys(value.training, ["sampleCount", "positiveSamples", "negativeSamples", "repositoryCount"])
    || !hasOnlyKeys(value.weights, ["bias", "features", "sourceKinds"])
    || !hasOnlyKeys(value.weights.features, NUMERIC_FEATURES)
    || !hasOnlyKeys(value.weights.sourceKinds, SOURCE_KINDS)
    || !assertFiniteWeight(value.weights.bias)) return undefined;

  const trainingKeys = ["sampleCount", "positiveSamples", "negativeSamples", "repositoryCount"] as const;
  for (const key of trainingKeys) {
    const count = value.training[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return undefined;
  }
  const featureWeights = emptyFeatureWeights();
  for (const feature of NUMERIC_FEATURES) {
    const weight = value.weights.features[feature];
    if (!assertFiniteWeight(weight)) return undefined;
    featureWeights[feature] = rounded(weight);
  }
  const sourceWeights = emptySourceWeights();
  for (const kind of SOURCE_KINDS) {
    const weight = value.weights.sourceKinds[kind];
    if (!assertFiniteWeight(weight)) return undefined;
    sourceWeights[kind] = rounded(weight);
  }

  let promotion: RankingPromotionReport | undefined;
  if (value.promotion !== undefined) {
    if (!isRecord(value.promotion)) return undefined;
    const parsedPromotion = parsePromotionReport(value.promotion);
    if (!parsedPromotion) return undefined;
    promotion = parsedPromotion;
  }

  const parsedWithoutChecksum: Omit<LearnedRankingModel, "checksum"> = {
    schemaVersion: RANKING_MODEL_SCHEMA_VERSION,
    featureVersion: RANKING_FEATURE_VERSION,
    algorithm: RANKING_ALGORITHM,
    modelId: value.modelId,
    createdAt: value.createdAt,
    training: {
      sampleCount: value.training.sampleCount as number,
      positiveSamples: value.training.positiveSamples as number,
      negativeSamples: value.training.negativeSamples as number,
      repositoryCount: value.training.repositoryCount as number,
    },
    weights: { bias: rounded(value.weights.bias), features: featureWeights, sourceKinds: sourceWeights },
    ...(promotion ? { promotion } : {}),
  };
  const expectedChecksum = sha256(stableStringify(modelPayload(parsedWithoutChecksum)));
  if (expectedChecksum !== value.checksum) return undefined;
  const expectedId = sealModel({
    schemaVersion: parsedWithoutChecksum.schemaVersion,
    featureVersion: parsedWithoutChecksum.featureVersion,
    algorithm: parsedWithoutChecksum.algorithm,
    createdAt: parsedWithoutChecksum.createdAt,
    training: parsedWithoutChecksum.training,
    weights: parsedWithoutChecksum.weights,
    ...(promotion ? { promotion } : {}),
  }).modelId;
  if (expectedId !== value.modelId) return undefined;
  return { ...parsedWithoutChecksum, checksum: value.checksum };
}

function parsePromotionReport(value: Record<string, unknown>): RankingPromotionReport | undefined {
  if (!hasOnlyKeys(value, [
    "reportVersion",
    "fixtureCount",
    "heldOutRepositories",
    "minimumHeldOutRepositories",
    "baselineQualityScore",
    "learnedQualityScore",
    "qualityScoreDelta",
    "baselineExactIdentifierRecall",
    "learnedExactIdentifierRecall",
    "exactIdentifierRecallDelta",
    "privacyViolationDelta",
    "atomicityFailureDelta",
    "overflowDelta",
    "measuredP95LatencyMs",
    "latencyBudgetMs",
    "deterministic",
    "eligible",
    "reasons",
  ])
    || value.reportVersion !== "ranking-promotion-v1"
    || typeof value.deterministic !== "boolean"
    || typeof value.eligible !== "boolean"
    || !Array.isArray(value.reasons)
    || value.reasons.some((reason) => typeof reason !== "string" || reason.length > 300)) return undefined;
  const integerKeys = ["fixtureCount", "heldOutRepositories", "minimumHeldOutRepositories"] as const;
  for (const key of integerKeys) {
    if (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || value[key] < 0) return undefined;
  }
  const numericKeys = [
    "baselineQualityScore",
    "learnedQualityScore",
    "qualityScoreDelta",
    "baselineExactIdentifierRecall",
    "learnedExactIdentifierRecall",
    "exactIdentifierRecallDelta",
    "privacyViolationDelta",
    "atomicityFailureDelta",
    "overflowDelta",
    "measuredP95LatencyMs",
    "latencyBudgetMs",
  ] as const;
  for (const key of numericKeys) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) return undefined;
  }
  if ((value.minimumHeldOutRepositories as number) < 1
    || (value.baselineQualityScore as number) < 0 || (value.baselineQualityScore as number) > 1
    || (value.learnedQualityScore as number) < 0 || (value.learnedQualityScore as number) > 1
    || (value.baselineExactIdentifierRecall as number) < 0
    || (value.baselineExactIdentifierRecall as number) > 1
    || (value.learnedExactIdentifierRecall as number) < 0
    || (value.learnedExactIdentifierRecall as number) > 1
    || (value.measuredP95LatencyMs as number) < 0
    || (value.latencyBudgetMs as number) <= 0) return undefined;
  const parsed = value as unknown as RankingPromotionReport;
  return promotionReportPasses(parsed) === parsed.eligible ? parsed : undefined;
}

function promotionReportPasses(report: RankingPromotionReport): boolean {
  return report.reasons.length === 0
    && report.fixtureCount > 0
    && report.heldOutRepositories >= report.minimumHeldOutRepositories
    && report.minimumHeldOutRepositories >= 1
    && report.qualityScoreDelta > 0
    && report.exactIdentifierRecallDelta >= 0
    && report.privacyViolationDelta <= 0
    && report.atomicityFailureDelta <= 0
    && report.overflowDelta <= 0
    && report.measuredP95LatencyMs <= report.latencyBudgetMs
    && report.deterministic;
}

function normalizedTrainingSamples(samples: readonly RankingTrainingSample[]): RankingTrainingSample[] {
  const unique = new Map<string, RankingTrainingSample>();
  for (const sample of samples) {
    if (!ID_PATTERN.test(sample.sampleId)
      || !HASH_PATTERN.test(sample.repositoryHash)
      || !HASH_PATTERN.test(sample.candidateKeyHash)
      || (sample.labelSource !== "feedback" && sample.labelSource !== "replay")
      || (sample.label !== "useful" && sample.label !== "irrelevant")
      || !isPrivacyClassification(sample.classification)) {
      throw new Error(`Invalid ranking training sample ${sample.sampleId || "<unknown>"}`);
    }
    const features = parseRankingFeatures(sample.features);
    if (!features) throw new Error(`Invalid ranking features for sample ${sample.sampleId}`);
    if (!unique.has(sample.sampleId)) unique.set(sample.sampleId, { ...sample, features });
  }
  return [...unique.values()].sort((left, right) => left.sampleId.localeCompare(right.sampleId));
}

export function trainLearnedRankingModel(
  samples: readonly RankingTrainingSample[],
  options: { createdAt: number; minimumSamples?: number },
): LearnedRankingModel {
  const normalized = normalizedTrainingSamples(samples);
  const minimumSamples = options.minimumSamples ?? 20;
  if (!Number.isSafeInteger(minimumSamples) || minimumSamples < 2) {
    throw new Error("Ranking minimumSamples must be an integer of at least 2");
  }
  if (normalized.length < minimumSamples) {
    throw new Error(`Ranking training requires at least ${minimumSamples} unique samples`);
  }
  if (!Number.isSafeInteger(options.createdAt) || options.createdAt < 0) {
    throw new Error("Ranking model timestamp is invalid");
  }
  const positives = normalized.filter((sample) => sample.label === "useful");
  const negatives = normalized.filter((sample) => sample.label === "irrelevant");
  if (positives.length === 0 || negatives.length === 0) {
    throw new Error("Ranking training requires both useful and irrelevant labels");
  }

  const featureWeights = emptyFeatureWeights();
  for (const feature of NUMERIC_FEATURES) {
    const positiveMean = positives.reduce((sum, sample) => sum + sample.features[feature], 0) / positives.length;
    const negativeMean = negatives.reduce((sum, sample) => sum + sample.features[feature], 0) / negatives.length;
    featureWeights[feature] = boundedWeight((positiveMean - negativeMean) * 4);
  }
  const sourceWeights = emptySourceWeights();
  for (const kind of SOURCE_KINDS) {
    const positiveRate = positives.filter((sample) => sample.features.sourceKind === kind).length / positives.length;
    const negativeRate = negatives.filter((sample) => sample.features.sourceKind === kind).length / negatives.length;
    sourceWeights[kind] = boundedWeight((positiveRate - negativeRate) * 2);
  }
  const positiveRate = positives.length / normalized.length;
  const bias = boundedWeight((positiveRate - 0.5) * 2);

  return sealModel({
    schemaVersion: RANKING_MODEL_SCHEMA_VERSION,
    featureVersion: RANKING_FEATURE_VERSION,
    algorithm: RANKING_ALGORITHM,
    createdAt: options.createdAt,
    training: {
      sampleCount: normalized.length,
      positiveSamples: positives.length,
      negativeSamples: negatives.length,
      repositoryCount: new Set(normalized.map((sample) => sample.repositoryHash)).size,
    },
    weights: { bias, features: featureWeights, sourceKinds: sourceWeights },
  });
}

function scoreValidatedRankingCandidate(
  model: LearnedRankingModel,
  features: RankingFeatureVector,
): number {
  let score = model.weights.bias + model.weights.sourceKinds[features.sourceKind];
  for (const feature of NUMERIC_FEATURES) score += model.weights.features[feature] * features[feature];
  return rounded(score);
}

export function scoreLearnedRankingCandidate(
  model: LearnedRankingModel,
  features: RankingFeatureVector,
): number {
  const parsedModel = parseLearnedRankingModel(model);
  const parsedFeatures = parseRankingFeatures(features);
  if (!parsedModel || !parsedFeatures) throw new Error("Learned ranking model or features are invalid");
  return scoreValidatedRankingCandidate(parsedModel, parsedFeatures);
}

function staticOrder<T>(candidates: readonly RankingCandidate<T>[]): RankingCandidate<T>[] {
  return [...candidates].sort((left, right) =>
    right.staticScore - left.staticScore || left.id.localeCompare(right.id)
  );
}

function rankShift(
  staticRanks: ReadonlyMap<string, number>,
  learnedRanks: ReadonlyMap<string, number>,
): { disagreements: number; meanShift: number } {
  const ids = [...staticRanks.keys()];
  let disagreements = 0;
  for (let leftIndex = 0; leftIndex < ids.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex++) {
      const left = ids[leftIndex];
      const right = ids[rightIndex];
      if (!left || !right) continue;
      const staticDirection = (staticRanks.get(left) ?? 0) - (staticRanks.get(right) ?? 0);
      const learnedDirection = (learnedRanks.get(left) ?? 0) - (learnedRanks.get(right) ?? 0);
      if (Math.sign(staticDirection) !== Math.sign(learnedDirection)) disagreements++;
    }
  }
  const totalShift = ids.reduce(
    (sum, id) => sum + Math.abs((staticRanks.get(id) ?? 0) - (learnedRanks.get(id) ?? 0)),
    0,
  );
  return { disagreements, meanShift: ids.length > 0 ? rounded(totalShift / ids.length) : 0 };
}

function fallbackResult<T>(
  candidates: readonly RankingCandidate<T>[],
  mode: RankingMode,
  startedAt: number,
  now: () => number,
  reason: string,
  modelId?: string,
): RankingResult<T> {
  const ordered = staticOrder(candidates);
  return {
    ranked: ordered.map((candidate, index) => ({
      ...candidate,
      staticRank: index,
      learnedRank: index,
      learnedScore: candidate.staticScore,
      effectiveScore: candidate.staticScore,
    })),
    diagnostics: {
      mode,
      status: mode === "off" ? "off" : "fallback",
      featureVersion: RANKING_FEATURE_VERSION,
      ...(modelId ? { modelId } : {}),
      candidateCount: candidates.length,
      topChanged: false,
      pairwiseDisagreements: 0,
      meanRankShift: 0,
      durationMs: Math.max(0, now() - startedAt),
      ...(mode === "off" ? {} : { fallbackReason: reason }),
    },
  };
}

export function rankCandidates<T>(
  candidates: readonly RankingCandidate<T>[],
  options: {
    mode: RankingMode;
    model?: LearnedRankingModel;
    now?: () => number;
    /** Runtime p95/inference ceiling; active mode falls back when exceeded. */
    maxLatencyMs?: number;
  },
): RankingResult<T> {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  if (options.mode === "off") return fallbackResult(candidates, "off", startedAt, now, "ranking disabled");
  if (!options.model) return fallbackResult(candidates, options.mode, startedAt, now, "ranking model is missing");
  const model = parseLearnedRankingModel(options.model);
  if (!model) return fallbackResult(candidates, options.mode, startedAt, now, "ranking model is corrupt or incompatible");
  if (options.mode === "active" && (!model.promotion || !promotionReportPasses(model.promotion))) {
    return fallbackResult(candidates, options.mode, startedAt, now, "ranking model has not passed the promotion gate", model.modelId);
  }
  if (options.mode === "active" && options.maxLatencyMs !== undefined
    && (!Number.isFinite(options.maxLatencyMs) || options.maxLatencyMs <= 0
      || (model.promotion?.measuredP95LatencyMs ?? Number.POSITIVE_INFINITY) > options.maxLatencyMs)) {
    return fallbackResult(candidates, options.mode, startedAt, now, "ranking model exceeds the configured latency gate", model.modelId);
  }
  const candidateIds = new Set<string>();
  if (candidates.some((candidate) => {
    const invalid = !candidate.id
      || candidateIds.has(candidate.id)
      || !Number.isFinite(candidate.staticScore)
      || !parseRankingFeatures(candidate.features);
    candidateIds.add(candidate.id);
    return invalid;
  })) {
    return fallbackResult(candidates, options.mode, startedAt, now, "ranking candidate features or IDs are invalid", model.modelId);
  }

  const staticallyRanked = staticOrder(candidates);
  const learned = candidates.map((candidate) => ({
    candidate,
    learnedScore: scoreValidatedRankingCandidate(model, candidate.features),
  })).sort((left, right) =>
    right.learnedScore - left.learnedScore
    || right.candidate.staticScore - left.candidate.staticScore
    || left.candidate.id.localeCompare(right.candidate.id)
  );
  const staticRanks = new Map(staticallyRanked.map((candidate, index) => [candidate.id, index]));
  const learnedRanks = new Map(learned.map((item, index) => [item.candidate.id, index]));
  const learnedScores = new Map(learned.map((item) => [item.candidate.id, item.learnedScore]));
  const order = options.mode === "active" ? learned.map((item) => item.candidate) : staticallyRanked;
  const shifts = rankShift(staticRanks, learnedRanks);
  const durationMs = Math.max(0, now() - startedAt);
  if (options.mode === "active" && options.maxLatencyMs !== undefined && durationMs > options.maxLatencyMs) {
    return fallbackResult(candidates, options.mode, startedAt, now, "learned inference exceeded the configured latency budget", model.modelId);
  }
  return {
    ranked: order.map((candidate) => ({
      ...candidate,
      staticRank: staticRanks.get(candidate.id) ?? 0,
      learnedRank: learnedRanks.get(candidate.id) ?? 0,
      learnedScore: learnedScores.get(candidate.id) ?? candidate.staticScore,
      effectiveScore: options.mode === "active"
        ? learnedScores.get(candidate.id) ?? candidate.staticScore
        : candidate.staticScore,
    })),
    diagnostics: {
      mode: options.mode,
      status: options.mode,
      featureVersion: RANKING_FEATURE_VERSION,
      modelId: model.modelId,
      candidateCount: candidates.length,
      topChanged: staticallyRanked[0]?.id !== learned[0]?.candidate.id,
      pairwiseDisagreements: shifts.disagreements,
      meanRankShift: shifts.meanShift,
      durationMs,
    },
  };
}

interface PromotionPlan {
  selected: RankingPromotionCandidate[];
  overflow: boolean;
  atomicityFailures: number;
  privacyViolations: number;
}

function promotionPlan(
  fixture: RankingPromotionFixture,
  ordered: readonly RankingPromotionCandidate[],
): PromotionPlan {
  const groups = new Map<string, RankingPromotionCandidate[]>();
  for (const candidate of ordered) {
    const group = groups.get(candidate.groupId) ?? [];
    group.push(candidate);
    groups.set(candidate.groupId, group);
  }
  const selected: RankingPromotionCandidate[] = [];
  let tokens = 0;
  for (const candidate of ordered) {
    if (selected.some((item) => item.groupId === candidate.groupId)) continue;
    const group = groups.get(candidate.groupId) ?? [candidate];
    const groupTokens = group.reduce((sum, item) => sum + item.tokens, 0);
    if (selected.length + group.length > fixture.maxResults || tokens + groupTokens > fixture.maxTokens) continue;
    selected.push(...group);
    tokens += groupTokens;
  }
  const selectedGroups = new Map<string, number>();
  for (const candidate of selected) {
    selectedGroups.set(candidate.groupId, (selectedGroups.get(candidate.groupId) ?? 0) + 1);
  }
  const atomicityFailures = [...selectedGroups].filter(([groupId, count]) =>
    count !== (groups.get(groupId)?.length ?? 0)
  ).length;
  return {
    selected,
    overflow: selected.length > fixture.maxResults || tokens > fixture.maxTokens,
    atomicityFailures,
    privacyViolations: selected.filter((candidate) => candidate.features.classificationEligible < 1).length,
  };
}

function promotionMetrics(fixtures: readonly RankingPromotionFixture[], model?: LearnedRankingModel): {
  qualityScore: number;
  exactRecall: number;
  privacyViolations: number;
  atomicityFailures: number;
  overflow: number;
  signatures: string[];
} {
  let relevantAvailable = 0;
  let relevantSelected = 0;
  let irrelevantTokens = 0;
  let selectedTokens = 0;
  let exactAvailable = 0;
  let exactSelected = 0;
  let privacyViolations = 0;
  let atomicityFailures = 0;
  let overflow = 0;
  const signatures: string[] = [];
  for (const fixture of fixtures) {
    const ordered = model
      ? rankCandidates(fixture.candidates.map((candidate) => ({
          id: candidate.id,
          staticScore: candidate.staticScore,
          features: candidate.features,
          value: candidate,
        })), { mode: "shadow", model, now: () => 0 }).ranked
          .sort((left, right) => left.learnedRank - right.learnedRank)
          .map((candidate) => candidate.value)
      : [...fixture.candidates].sort((left, right) =>
          right.staticScore - left.staticScore || left.id.localeCompare(right.id)
        );
    const plan = promotionPlan(fixture, ordered);
    signatures.push(plan.selected.map((candidate) => candidate.id).join(","));
    relevantAvailable += fixture.candidates.filter((candidate) => candidate.relevant).length;
    relevantSelected += plan.selected.filter((candidate) => candidate.relevant).length;
    exactAvailable += fixture.candidates.filter((candidate) => candidate.relevant && candidate.exactIdentifier).length;
    exactSelected += plan.selected.filter((candidate) => candidate.relevant && candidate.exactIdentifier).length;
    selectedTokens += plan.selected.reduce((sum, candidate) => sum + candidate.tokens, 0);
    irrelevantTokens += plan.selected
      .filter((candidate) => !candidate.relevant)
      .reduce((sum, candidate) => sum + candidate.tokens, 0);
    privacyViolations += plan.privacyViolations;
    atomicityFailures += plan.atomicityFailures;
    overflow += Number(plan.overflow);
  }
  const recall = relevantAvailable > 0 ? relevantSelected / relevantAvailable : 1;
  const precisionByTokens = selectedTokens > 0 ? 1 - irrelevantTokens / selectedTokens : 1;
  const atomicity = atomicityFailures === 0 ? 1 : 0;
  const noOverflow = overflow === 0 ? 1 : 0;
  return {
    qualityScore: rounded(recall * 0.6 + precisionByTokens * 0.2 + atomicity * 0.1 + noOverflow * 0.1),
    exactRecall: exactAvailable > 0 ? rounded(exactSelected / exactAvailable) : 1,
    privacyViolations,
    atomicityFailures,
    overflow,
    signatures,
  };
}

function validatePromotionFixture(fixture: RankingPromotionFixture): void {
  if (!ID_PATTERN.test(fixture.fixtureId) || !HASH_PATTERN.test(fixture.repositoryHash)) {
    throw new Error(`Invalid ranking promotion fixture ${fixture.fixtureId || "<unknown>"}`);
  }
  if (!Number.isSafeInteger(fixture.maxResults) || fixture.maxResults < 1
    || !Number.isSafeInteger(fixture.maxTokens) || fixture.maxTokens < 1) {
    throw new Error(`Invalid ranking promotion budget for ${fixture.fixtureId}`);
  }
  const ids = new Set<string>();
  for (const candidate of fixture.candidates) {
    if (!ID_PATTERN.test(candidate.id) || !ID_PATTERN.test(candidate.groupId) || ids.has(candidate.id)
      || !Number.isSafeInteger(candidate.tokens) || candidate.tokens < 0
      || !Number.isFinite(candidate.staticScore)
      || !parseRankingFeatures(candidate.features)) {
      throw new Error(`Invalid ranking promotion candidate in ${fixture.fixtureId}`);
    }
    ids.add(candidate.id);
  }
}

export function evaluateRankingPromotion(
  modelInput: LearnedRankingModel,
  fixtures: readonly RankingPromotionFixture[],
  options: RankingPromotionOptions,
): RankingPromotionReport {
  const model = parseLearnedRankingModel(modelInput);
  if (!model) throw new Error("Cannot evaluate an invalid ranking model");
  if (fixtures.length === 0) throw new Error("Ranking promotion requires held-out fixtures");
  fixtures.forEach(validatePromotionFixture);
  if (!Number.isFinite(options.measuredP95LatencyMs) || options.measuredP95LatencyMs < 0
    || !Number.isFinite(options.latencyBudgetMs) || options.latencyBudgetMs <= 0) {
    throw new Error("Ranking promotion latency values are invalid");
  }
  const minimumHeldOutRepositories = options.minimumHeldOutRepositories ?? 2;
  if (!Number.isSafeInteger(minimumHeldOutRepositories) || minimumHeldOutRepositories < 1) {
    throw new Error("Ranking promotion minimumHeldOutRepositories must be a positive integer");
  }
  const baseline = promotionMetrics(fixtures);
  const learned = promotionMetrics(fixtures, model);
  const repeated = promotionMetrics(fixtures, model);
  const heldOutRepositories = new Set(fixtures.map((fixture) => fixture.repositoryHash)).size;
  const deterministic = stableStringify(learned.signatures) === stableStringify(repeated.signatures);
  const qualityScoreDelta = rounded(learned.qualityScore - baseline.qualityScore);
  const exactIdentifierRecallDelta = rounded(learned.exactRecall - baseline.exactRecall);
  const privacyViolationDelta = learned.privacyViolations - baseline.privacyViolations;
  const atomicityFailureDelta = learned.atomicityFailures - baseline.atomicityFailures;
  const overflowDelta = learned.overflow - baseline.overflow;
  const reasons = [
    ...(qualityScoreDelta > 0 ? [] : ["primary quality score did not improve"]),
    ...(exactIdentifierRecallDelta >= 0 ? [] : ["exact-identifier recall regressed"]),
    ...(privacyViolationDelta <= 0 ? [] : ["privacy violations increased"]),
    ...(atomicityFailureDelta <= 0 ? [] : ["atomicity failures increased"]),
    ...(overflowDelta <= 0 ? [] : ["overflow increased"]),
    ...(options.measuredP95LatencyMs <= options.latencyBudgetMs ? [] : ["planner latency budget exceeded"]),
    ...(deterministic ? [] : ["inference ordering was not deterministic"]),
    ...(heldOutRepositories >= minimumHeldOutRepositories
      ? []
      : [`fewer than ${minimumHeldOutRepositories} held-out repositories`]),
  ];
  return {
    reportVersion: "ranking-promotion-v1",
    fixtureCount: fixtures.length,
    heldOutRepositories,
    minimumHeldOutRepositories,
    baselineQualityScore: baseline.qualityScore,
    learnedQualityScore: learned.qualityScore,
    qualityScoreDelta,
    baselineExactIdentifierRecall: baseline.exactRecall,
    learnedExactIdentifierRecall: learned.exactRecall,
    exactIdentifierRecallDelta,
    privacyViolationDelta,
    atomicityFailureDelta,
    overflowDelta,
    measuredP95LatencyMs: rounded(options.measuredP95LatencyMs),
    latencyBudgetMs: rounded(options.latencyBudgetMs),
    deterministic,
    eligible: reasons.length === 0,
    reasons,
  };
}

export function withRankingPromotion(
  modelInput: LearnedRankingModel,
  promotion: RankingPromotionReport,
): LearnedRankingModel {
  const model = parseLearnedRankingModel(modelInput);
  const parsedPromotion = parsePromotionReport(promotion as unknown as Record<string, unknown>);
  if (!model || !parsedPromotion) throw new Error("Cannot promote an invalid ranking model or report");
  return sealModel({
    schemaVersion: model.schemaVersion,
    featureVersion: model.featureVersion,
    algorithm: model.algorithm,
    createdAt: model.createdAt,
    training: { ...model.training },
    weights: {
      bias: model.weights.bias,
      features: { ...model.weights.features },
      sourceKinds: { ...model.weights.sourceKinds },
    },
    promotion: parsedPromotion,
  });
}

export function loadLearnedRankingModel(path: string): { model?: LearnedRankingModel; error?: string } {
  try {
    if (statSync(path).size > MAX_RANKING_MODEL_BYTES) {
      return { error: `ranking model exceeds ${MAX_RANKING_MODEL_BYTES} bytes` };
    }
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const model = parseLearnedRankingModel(parsed);
    return model ? { model } : { error: "ranking model is corrupt or incompatible" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function saveLearnedRankingModel(path: string, modelInput: LearnedRankingModel): void {
  const model = parseLearnedRankingModel(modelInput);
  if (!model) throw new Error("Cannot save an invalid ranking model");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${stableStringify(model)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }
}

export function disabledRankingDiagnostics(mode: RankingMode = "off"): RankingDiagnostics {
  return {
    mode,
    status: mode === "off" ? "off" : "fallback",
    featureVersion: RANKING_FEATURE_VERSION,
    candidateCount: 0,
    topChanged: false,
    pairwiseDisagreements: 0,
    meanRankShift: 0,
    durationMs: 0,
    ...(mode === "off" ? {} : { fallbackReason: "ranking model has not been loaded" }),
  };
}
