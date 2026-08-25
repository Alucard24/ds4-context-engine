import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  calculateContextBudget,
  createDefaultConfig,
  createModelProfile,
} from "ds4-context-core";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("portable core boundary", () => {
  it("has no Pi or adapter imports", () => {
    const root = resolve("packages/core/src");
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      expect(source, relative(root, file)).not.toMatch(/@earendil-works\/pi(?:-ai|-coding-agent)?/u);
      expect(source, relative(root, file)).not.toMatch(/(?:src\/|\.\.\/)(?:pi-adapter|extension)(?:\/|$)/u);
    }
  });

  it("exposes compiled runtime-neutral policy", () => {
    const config = createDefaultConfig();
    const profile = createModelProfile({
      provider: "portable-test",
      id: "model",
      contextWindow: 128_000,
      maxTokens: 16_000,
    });
    const budget = calculateContextBudget(profile, config.context);

    expect(profile.provider).toBe("portable-test");
    expect(budget.contextWindow).toBe(128_000);
    expect(budget.activeInputBudget).toBeGreaterThan(0);
    expect(budget.activeInputBudget).toBeLessThanOrEqual(budget.hardInputLimit);
  });
});
