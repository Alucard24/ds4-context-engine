import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const piCommand = join(
  repositoryRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "pi.cmd" : "pi",
);
const temporaryRoot = mkdtempSync(join(tmpdir(), "ds4-package-smoke-"));
const packDirectory = join(temporaryRoot, "packs");
const consumerDirectory = join(temporaryRoot, "consumer");
const piStateDirectory = join(temporaryRoot, "pi-state");
const isolatedNpmConfig = join(temporaryRoot, ".npmrc");
mkdirSync(packDirectory, { recursive: true });
mkdirSync(consumerDirectory, { recursive: true });
writeFileSync(isolatedNpmConfig, "");

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
    fail(`${command} ${args.join(" ")} failed with exit code ${String(result.status)}${details ? `:\n${details}` : ""}`);
  }

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function pack(args) {
  const result = run(npmCommand, ["pack", "--json", "--pack-destination", packDirectory, ...args]);
  const metadata = JSON.parse(result.stdout);
  if (!Array.isArray(metadata) || metadata.length !== 1) {
    fail(`Expected one npm pack result, received ${String(metadata.length)}`);
  }
  return metadata[0];
}

function verifyInventory(metadata, requiredPaths, forbiddenPrefixes) {
  const paths = new Set(metadata.files.map((file) => file.path));
  for (const requiredPath of requiredPaths) {
    if (!paths.has(requiredPath)) {
      fail(`${metadata.name} tarball is missing ${requiredPath}`);
    }
  }

  for (const path of paths) {
    if (forbiddenPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      fail(`${metadata.name} tarball unexpectedly contains ${path}`);
    }
  }
}

function isolatedNpmEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "npm_config_allow_scripts" || key.toLowerCase() === "npm_config_userconfig") {
      delete environment[key];
    }
  }
  environment.npm_config_userconfig = isolatedNpmConfig;
  return environment;
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

