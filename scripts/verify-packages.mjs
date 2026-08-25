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

  if (rootPackage.version !== corePackage.version) {
    fail(`Package versions differ: adapter=${rootPackage.version}, core=${corePackage.version}`);
  }
  if (rootPackage.dependencies?.[corePackage.name] !== corePackage.version) {
    fail(`${rootPackage.name} must depend exactly on ${corePackage.name}@${corePackage.version}`);
  }
  if (!existsSync(piCommand)) {
    fail(`Pi executable is missing at ${piCommand}; run npm ci first`);
  }

  const corePack = pack(["--workspace", corePackage.name]);
  const adapterPack = pack([]);

  verifyInventory(
    corePack,
    ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/index.d.ts"],
    ["src", "tests", ".pi", "node_modules"],
  );
  verifyInventory(
    adapterPack,
    ["package.json", "README.md", "LICENSE", "src/extension/index.ts", "docs/PORTABLE_CORE.md"],
    ["packages", "tests", "scripts", ".pi", "node_modules"],
  );

  const coreTarball = join(packDirectory, corePack.filename);
  const adapterTarball = join(packDirectory, adapterPack.filename);
  const consumerPackage = {
    name: "ds4-package-smoke-consumer",
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies: {
      ...rootPackage.peerDependencies,
      [corePackage.name]: `file:${coreTarball}`,
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
  const installedAdapterPackage = readJson(join(consumerDirectory, "node_modules", rootPackage.name, "package.json"));
  if (installedCorePackage.version !== corePackage.version || installedAdapterPackage.version !== rootPackage.version) {
    fail("Clean consumer installed unexpected package versions");
  }

  const coreSmoke = `
    import { calculateContextBudget, createDefaultConfig, createModelProfile } from "ds4-context-core";
    import { planManagedContext } from "ds4-context-core/planner/context-planner";
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
  `;
  run(process.execPath, ["--input-type=module", "--eval", coreSmoke], { cwd: consumerDirectory });

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
    `Verified ${corePack.name}@${corePack.version} (${corePack.files.length} files) and ` +
      `${adapterPack.name}@${adapterPack.version} (${adapterPack.files.length} files) in a clean Pi RPC consumer.`,
  );
} finally {
  if (process.env.DS4_KEEP_PACK_TMP === "1") {
    console.log(`Kept package smoke state at ${temporaryRoot}`);
  } else {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
