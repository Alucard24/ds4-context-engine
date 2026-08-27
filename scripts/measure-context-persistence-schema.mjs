import {
  CONTEXT_PERSISTENCE_DESCRIPTION,
  CONTEXT_PERSISTENCE_PARAMS,
  CONTEXT_PERSISTENCE_TOOL_NAME,
} from "../src/extension/context-persistence-contract.ts";

const definition = {
  name: CONTEXT_PERSISTENCE_TOOL_NAME,
  description: CONTEXT_PERSISTENCE_DESCRIPTION,
  parameters: CONTEXT_PERSISTENCE_PARAMS,
};

const serialized = JSON.stringify(definition);
const bytes = Buffer.byteLength(serialized, "utf8");
// Reproducible conservative estimate used only for the contract gate. Provider-specific
// tokenizers are exercised separately in provider smoke tests.
const estimatedTokens = Math.ceil(bytes / 4);
const smallestTestedContext = 32_000;
const absoluteLimit = 1_500;
const relativeLimit = Math.floor(smallestTestedContext * 0.01);
const passed = estimatedTokens <= absoluteLimit && estimatedTokens <= relativeLimit;

console.log(JSON.stringify({
  contract: "ds4-context-persistence-tool-v1",
  bytes,
  estimatedTokens,
  absoluteLimit,
  smallestTestedContext,
  relativeLimit,
  passed,
}, null, 2));

if (!passed) process.exitCode = 1;
