import { describe, expect, it } from "vitest";
import {
  assertCoreCompatibility,
  coreCompatibilityIssues,
  coreCompatibilityMessage,
  inspectCoreCompatibility,
} from "../../src/pi-adapter/core-compatibility.ts";

const probe = (name: string) => [name, () => undefined] as const;

describe("engine and core compatibility guard", () => {
  it("accepts a synchronized core that exposes the required entry points", () => {
    expect(inspectCoreCompatibility({
      extensionVersion: "0.4.6",
      coreVersion: "0.4.6",
      requiredExports: [probe("buildSummaryPrompt"), probe("classifyUnsupportedExactValueSpans")],
    })).toEqual([]);
  });

  it("names both versions when the resolved core is older than the extension", () => {
    const issues = inspectCoreCompatibility({
      extensionVersion: "0.4.6",
      coreVersion: "0.4.3",
      requiredExports: [],
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "version" });
    expect(issues[0]!.detail).toContain("0.4.3");
    expect(issues[0]!.detail).toContain("0.4.6");
  });

  it("reports a core build that predates the version marker", () => {
    const issues = inspectCoreCompatibility({
      extensionVersion: "0.4.6",
      coreVersion: undefined,
      requiredExports: [],
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "version" });
    expect(issues[0]!.detail).toContain("CORE_VERSION");
  });

  it.each(["classifyUnsupportedExactValueSpans", "normalizeSummaryStructure"])(
    "names the missing %s entry point instead of leaving an is-not-a-function error", (missingExport) => {
      const issues = inspectCoreCompatibility({
        extensionVersion: "0.4.6",
        coreVersion: "0.4.6",
        requiredExports: [probe("buildSummaryPrompt"), [missingExport, undefined]],
      });

      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ kind: "export" });
      expect(issues[0]!.detail).toContain(`${missingExport}()`);
    },
  );

  it("keeps the remedy in one line so the fallback notification stays readable", () => {
    const message = coreCompatibilityMessage([
      { kind: "version", detail: "ds4-context-core resolves to 0.4.3 while DS4 Context Engine is 0.4.6" },
    ]);

    expect(message).not.toContain("\n");
    expect(message).toContain("npm ci && npm run build:core && npm run build:adapters");
    expect(message).toContain("pi update --extensions");
    expect(message).toContain("restart Pi");
  });

  it("passes against the core artifact this repository resolves", () => {
    expect(coreCompatibilityIssues()).toEqual([]);
    expect(() => assertCoreCompatibility()).not.toThrow();
  });
});
