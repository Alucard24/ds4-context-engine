import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "ds4-context-core/config/config";
import { HISTORY_TOOL_NAMES } from "../../src/extension/context-history-contract.ts";
import { registerContextHistoryTools } from "../../src/extension/context-history-tool.ts";
import type { Ds4ContextRuntime } from "../../src/extension/runtime.ts";

function fixture() {
  const config = createDefaultConfig();
  const registered: string[] = [];
  let active = ["read", "context_persistence"];
  const pi = {
    registerTool: (tool: { name: string }) => { registered.push(tool.name); },
    getActiveTools: () => [...active],
    setActiveTools: (tools: string[]) => { active = [...tools]; },
  };
  const runtime = { configSnapshot: () => ({ config }) };
  const sync = registerContextHistoryTools(pi as unknown as ExtensionAPI, runtime as unknown as Ds4ContextRuntime);
  return { config, registered, sync, active: () => active };
}

describe("history tool defaults", () => {
  it("activates all three tools at session start without configuration overrides", () => {
    const f = fixture();
    expect(f.registered).toEqual([...HISTORY_TOOL_NAMES]);
    f.sync(); f.sync();
    expect(f.active()).toEqual(["read", "context_persistence", ...HISTORY_TOOL_NAMES]);
  });

  it("honors disabled overrides without disabling unrelated tools", () => {
    const f = fixture();
    f.config.historyTools.enabled = false;
    f.sync();
    expect(f.active()).toEqual(["read", "context_persistence"]);
    f.config.historyTools.enabled = true;
    f.sync();
    expect(f.active()).toEqual(["read", "context_persistence", ...HISTORY_TOOL_NAMES]);
    f.config.enabled = false;
    f.sync();
    expect(f.active()).toEqual(["read", "context_persistence"]);
  });
});
