import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { registerContextCommand } from "./commands.ts";
import { Ds4ContextRuntime, type RuntimeDependencies } from "./runtime.ts";

export type Ds4ExtensionDependencies = Partial<RuntimeDependencies>;

export function registerDs4ContextEngine(
  pi: ExtensionAPI,
  dependencies: Ds4ExtensionDependencies = {},
): Ds4ContextRuntime {
  const runtime = new Ds4ContextRuntime({
    agentDir: dependencies.agentDir ?? getAgentDir(),
    configDirName: dependencies.configDirName ?? CONFIG_DIR_NAME,
    ...(dependencies.homeDir ? { homeDir: dependencies.homeDir } : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.idGenerator ? { idGenerator: dependencies.idGenerator } : {}),
    ...(dependencies.logSink ? { logSink: dependencies.logSink } : {}),
  });

  registerContextCommand(pi, runtime);

  pi.on("session_start", (_event, ctx) => {
    runtime.openSession(ctx);
  });

  pi.on("context", (event, ctx) => runtime.transformContext(event, ctx, pi));

  pi.on("message_end", (event) => {
    runtime.recordAssistantUsage(event.message);
  });

  pi.on("tool_execution_end", (event) => {
    runtime.projectMayHaveChanged(event.toolName);
  });

  pi.on("agent_settled", (_event, ctx) => {
    runtime.afterAgentSettled(ctx);
  });

  pi.on("session_before_compact", (event, ctx) => runtime.beforeCompact(event, ctx));

  pi.on("session_compact", (event, ctx) => {
    runtime.afterCompaction(event, ctx);
  });

  pi.on("session_compact_failed", (event) => {
    runtime.compactionFailed(event);
  });

  pi.on("session_tree", (_event, ctx) => {
    runtime.syncSessionIndex(ctx);
  });

  pi.on("model_select", (event) => {
    runtime.modelChanged(event.model.provider, event.model.id);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    runtime.shutdown(ctx);
  });

  return runtime;
}

export default function ds4ContextEngine(pi: ExtensionAPI): void {
  registerDs4ContextEngine(pi);
}
