import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  compareQualityStrategies,
  staticRankingStrategy,
  taskWeightedCandidateStrategy,
} from "ds4-context-core/quality/context-quality";
import { stableStringify } from "ds4-context-core/shared/stable-json";

const corpusUrl = new URL("../quality/corpus-v1.json", import.meta.url);
const corpus = JSON.parse(readFileSync(fileURLToPath(corpusUrl), "utf8"));
const startedAt = performance.now();
const report = compareQualityStrategies(corpus, [
  staticRankingStrategy(),
  taskWeightedCandidateStrategy(),
]);
const durationMs = performance.now() - startedAt;

process.stdout.write(`${stableStringify(report)}\n`);
if (process.argv.includes("--timing")) {
  process.stderr.write(`quality comparison wall-clock: ${durationMs.toFixed(3)} ms\n`);
}