try {
  const rootPackage = readJson(join(repositoryRoot, "package.json"));
  const corePackage = readJson(join(repositoryRoot, "packages", "core", "package.json"));
  const referencePackage = readJson(join(repositoryRoot, "packages", "reference-adapter", "package.json"));

  if (rootPackage.version !== corePackage.version || referencePackage.version !== corePackage.version) {
    fail(
      `Package versions differ: pi=${rootPackage.version}, reference=${referencePackage.version}, core=${corePackage.version}`,
    );
  }
  if (rootPackage.dependencies?.[corePackage.name] !== corePackage.version
    || referencePackage.dependencies?.[corePackage.name] !== corePackage.version) {
    fail(`Every adapter must depend exactly on ${corePackage.name}@${corePackage.version}`);
  }
  const referenceRuntimeDependencies = {
    ...referencePackage.dependencies,
    ...referencePackage.peerDependencies,
  };
  if (Object.keys(referenceRuntimeDependencies).some((name) => name.includes("pi-ai") || name.includes("pi-coding-agent"))) {
    fail(`${referencePackage.name} must not depend on a Pi runtime SDK`);
  }
  if (!existsSync(piCommand)) {
    fail(`Pi executable is missing at ${piCommand}; run npm ci first`);
  }

  const corePack = pack(["--workspace", corePackage.name]);
  const referencePack = pack(["--workspace", referencePackage.name]);
  const adapterPack = pack([]);

  verifyInventory(
    corePack,
    [
      "package.json",
      "README.md",
      "LICENSE",
      "dist/index.js",
      "dist/index.d.ts",
      "dist/adapter/runtime-adapter.js",
      "dist/adapter/runtime-adapter.d.ts",
      "dist/adapter/conformance.js",
      "dist/adapter/conformance.d.ts",
      "dist/project/symbol-parser.js",
      "dist/project/symbol-parser.d.ts",
      "dist/retrieval/embedding.js",
      "dist/retrieval/embedding.d.ts",
      "dist/retrieval/semantic-index.js",
      "dist/retrieval/semantic-quality.js",
      "dist/persistence/repositories/embedding-repository.js",
    ],
    ["src", "tests", ".pi", "node_modules"],
  );
  verifyInventory(
    referencePack,
    [
      "package.json",
      "README.md",
      "LICENSE",
      "dist/index.js",
      "dist/index.d.ts",
    ],
    ["src", "tests", ".pi", "node_modules"],
  );
  verifyInventory(
    adapterPack,
    [
      "package.json",
      "README.md",
      "LICENSE",
      "src/extension/index.ts",
      "docs/PORTABLE_CORE.md",
      "docs/RUNTIME_ADAPTER_KIT.md",
      "docs/CONTEXT_QUALITY.md",
      "docs/RELEASE_READINESS_0.2.0.md",
      "docs/releases/0.2.0.md",
      "docs/releases/0.2.0-rc.1.md",
      "quality/corpus-v1.json",
      "quality/symbol-corpus-v1.json",
      "quality/semantic-corpus-v1.json",
      "scripts/compare-context-quality.mjs",
    ],
    ["packages", "tests", ".pi", "node_modules"],
  );

  const coreTarball = join(packDirectory, corePack.filename);
  const referenceTarball = join(packDirectory, referencePack.filename);
  const adapterTarball = join(packDirectory, adapterPack.filename);
  const consumerPackage = {
    name: "ds4-package-smoke-consumer",
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies: {
      ...rootPackage.peerDependencies,
      [corePackage.name]: `file:${coreTarball}`,
      [referencePackage.name]: `file:${referenceTarball}`,
      [rootPackage.name]: `file:${adapterTarball}`,
    },
  };
  writeFileSync(join(consumerDirectory, "package.json"), `${JSON.stringify(consumerPackage, null, 2)}\n`);

  run(
    npmCommand,
    ["install", "--no-audit", "--no-fund", "--package-lock=false", "--prefer-offline"],
    {
      cwd: consumerDirectory,
      env: isolatedNpmEnvironment(),
    },
  );

  const installedCorePackage = readJson(join(consumerDirectory, "node_modules", corePackage.name, "package.json"));
  const installedReferencePackage = readJson(
    join(consumerDirectory, "node_modules", referencePackage.name, "package.json"),
  );
  const installedAdapterPackage = readJson(join(consumerDirectory, "node_modules", rootPackage.name, "package.json"));
  if (installedCorePackage.version !== corePackage.version
    || installedReferencePackage.version !== referencePackage.version
    || installedAdapterPackage.version !== rootPackage.version) {
    fail("Clean consumer installed unexpected package versions");
  }

  const coreSmoke = `
    import {
      calculateContextBudget,
      CONFIG_SCHEMA_VERSION,
      createDefaultConfig,
      createModelProfile,
      deriveLocalKvEligibility,
      DeterministicRegexSymbolParser,
      negotiateRuntimeCapabilities,
      compareHybridRetrievalCorpus,
      reciprocalRankFusion,
    } from "ds4-context-core";
    import { planManagedContext } from "ds4-context-core/planner/context-planner";
    if (CONFIG_SCHEMA_VERSION !== "ds4-context-config-v1") {
      throw new Error("Portable config schema export is incompatible");
    }
    const profile = createModelProfile({
      provider: "package-smoke",
      id: "model",
      contextWindow: 128000,
      maxTokens: 16000,
    });
    const budget = calculateContextBudget(profile, createDefaultConfig().context);
    if (!Number.isSafeInteger(budget.hardInputLimit) || budget.hardInputLimit <= 0) {
      throw new Error("Portable core returned an invalid context budget");
    }
    if (typeof planManagedContext !== "function") {
      throw new Error("Portable core subpath export is unavailable");
    }
    const parsed = new DeterministicRegexSymbolParser().parse({
      projectPath: "/smoke",
      filePath: "src/service.ts",
      fileHash: "a".repeat(64),
      language: "typescript",
      content: "export class Service {}",
    });
    if (parsed?.symbols[0]?.qualifiedName !== "Service") {
      throw new Error("Portable structural symbol parser is unavailable");
    }
    if (typeof compareHybridRetrievalCorpus !== "function"
      || reciprocalRankFusion([{ rank: 0, weight: 1 }]) <= 0) {
      throw new Error("Portable hybrid retrieval exports are unavailable");
    }
    const capability = negotiateRuntimeCapabilities(
      [{ id: "compaction", supported: true, version: "smoke-v1" }],
      [{ id: "compaction" }, { id: "local-kv-reuse" }],
    );
    if (capability.enabled[0] !== "compaction" || capability.disabled[0] !== "local-kv-reuse") {
      throw new Error("Portable runtime adapter negotiation is unavailable");
    }
    const localKv = deriveLocalKvEligibility({
      enabled: true,
      capabilityEnabled: true,
      capabilityVersion: "smoke-kv-v1",
      destination: "local",
      runtimeId: "package-smoke",
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
    if (!localKv.eligible || createDefaultConfig().localKvReuse.enabled !== false) {
      throw new Error("Portable local KV eligibility export is unavailable or not opt-in");
    }
  `;
  run(process.execPath, ["--input-type=module", "--eval", coreSmoke], { cwd: consumerDirectory });

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
    if (REFERENCE_ADAPTER_VERSION !== "${referencePackage.version}") {
      throw new Error("Reference adapter runtime version does not match its package");
    }
    const report = await runRuntimeAdapterConformance({
      name: "packaged-jsonl-reference",
      async create(fixture, transport) {
        const root = mkdtempSync(join(tmpdir(), "ds4-pack-reference-"));
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
      throw new Error("Packaged reference adapter failed conformance");
    }
  `;
  run(process.execPath, ["--input-type=module", "--eval", referenceSmoke], { cwd: consumerDirectory });

  const qualitySmoke = run(process.execPath, [
    join(consumerDirectory, "node_modules", rootPackage.name, "scripts", "compare-context-quality.mjs"),
  ], { cwd: consumerDirectory });
  const qualityReport = JSON.parse(qualitySmoke.stdout);
  if (qualityReport.fixtureCount !== 4
    || qualityReport.strategies?.[0]?.strategyId !== "static-ranking-v0.1") {
    fail("Packaged quality corpus/comparison harness returned an invalid report");
  }

  const extensionPath = join(
    consumerDirectory,
    "node_modules",
    rootPackage.name,
    rootPackage.pi.extensions[0].replace(/^\.\//u, ""),
  );
  const rpcResult = run(
    piCommand,
    [
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
    ],
    {
      cwd: consumerDirectory,
      input: `${JSON.stringify({ type: "get_commands", id: "package-smoke" })}\n`,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: piStateDirectory,
        PI_CODING_AGENT_SESSION_DIR: join(piStateDirectory, "sessions"),
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
      },
    },
  );
  const rpcMessages = parseJsonLines(rpcResult.stdout);
  const commandResponse = rpcMessages.find(
    (message) => message.type === "response" && message.command === "get_commands" && message.id === "package-smoke",
  );
  const commands = commandResponse?.data?.commands;
  if (commandResponse?.success !== true || !Array.isArray(commands)) {
    fail("Packaged Pi extension did not answer the RPC command probe");
  }
  if (!commands.some((command) => command.name === "context" && command.source === "extension")) {
    fail("Packaged Pi extension did not register /context");
  }
  if (rpcMessages.some((message) => message.type === "extension_error")) {
    fail("Packaged Pi extension emitted extension_error during startup or shutdown");
  }

  console.log(
    `Verified ${corePack.name}@${corePack.version} (${corePack.files.length} files), ` +
      `${referencePack.name}@${referencePack.version} (${referencePack.files.length} files), and ` +
      `${adapterPack.name}@${adapterPack.version} (${adapterPack.files.length} files) in a clean consumer.`,
  );
} finally {
  if (process.env.DS4_KEEP_PACK_TMP === "1") {
    console.log(`Kept package smoke state at ${temporaryRoot}`);
  } else {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
