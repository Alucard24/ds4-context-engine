import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelDescriptor } from "ds4-context-core/core/model-profile";

export interface PiSessionSnapshot {
  sessionId: string;
  sessionFile?: string;
  projectPath: string;
  leafId?: string;
  totalEntries: number;
  branchEntries: number;
}

type SessionContext = Pick<ExtensionContext, "cwd" | "sessionManager">;

export function snapshotSession(ctx: SessionContext): PiSessionSnapshot {
  const sessionFile = ctx.sessionManager.getSessionFile();
  const leafId = ctx.sessionManager.getLeafId();

  return {
    sessionId: ctx.sessionManager.getSessionId(),
    ...(sessionFile ? { sessionFile } : {}),
    projectPath: ctx.cwd,
    ...(leafId ? { leafId } : {}),
    totalEntries: ctx.sessionManager.getEntries().length,
    branchEntries: ctx.sessionManager.getBranch().length,
  };
}

export function snapshotModel(ctx: Pick<ExtensionContext, "model">): ModelDescriptor | undefined {
  if (!ctx.model) return undefined;
  return {
    provider: ctx.model.provider,
    id: ctx.model.id,
    contextWindow: ctx.model.contextWindow,
    maxTokens: ctx.model.maxTokens,
    reasoning: ctx.model.reasoning,
    input: ctx.model.input,
  };
}
