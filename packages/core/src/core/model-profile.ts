export interface ModelDescriptor {
  provider: string;
  id: string;
  contextWindow: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: readonly string[];
}

export interface ModelProfile {
  provider: string;
  modelId: string;
  contextWindow: number;
  maxOutputTokens?: number;
  safetyMarginTokens: number;
  supportsImages: boolean;
  supportsTools: boolean;
  supportsThinking: boolean;
  tokenEstimator: "chars-v1";
}

export interface ModelProfileAdjustments {
  contextWindow?: number;
  maxOutputTokens?: number;
  safetyMarginTokens?: number;
}

export function defaultSafetyMargin(contextWindow: number): number {
  return Math.min(8192, Math.max(1024, Math.ceil(contextWindow * 0.02)));
}

export function createModelProfile(
  model: ModelDescriptor,
  adjustments: ModelProfileAdjustments = {},
): ModelProfile {
  const contextWindow = adjustments.contextWindow ?? model.contextWindow;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new Error("Model context window must be a positive number");
  }
  const normalizedContextWindow = Math.floor(contextWindow);
  const outputTokens = adjustments.maxOutputTokens ?? model.maxTokens;
  const safetyMargin = adjustments.safetyMarginTokens ?? defaultSafetyMargin(normalizedContextWindow);
  if (!Number.isFinite(safetyMargin) || safetyMargin < 0) {
    throw new Error("Model safety margin must be a non-negative number");
  }

  return {
    provider: model.provider,
    modelId: model.id,
    contextWindow: normalizedContextWindow,
    ...(outputTokens !== undefined && outputTokens > 0
      ? { maxOutputTokens: Math.min(normalizedContextWindow, Math.floor(outputTokens)) }
      : {}),
    safetyMarginTokens: Math.min(normalizedContextWindow, Math.floor(safetyMargin)),
    supportsImages: model.input?.includes("image") ?? false,
    supportsTools: true,
    supportsThinking: model.reasoning ?? false,
    tokenEstimator: "chars-v1",
  };
}
