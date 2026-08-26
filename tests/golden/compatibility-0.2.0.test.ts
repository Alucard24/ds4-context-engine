import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOCAL_KV_DIAGNOSTICS_VERSION,
  LOCAL_KV_ELIGIBILITY_VERSION,
  LOCAL_KV_RUNTIME_PORT_VERSION,
} from "ds4-context-core/adapter/local-kv";
import { RUNTIME_ADAPTER_CONFORMANCE_VERSION } from "ds4-context-core/adapter/conformance";
import {
  RUNTIME_ADAPTER_CONTRACT_VERSION,
  RUNTIME_CAPABILITY_IDS,
  RUNTIME_HISTORY_SCHEMA_VERSION,
} from "ds4-context-core/adapter/runtime-adapter";
import {
  CONFIG_SCHEMA_VERSION,
  createDefaultConfig,
} from "ds4-context-core/config/config";
import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
} from "ds4-context-core/persistence/migrations";
import { describe, expect, it } from "vitest";

function migrationChecksum(migration: (typeof MIGRATIONS)[number]): string {
  return createHash("sha256")
    .update(`${migration.version}\n${migration.name}\n${migration.sql}`)
    .digest("hex");
}

describe("0.2 compatibility freeze", () => {
  it("pins configuration defaults, database migrations, and adapter contracts", () => {
    const actual = {
      releaseLine: "0.2.0",
      config: {
        schemaVersion: CONFIG_SCHEMA_VERSION,
        defaults: createDefaultConfig(),
      },
      database: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        migrations: MIGRATIONS.map((migration) => ({
          version: migration.version,
          name: migration.name,
          checksum: migrationChecksum(migration),
        })),
      },
      runtimeAdapter: {
        contractVersion: RUNTIME_ADAPTER_CONTRACT_VERSION,
        historySchemaVersion: RUNTIME_HISTORY_SCHEMA_VERSION,
        conformanceVersion: RUNTIME_ADAPTER_CONFORMANCE_VERSION,
        capabilityIds: [...RUNTIME_CAPABILITY_IDS],
        localKv: {
          eligibilityVersion: LOCAL_KV_ELIGIBILITY_VERSION,
          portVersion: LOCAL_KV_RUNTIME_PORT_VERSION,
          diagnosticsVersion: LOCAL_KV_DIAGNOSTICS_VERSION,
        },
      },
    };
    const expected = JSON.parse(readFileSync(
      join(import.meta.dirname, "compatibility-0.2.0.json"),
      "utf8",
    )) as unknown;

    expect(actual).toEqual(expected);
  });
});
