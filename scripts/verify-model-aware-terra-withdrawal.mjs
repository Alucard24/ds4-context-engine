#!/usr/bin/env node
/** Terra-only fresh-session continuation; earlier Sol/Luna evidence is not repeated. */
import { pathToFileURL } from "node:url";
import { CAPS, runAuthorizedModels } from "./verify-model-aware-triad-withdrawal.mjs";

// The Terra-only authorization has been used: 12 provider requests reserved
// 1,449,079 estimated tokens and 4,310,843 controlled characters. Locked
// against replay; the previous 34-call round is also exhausted.
export const MODEL = "openai/gpt-5.6-terra";
export const LIMITS = Object.freeze({ calls: 13, inputPerCall: 600_000, inputTotal: 1_900_000,
  charsPerCall: 2_500_000, charsTotal: 6_000_000 });
export const LIVE_AUTHORIZED = false;
export function requireTerraAuthorization() {
  if (!LIVE_AUTHORIZED) throw new Error("New explicit numeric Terra-only provider budget required");
}
export async function main(argv = []) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--live")) throw new Error("Only --live is supported");
  if (argv.length === 0) return { mode: "dry-run", model: `openrouter/${MODEL}`, limits: LIMITS, caps: CAPS,
    stages: "8+ accepted samples, real expansion, 470k selected input, withdrawal in the same Pi session" };
  requireTerraAuthorization();
  return runAuthorizedModels([MODEL], LIMITS, requireTerraAuthorization);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`),
    () => { process.stderr.write("Probe stopped; no raw error details or automatic retry.\n"); process.exitCode = 1; },
  );
}
