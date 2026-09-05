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

function isForbiddenLocalStoragePath(path) {
  const basename = path.split("/").at(-1) ?? path;
  return path === ".serena" || path.startsWith(".serena/")
    || path === ".pi" || path.startsWith(".pi/")
    || basename.endsWith(".db")
    || basename.endsWith(".db-wal")
    || basename.endsWith(".db-shm")
    || basename.endsWith(".bak")
    || /\.(?:compact-ready|maintenance-work|swap-old)(?:-(?:wal|shm))?$/u.test(basename)
    || basename.endsWith(".maintenance.lock")
    || basename.endsWith(".maintenance-state.json")
    || basename.endsWith(".jsonl")
    || basename.endsWith(".clients")
    || path.includes(".clients/");
}

function verifyInventory(metadata, requiredPaths, forbiddenPrefixes) {
  const paths = new Set(metadata.files.map((file) => file.path));
  for (const requiredPath of requiredPaths) {
    if (!paths.has(requiredPath)) {
      fail(`${metadata.name} tarball is missing ${requiredPath}`);
    }
  }

  for (const path of paths) {
    if (forbiddenPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
      || isForbiddenLocalStoragePath(path)) {
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
  if (rootPackage.bin?.["ds4-context-storage"] !== "./scripts/ds4-context-storage.mjs") {
    fail("Root package must publish the ds4-context-storage CLI");
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
      "dist/artifacts/adaptive-budget.js",
      "dist/artifacts/adaptive-budget.d.ts",
      "dist/compaction/input-budget.js",
      "dist/compaction/input-budget.d.ts",
      "dist/project/symbol-parser.js",
      "dist/project/symbol-parser.d.ts",
      "dist/retrieval/embedding.js",
      "dist/retrieval/embedding.d.ts",
      "dist/retrieval/semantic-index.js",
      "dist/retrieval/semantic-quality.js",
      "dist/persistence/repositories/embedding-repository.js",
      "dist/manifest/context-manifest-storage.js",
      "dist/persistence/database-client-lease.js",
      "dist/persistence/storage-diagnostics.js",
      "dist/persistence/storage-maintenance.js",
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
      "src/extension/anchored-edit.ts",
      "src/extension/anchored-edit-tool.ts",
      "src/extension/post-edit-report.ts",
      "src/extension/adaptive-read-tool.ts",
      "src/extension/bash-job-tool.ts",
      "src/tools/bash-job-manager.ts",
      "src/pi-adapter/compaction-workers.ts",
      "docs/ADR/061-compaction-latency.md",
      "docs/PORTABLE_AGENT_TOOLS.md",
      "docs/ADR/060-optional-portable-agent-tools.md",
      "docs/ANCHORED_EDITING.md",
      "docs/ADR/059-optional-anchored-editing.md",
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
      "scripts/ds4-context-storage.mjs",
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
  if (installedAdapterPackage.bin?.["ds4-context-storage"] !== "./scripts/ds4-context-storage.mjs") {
    fail("Clean consumer did not install ds4-context-storage metadata");
  }
  const installedStorageCli = join(
    consumerDirectory,
    "node_modules",
    rootPackage.name,
    "scripts",
    "ds4-context-storage.mjs",
  );
  const cliUsage = spawnSync(process.execPath, [installedStorageCli], {
    cwd: consumerDirectory,
    encoding: "utf8",
    env: isolatedNpmEnvironment(),
  });
  if (cliUsage.status !== 2 || !`${cliUsage.stdout}${cliUsage.stderr}`.includes("ds4-context-storage inspect")) {
    fail("Packaged ds4-context-storage CLI usage probe failed");
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
    import { adaptiveArtifactConfig } from "ds4-context-core/artifacts/adaptive-budget";
    import { compactionInputBudget } from "ds4-context-core/compaction/input-budget";
    import { planManagedContext } from "ds4-context-core/planner/context-planner";
    import { storageMaintenancePaths } from "ds4-context-core/persistence/storage-maintenance";
    if (CONFIG_SCHEMA_VERSION !== "ds4-context-config-v1") {
      throw new Error("Portable config schema export is incompatible");
    }
    const profile = createModelProfile({
      provider: "package-smoke",
      id: "model",
      contextWindow: 128000,
      maxTokens: 16000,
    });
    const defaults = createDefaultConfig();
    if ([defaults.editing.anchored, defaults.editing.postEditReport, defaults.reading.adaptive,
      defaults.artifacts.adaptiveBudget, defaults.jobs.enabled].some((value) => value !== false)) {
      throw new Error("Packaged portable tool improvements must be disabled by default");
    }
    if (adaptiveArtifactConfig(defaults.artifacts, [], { inputTokens: 0, fixedTokens: 0 }) !== defaults.artifacts) {
      throw new Error("Disabled adaptive artifact budget must preserve static configuration");
    }
    const budget = calculateContextBudget(profile, createDefaultConfig().context);
    if (defaults.compaction.directUpdate !== true || defaults.compaction.inputBudget !== "summary"
      || defaults.compaction.maxConcurrentSegments !== 2
      || compactionInputBudget(budget, 12000) !== budget.hardInputLimit
      || compactionInputBudget(budget, 12000, "context") !== budget.activeInputBudget) {
      throw new Error("Packaged compaction optimization defaults or input budget are unavailable");
    }
    if (!Number.isSafeInteger(budget.hardInputLimit) || budget.hardInputLimit <= 0) {
      throw new Error("Portable core returned an invalid context budget");
    }
    if (typeof planManagedContext !== "function"
      || !storageMaintenancePaths("/tmp/context.db").candidate.endsWith(".compact-ready")) {
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
  // Observe the real Pi registry after DS4's session_start handler. No provider
  // calls or user state: both extensions and configuration live in this fixture.
  const probePath = join(temporaryRoot, "anchored-registration-probe.ts");
  const probeOutput = join(temporaryRoot, "anchored-registration.json");
  writeFileSync(probePath, `
    import { writeFileSync } from "node:fs";
    export default function (pi) {
      pi.on("session_start", () => {
        const edit = pi.getAllTools().find((tool) => tool.name === "edit");
        writeFileSync(${JSON.stringify(probeOutput)}, JSON.stringify({
          source: edit?.sourceInfo.source,
          path: edit?.sourceInfo.path,
          anchored: edit?.description.includes("[upto]") ?? false,
          active: pi.getActiveTools().includes("edit"),
          adaptiveRead: pi.getAllTools().find((tool) => tool.name === "read")?.description.includes("DS4") ?? false,
          jobs: pi.getActiveTools().includes("bash_job"),
        }));
      });
    }
  `);
  const deactivatePath = join(temporaryRoot, "deactivate-edit.ts");
  writeFileSync(deactivatePath, `
    export default function (pi) {
      pi.on("session_start", () => pi.setActiveTools(["read"]));
    }
  `);
  for (const scenario of [
    { name: "default", config: {}, anchored: false, active: true },
    { name: "enabled", config: { editing: { anchored: true } }, anchored: true, active: true },
    { name: "master-disabled", config: { enabled: false, editing: { anchored: true } }, anchored: false, active: true },
    { name: "inactive", config: { editing: { anchored: true } }, anchored: true, active: false },
    { name: "unavailable", config: { editing: { anchored: true } }, anchored: false, active: false, unavailable: true },
    { name: "portable", config: { editing: { postEditReport: true }, reading: { adaptive: true }, jobs: { enabled: true }, artifacts: { adaptiveBudget: true } }, anchored: false, report: true, adaptiveRead: true, jobs: true, active: true },
    { name: "portable-disabled", config: { enabled: false, editing: { postEditReport: true }, reading: { adaptive: true }, jobs: { enabled: true }, artifacts: { adaptiveBudget: true } }, anchored: false, active: true },
    { name: "all-edit", config: { editing: { anchored: true, postEditReport: true } }, anchored: true, report: true, active: true },
  ]) {
    mkdirSync(piStateDirectory, { recursive: true });
    writeFileSync(join(piStateDirectory, "ds4-context.json"), JSON.stringify({
      ...scenario.config, project: { enabled: false },
    }));
    rmSync(probeOutput, { force: true });
    const rpcResult = run(
      piCommand,
      [
        "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills",
        "--no-prompt-templates", "--no-themes", "--no-context-files", "--approve",
        ...(scenario.name === "inactive" ? ["--extension", deactivatePath] : []),
        "--extension", extensionPath, "--extension", probePath,
        ...(scenario.unavailable ? ["--tools", "read"] : []),
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
      fail(`Packaged Pi extension did not answer the RPC command probe (${scenario.name})`);
    }
    if (!commands.some((command) => command.name === "context" && command.source === "extension")) {
      fail(`Packaged Pi extension did not register /context (${scenario.name})`);
    }
    if (rpcMessages.some((message) => message.type === "extension_error") || !existsSync(probeOutput)) {
      fail(`Packaged Pi extension failed registry probe (${scenario.name}): ${rpcResult.stderr}`);
    }
    const probe = readJson(probeOutput);
    // Explicit --extension paths are reported as source "cli", not "extension".
    if (probe.active !== scenario.active || probe.anchored !== scenario.anchored
      || probe.adaptiveRead !== (scenario.adaptiveRead ?? false) || probe.jobs !== (scenario.jobs ?? false)
      || probe.source !== (scenario.unavailable ? undefined : scenario.anchored || scenario.report ? "cli" : "builtin")
      || ((scenario.anchored || scenario.report) && resolve(probe.path ?? "") !== resolve(extensionPath))) {
      fail(`Unexpected packaged edit registration (${scenario.name}): ${JSON.stringify(probe)}`);
    }
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
