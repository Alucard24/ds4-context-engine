import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = process.argv[2]?.trim();
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
  throw new Error("Usage: npm run registry:check -- <exact-version>");
}

const packageNames = [
  "ds4-context-core",
  "ds4-context-reference-adapter",
  "ds4-context-engine",
];
const piVersions = {
  "@earendil-works/pi-ai": "0.84.3",
  "@earendil-works/pi-coding-agent": "0.84.3",
};
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const root = mkdtempSync(join(tmpdir(), "ds4-registry-smoke-"));
const consumer = join(root, "consumer");
const piState = join(root, "pi-state");
const npmConfig = join(root, ".npmrc");
mkdirSync(consumer, { recursive: true });
writeFileSync(npmConfig, "");

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? consumer,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
    fail(`${command} ${args.join(" ")} failed with exit code ${String(result.status)}${details ? `:\n${details}` : ""}`);
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseJsonLines(output) {
  return output
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        fail(`Pi RPC emitted a non-JSON line: ${line}`);
      }
    });
}

function isolatedNpmEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "npm_config_userconfig") delete environment[key];
  }
  environment.npm_config_userconfig = npmConfig;
  return environment;
}

try {
  writeFileSync(join(consumer, "package.json"), `${JSON.stringify({
    name: "ds4-registry-smoke-consumer",
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies: {
      ...piVersions,
      ...Object.fromEntries(packageNames.map((name) => [name, version])),
    },
  }, null, 2)}\n`);

  run(npmCommand, [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
  ], { env: isolatedNpmEnvironment() });

  for (const name of packageNames) {
    const manifestPath = join(consumer, "node_modules", name, "package.json");
    if (!existsSync(manifestPath)) fail(`Registry installation is missing ${name}`);
    const manifest = readJson(manifestPath);
    if (manifest.version !== version) {
      fail(`Expected ${name}@${version}, installed ${String(manifest.version)}`);
    }
  }
  const referenceManifest = readJson(join(
    consumer,
    "node_modules",
    "ds4-context-reference-adapter",
    "package.json",
  ));
  const piManifest = readJson(join(consumer, "node_modules", "ds4-context-engine", "package.json"));
  if (referenceManifest.dependencies?.["ds4-context-core"] !== version
    || piManifest.dependencies?.["ds4-context-core"] !== version) {
    fail("Published adapters do not depend exactly on the matching core version");
  }

  const coreSmoke = `
    import {
      CONFIG_SCHEMA_VERSION,
      RUNTIME_ADAPTER_CONTRACT_VERSION,
      createDefaultConfig,
      deriveLocalKvEligibility,
      negotiateRuntimeCapabilities,
    } from "ds4-context-core";
    import { planManagedContext } from "ds4-context-core/planner/context-planner";
    if (CONFIG_SCHEMA_VERSION !== "ds4-context-config-v1") {
      throw new Error("Published config schema is incompatible");
    }
    if (RUNTIME_ADAPTER_CONTRACT_VERSION !== "runtime-adapter-v1") {
      throw new Error("Published runtime adapter contract is incompatible");
    }
    if (typeof planManagedContext !== "function") {
      throw new Error("Published core subpath export is unavailable");
    }
    const capabilities = negotiateRuntimeCapabilities(
      [{ id: "compaction", supported: true, version: "registry-smoke-v1" }],
      [{ id: "compaction" }, { id: "local-kv-reuse" }],
    );
    if (capabilities.enabled[0] !== "compaction" || capabilities.disabled[0] !== "local-kv-reuse") {
      throw new Error("Published independent capability negotiation failed");
    }
    const eligibility = deriveLocalKvEligibility({
      enabled: true,
      capabilityEnabled: true,
      capabilityVersion: "registry-smoke-kv-v1",
      destination: "local",
      runtimeId: "registry-smoke",
      runtimeRevision: "runtime-1",
      provider: "ollama",
      model: "smoke-model",
      modelRevision: "model-1",
      privacyPolicyVersion: "privacy-1",
      promptPrefix: "stable-prefix",
      systemOptions: {},
      toolOptions: [],
      prefixTokenCount: 10,
      contextTokenCount: 12,
    });
    if (!eligibility.eligible || createDefaultConfig().localKvReuse.enabled !== false) {
      throw new Error("Published local KV export is unavailable or not opt-in");
    }
  `;
  run(process.execPath, ["--input-type=module", "--eval", coreSmoke]);

  const referenceSmoke = `
    import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { runRuntimeAdapterConformance } from "ds4-context-core/adapter/conformance";
    import {
      JsonlReferenceRuntimeAdapter,
      REFERENCE_ADAPTER_VERSION,
      createReferenceHistory,
    } from "ds4-context-reference-adapter";
    if (REFERENCE_ADAPTER_VERSION !== ${JSON.stringify(version)}) {
      throw new Error("Published reference runtime version is incompatible");
    }
    const report = await runRuntimeAdapterConformance({
      name: "registry-jsonl-reference",
      async create(fixture, transport) {
        const root = mkdtempSync(join(tmpdir(), "ds4-registry-reference-"));
        const projectRoot = join(root, "project");
        const historyFile = join(root, "session.jsonl");
        mkdirSync(projectRoot, { recursive: true });
        createReferenceHistory({
          historyFile,
          runtimeId: fixture.runtimeId,
          sessionId: fixture.sessionId,
          projectRoot,
          messages: fixture.messages,
        });
        return {
          adapter: new JsonlReferenceRuntimeAdapter({
            historyFile,
            runtimeId: fixture.runtimeId,
            projectRoot,
            model: fixture.model,
            transport,
          }),
          expectedProjectRoot: realpathSync(projectRoot),
          cleanup: () => rmSync(root, { recursive: true, force: true }),
        };
      },
    });
    if (!report.passed || report.cases.length !== 7) {
      throw new Error("Published reference adapter failed conformance");
    }
  `;
  run(process.execPath, ["--input-type=module", "--eval", referenceSmoke]);

  const qualityScript = join(
    consumer,
    "node_modules",
    "ds4-context-engine",
    "scripts",
    "compare-context-quality.mjs",
  );
  const quality = JSON.parse(run(process.execPath, [qualityScript]).stdout);
  if (quality.fixtureCount !== 4 || quality.strategies?.[0]?.strategyId !== "static-ranking-v0.1") {
    fail("Published quality corpus/comparison harness returned an invalid report");
  }

  const piCommand = join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "pi.cmd" : "pi",
  );
  const extensionPath = join(
    consumer,
    "node_modules",
    "ds4-context-engine",
    piManifest.pi.extensions[0].replace(/^\.\//u, ""),
  );
  const rpc = run(piCommand, [
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--approve",
    "--extension",
    extensionPath,
  ], {
    input: `${JSON.stringify({ type: "get_commands", id: "registry-smoke" })}\n`,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: piState,
      PI_CODING_AGENT_SESSION_DIR: join(piState, "sessions"),
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
    },
  });
  const messages = parseJsonLines(rpc.stdout);
  const response = messages.find((message) =>
    message.type === "response" && message.command === "get_commands" && message.id === "registry-smoke"
  );
  if (response?.success !== true
    || !Array.isArray(response.data?.commands)
    || !response.data.commands.some((command) => command.name === "context" && command.source === "extension")) {
    fail("Published Pi extension did not register /context");
  }
  if (messages.some((message) => message.type === "extension_error")) {
    fail("Published Pi extension emitted extension_error during startup or shutdown");
  }

  console.log(`Verified all DS4 registry packages at exact version ${version}.`);
} finally {
  if (process.env.DS4_KEEP_REGISTRY_TMP === "1") {
    console.log(`Kept registry smoke state at ${root}`);
  } else {
    rmSync(root, { recursive: true, force: true });
  }
}
