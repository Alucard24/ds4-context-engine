import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../../src/config/config.ts";
import {
  continuationItemHashes,
  NativeContinuationManager,
} from "../../src/continuation/native-continuation.ts";

describe("native continuation golden decision", () => {
  it("keeps exact suffix metadata deterministic and response IDs out of the manifest shape", () => {
    let clock = 100;
    const manager = new NativeContinuationManager({
      ...createDefaultConfig().nativeContinuation,
      enabled: true,
      allowProviderStorage: true,
      profiles: ["openai/*"],
    }, () => clock);
    manager.registerProvider("openai");
    const initialInput = [
      { role: "developer", content: "system" },
      { role: "user", content: "first" },
    ];
    const base = {
      model: "gpt-golden",
      input: initialInput,
      tools: [],
      stream: true,
      store: false,
    };
    const first = manager.prepare({
      payload: base,
      provider: "openai",
      model: "gpt-golden",
      api: "openai-responses",
      requestSessionId: "session-golden",
      canonicalSessionId: "session-golden",
      manifestId: "manifest-1",
      managed: true,
    });
    if (!first.attempt) throw new Error("Expected golden setup attempt");
    const responseItem = {
      type: "message",
      role: "assistant",
      id: "msg_golden",
      status: "completed",
      content: [{ type: "output_text", text: "answer", annotations: [] }],
    };
    manager.complete(first.attempt, "resp_private_golden", continuationItemHashes([responseItem]));
    clock = 150;
    const second = manager.prepare({
      payload: {
        ...base,
        input: [...initialInput, responseItem, { role: "user", content: "second" }],
      },
      provider: "openai",
      model: "gpt-golden",
      api: "openai-responses",
      requestSessionId: "session-golden",
      canonicalSessionId: "session-golden",
      manifestId: "manifest-2",
      managed: true,
    });

    const expected = JSON.parse(readFileSync(
      join(import.meta.dirname, "native-continuation-decision.json"),
      "utf8",
    ));
    expect(second.decision).toEqual(expected);
    expect(JSON.stringify(second.decision)).not.toContain("resp_private_golden");
  });
});
