import { CORE_VERSION } from "ds4-context-core";
import {
  buildSummaryPrompt,
  classifyUnsupportedExactValueSpans,
  normalizeSummaryStructure,
} from "ds4-context-core/compaction/summary-contract";
import { EXTENSION_VERSION } from "./version.ts";

/**
 * Runtime guard for the engine↔core contract.
 *
 * Pi loads this extension from TypeScript source while `ds4-context-core` is a
 * prebuilt package resolved through normal module resolution. When those two
 * artifacts drift apart — a checkout that pulled new sources without rebuilding
 * `packages/core/dist`, or an npm update that moved only one of the two packages
 * — the extension keeps loading, and the first missing core export surfaces deep
 * inside compaction as `(0, _summaryContract.x) is not a function`, which reads
 * like a DS4 bug instead of an installation problem.
 *
 * The guard is deliberately kept off the load path: Pi treats an extension load
 * failure as fatal (`process.exit(1)`), so throwing at module scope would block
 * the whole runtime. It runs on the compaction path instead, where the mismatch
 * already breaks the run, and where the coordinator turns the thrown message
 * into the ordinary "DS4 compaction unavailable; using Pi default" warning.
 *
 * `CORE_VERSION` is imported from the package root rather than a new subpath so
 * that a stale core without the marker still resolves: a missing *file* would be
 * a module-resolution failure, while a missing named export simply arrives as
 * `undefined` through Pi's CommonJS interop.
 */

export interface CoreCompatibilityIssue {
  kind: "version" | "export";
  detail: string;
}

/** Pure inspection, so the guard is testable without a broken installation. */
export function inspectCoreCompatibility(input: {
  extensionVersion: string;
  coreVersion: unknown;
  requiredExports: readonly (readonly [string, unknown])[];
}): CoreCompatibilityIssue[] {
  const issues: CoreCompatibilityIssue[] = [];
  if (typeof input.coreVersion !== "string" || input.coreVersion.length === 0) {
    issues.push({
      kind: "version",
      detail:
        `the resolved ds4-context-core does not export CORE_VERSION, so it predates ${input.extensionVersion}`,
    });
  } else if (input.coreVersion !== input.extensionVersion) {
    issues.push({
      kind: "version",
      detail:
        `ds4-context-core resolves to ${input.coreVersion} while DS4 Context Engine is ${input.extensionVersion}`,
    });
  }
  for (const [name, value] of input.requiredExports) {
    if (typeof value !== "function") {
      issues.push({
        kind: "export",
        detail: `ds4-context-core does not export ${name}()`,
      });
    }
  }
  return issues;
}

/**
 * Core entry points this extension calls. Extend this list whenever the engine
 * starts requiring a newer core symbol; `CORE_VERSION` equality already covers
 * whole-artifact drift, and these probes name the exact missing symbol.
 */
const REQUIRED_CORE_EXPORTS: readonly (readonly [string, unknown])[] = [
  ["buildSummaryPrompt", buildSummaryPrompt],
  ["classifyUnsupportedExactValueSpans", classifyUnsupportedExactValueSpans],
  ["normalizeSummaryStructure", normalizeSummaryStructure],
];

export function coreCompatibilityIssues(): CoreCompatibilityIssue[] {
  return inspectCoreCompatibility({
    extensionVersion: EXTENSION_VERSION,
    coreVersion: CORE_VERSION,
    requiredExports: REQUIRED_CORE_EXPORTS,
  });
}

/** Single-line message: it is appended to the existing fallback notification. */
export function coreCompatibilityMessage(
  issues: readonly CoreCompatibilityIssue[],
): string {
  return `${issues.map((issue) => issue.detail).join("; ")}. Fix: rebuild the checkout `
    + "(\"npm ci && npm run build:core && npm run build:adapters\") or update the installed package "
    + "(\"pi update --extensions\"), then restart Pi: a /reload can keep the old core module cached.";
}

/** Throws an actionable error instead of a downstream `is not a function`. */
export function assertCoreCompatibility(): void {
  const issues = coreCompatibilityIssues();
  if (issues.length > 0) throw new Error(coreCompatibilityMessage(issues));
}
