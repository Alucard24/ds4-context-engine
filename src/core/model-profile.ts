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

export function defaultSafetyMargin(contextWindow: number): number {
  return Math.min(8192, Math.max(1024, Math.ceil(contextWindow * 0.02)));
}

export function createModelProfile(model: ModelDescriptor): ModelProfile {
  if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) {
    throw new Error("Model context window must be a positive number");
  }

  return {
    provider: model.provider,
    modelId: model.id,
    contextWindow: Math.floor(model.contextWindow),
    ...(model.maxTokens !== undefined && model.maxTokens > 0
      ? { maxOutputTokens: Math.floor(model.maxTokens) }
      : {}),
    safetyMarginTokens: defaultSafetyMargin(model.contextWindow),
    supportsImages: model.input?.includes("image") ?? false,
    supportsTools: true,
    supportsThinking: model.reasoning ?? false,
    tokenEstimator: "chars-v1",
  };
}
