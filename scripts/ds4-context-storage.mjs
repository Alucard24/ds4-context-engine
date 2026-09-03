#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { DatabaseProtocolError } from "ds4-context-core/persistence/database-client-lease";
import {
  StorageMaintenanceError,
  compactStorage,
  inspectStorage,
  recoverStorage,
  storageMaintenancePaths,
} from "ds4-context-core/persistence/storage-maintenance";

function usage() {
  return [
    "Usage:",
    "  ds4-context-storage inspect --database <exact-path>",
    "  ds4-context-storage compact --database <exact-path>",
    "  ds4-context-storage recover --database <exact-path>",
    "",
    "compact and recover require an interactive local TTY confirmation.",
  ].join("\n");
}

function parseArguments(argv) {
  const command = argv[0];
  if (command !== "inspect" && command !== "compact" && command !== "recover") {
    throw new Error("usage");
  }
  let database;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (argument !== "--database" || database !== undefined || !argv[index + 1]) {
      throw new Error("usage");
    }
    database = argv[++index];
  }
  if (!database) throw new Error("usage");
  return { command, database };
}

function formatBytes(value) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit++;
  }
  const digits = unit === 0 ? 0 : scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${units[unit]}`;
}

function printInspection(inspection) {
  const storage = inspection.diagnostics;
  console.log([
    "DS4 Context Storage Inspection",
    "",
    `Database:                    ${inspection.databasePath}`,
    `Schema / journal:            ${inspection.schemaVersion} / ${storage.journalMode ?? "n/a"}`,
    `quick_check / foreign keys:  ${inspection.quickCheck} / ${inspection.foreignKeyViolations}`,
    `Database / WAL:              ${formatBytes(storage.databaseBytes ?? 0)} / ${formatBytes(storage.walBytes ?? 0)}`,
    `Allocated / reusable:        ${formatBytes(storage.allocatedBytes ?? 0)} / ${formatBytes(storage.reusableBytes ?? 0)}`,
    `Manifests / target:          ${storage.manifests.rows} / ${storage.manifests.retainedLimit}`,
    `Manifest payload:            ${formatBytes(storage.manifests.serializedBytes)}`,
    `Manifests to prune:          ${inspection.manifestsToPrune}`,
    `Calibration to prune:        ${inspection.calibrationToPrune}`,
    `Available / required space:  ${formatBytes(inspection.availableBytes)} / ${formatBytes(inspection.requiredBytes)}`,
    `Backup:                      ${inspection.paths.backup}`,
    `Maintenance recommended:     ${storage.maintenance.recommended ? "yes" : "no"}`,
    ...storage.maintenance.reasons.map((reason) => `Reason:                      ${reason}`),
  ].join("\n"));
}

async function confirm(action, database) {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new StorageMaintenanceError("interactive-confirmation-required", "confirmation");
  }
  console.log([
    "",
    `Exact database path: ${database}`,
    "All Pi instances must be closed before this operation.",
    "The source database will not be overwritten in place.",
  ].join("\n"));
  const expected = action.toUpperCase();
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question(`Type ${expected} to continue: `);
    if (answer !== expected) throw new StorageMaintenanceError("confirmation-declined", "confirmation");
  } finally {
    prompt.close();
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArguments(process.argv.slice(2));
  } catch {
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  if (parsed.command === "inspect") {
    printInspection(inspectStorage(parsed.database));
    return;
  }

  if (parsed.command === "compact") {
    const inspection = inspectStorage(parsed.database);
    printInspection(inspection);
    await confirm("compact", inspection.databasePath);
    const result = await compactStorage(inspection.databasePath);
    console.log([
      "",
      "DS4 Context Storage Compaction Completed",
      `Database:              ${result.databasePath}`,
      `Backup retained:       ${result.backupPath}`,
      `Before / after:        ${formatBytes(result.beforeBytes)} / ${formatBytes(result.afterBytes)}`,
      `Manifests pruned:      ${result.maintenance.prunedManifests}`,
      `Manifests rolled up:   ${result.maintenance.rolledUpManifests}`,
      `Oversize skipped:      ${result.maintenance.skippedOversizeManifests}`,
      `Calibration pruned:    ${result.maintenance.prunedCalibrationSamples}`,
      "Run /context health and /context storage after reopening Pi.",
    ].join("\n"));
    return;
  }

  const paths = storageMaintenancePaths(parsed.database);
  await confirm("recover", paths.source);
  const result = recoverStorage(paths.source);
  console.log([
    "DS4 Context Storage Recovery Completed",
    `Database: ${result.databasePath}`,
    `Action:   ${result.action}`,
  ].join("\n"));
}

try {
  await main();
} catch (error) {
  if (error instanceof StorageMaintenanceError || error instanceof DatabaseProtocolError) {
    console.error(error.message);
  } else {
    console.error("Storage maintenance failed (category=unexpected-local-failure)");
  }
  process.exitCode = 1;
}
