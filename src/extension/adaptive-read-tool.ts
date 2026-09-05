import {
  createReadToolDefinition,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ReadToolOptions,
} from "@earendil-works/pi-coding-agent";

export function adaptiveReadLimit(contextWindow: number | undefined): number | undefined {
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  return contextWindow <= 8192 ? 120 : contextWindow <= 16384 ? 240 : 500;
}

export function createAdaptiveReadTool(cwd: string, options?: ReadToolOptions) {
  const base = createReadToolDefinition(cwd, options);
  return defineTool({
    ...base,
    description: `${base.description} Without an explicit limit, DS4 uses 120/240/500 lines for small/medium/large model context windows.`,
    async execute(id, input, signal, onUpdate, ctx) {
      // Tool-call hooks can mutate arguments after schema validation.
      if (!input || typeof input.path !== "string"
        || (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 1))
        || (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1))) {
        throw new Error("Read requires path and optional positive integer offset/limit");
      }
      const limit = input.limit ?? adaptiveReadLimit(ctx.model?.contextWindow);
      // Private copy only. Images and all byte/line-ending handling stay native.
      return createReadToolDefinition(ctx.cwd || cwd, options).execute(
        id, { ...input, ...(limit !== undefined ? { limit } : {}) }, signal, onUpdate, ctx,
      );
    },
  });
}

export function createAdaptiveReadRegistration(pi: ExtensionAPI) {
  let registered = false;
  return (enabled: boolean, ctx: ExtensionContext): void => {
    if (!enabled && !registered) return;
    const existing = pi.getAllTools().find((tool) => tool.name === "read");
    if (!registered && existing?.sourceInfo.source !== "builtin") {
      if (ctx.hasUI) ctx.ui.notify("DS4 adaptive read not registered: native read is unavailable or already overridden.", "warning");
      return;
    }
    pi.registerTool(enabled ? createAdaptiveReadTool(ctx.cwd) : createReadToolDefinition(ctx.cwd));
    registered = true;
  };
}
