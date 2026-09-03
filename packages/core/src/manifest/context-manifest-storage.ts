import { createHash } from "node:crypto";
import type {
  ContextManifest,
  ContextManifestItem,
  ContextManifestItemKind,
} from "./context-manifest.ts";
import type { PrivacyClassification } from "../privacy/privacy-policy.ts";
import { stableStringify } from "../shared/stable-json.ts";

export const PREFERRED_PERSISTED_MANIFEST_BYTES = 256 * 1024;
export const HARD_PERSISTED_MANIFEST_BYTES = 1024 * 1024;
export const MAX_RETAINED_EXCLUDED_DETAILS = 256;

export type PersistedManifestCompleteness = "complete" | "excluded-rollup";

export interface PersistedManifestInventoryAggregate {
  items: number;
  tokens: number;
}

export interface PersistedManifestInventory {
  schema: "ds4-context-manifest-inventory-v1";
  completeness: PersistedManifestCompleteness;
  sourceBytes: number;
  included: {
    total: number;
    retained: number;
    complete: true;
  };
  excluded: {
    total: number;
    retained: number;
    omitted: number;
    tokens: number;
    digest: string;
    byKind: Partial<Record<ContextManifestItemKind, PersistedManifestInventoryAggregate>>;
    byClassification: Partial<Record<PrivacyClassification | "unspecified", number>>;
    reasonDigest: string;
  };
}

export interface StoredContextManifest {
  manifest: ContextManifest;
  inventory: PersistedManifestInventory;
}

export type ManifestSaveResult =
  | {
      status: "stored";
      completeness: PersistedManifestCompleteness;
      sourceBytes: number;
      storedBytes: number;
      prunedManifests: number;
      prunedBytes: number;
    }
  | {
      status: "skipped-oversize";
      sourceBytes: number;
      projectedBytes: number;
    };

export type PersistedManifestProjection =
  | {
      status: "stored";
      manifest: ContextManifest;
      serialized: string;
      inventory: PersistedManifestInventory;
      sourceBytes: number;
      storedBytes: number;
    }
  | {
      status: "skipped-oversize";
      sourceBytes: number;
      projectedBytes: number;
    };

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function sumTokens(items: readonly ContextManifestItem[]): number {
  return items.reduce((total, item) => total + item.tokens, 0);
}

function manifestItems(value: unknown): ContextManifestItem[] {
  return Array.isArray(value) ? value as ContextManifestItem[] : [];
}

function stableSequenceDigest<T>(
  values: readonly T[],
  serialize: (value: T) => string,
): string {
  const hash = createHash("sha256");
  hash.update(`items:${values.length};`, "utf8");
  for (const value of values) {
    const serialized = serialize(value);
    hash.update(`${Buffer.byteLength(serialized, "utf8")}:`, "utf8");
    hash.update(serialized, "utf8");
    hash.update(";", "utf8");
  }
  return hash.digest("hex");
}

function inventoryFor(
  manifest: ContextManifest,
  completeness: PersistedManifestCompleteness,
  sourceBytes: number,
  retainedExcluded: number,
): PersistedManifestInventory {
  const included = manifestItems(manifest.included);
  const excluded = manifestItems(manifest.excluded);
  const byKind: PersistedManifestInventory["excluded"]["byKind"] = {};
  const byClassification: PersistedManifestInventory["excluded"]["byClassification"] = {};

  for (const item of excluded) {
    const aggregate = byKind[item.kind] ?? { items: 0, tokens: 0 };
    byKind[item.kind] = {
      items: aggregate.items + 1,
      tokens: aggregate.tokens + item.tokens,
    };
    const classification = item.classification ?? "unspecified";
    byClassification[classification] = (byClassification[classification] ?? 0) + 1;
  }

  return {
    schema: "ds4-context-manifest-inventory-v1",
    completeness,
    sourceBytes,
    included: {
      total: included.length,
      retained: included.length,
      complete: true,
    },
    excluded: {
      total: excluded.length,
      retained: retainedExcluded,
      omitted: Math.max(0, excluded.length - retainedExcluded),
      tokens: sumTokens(excluded),
      digest: stableSequenceDigest(excluded, stableStringify),
      byKind,
      byClassification,
      reasonDigest: stableSequenceDigest(excluded, (item) => stableStringify(item.reason)),
    },
  };
}

function excludedSample(items: readonly ContextManifestItem[]): ContextManifestItem[] {
  if (items.length <= MAX_RETAINED_EXCLUDED_DETAILS) return [...items];
  const half = MAX_RETAINED_EXCLUDED_DETAILS / 2;
  return [...items.slice(0, half), ...items.slice(-half)];
}

function withoutPersistedInventory(manifest: ContextManifest): ContextManifest {
  if (!("persistedInventory" in manifest)) return manifest;
  const { persistedInventory: _persistedInventory, ...runtimeManifest } = manifest;
  return runtimeManifest;
}

export function completePersistedManifestInventory(
  manifest: ContextManifest,
  sourceBytes = utf8ByteLength(JSON.stringify(manifest)),
): PersistedManifestInventory {
  return inventoryFor(manifest, "complete", sourceBytes, manifestItems(manifest.excluded).length);
}

export function buildPersistedManifestProjection(manifest: ContextManifest): PersistedManifestProjection {
  if (manifest.persistedInventory?.schema === "ds4-context-manifest-inventory-v1"
    && manifest.persistedInventory.completeness === "excluded-rollup") {
    const serialized = JSON.stringify(manifest);
    const storedBytes = utf8ByteLength(serialized);
    if (storedBytes > HARD_PERSISTED_MANIFEST_BYTES) {
      return {
        status: "skipped-oversize",
        sourceBytes: manifest.persistedInventory.sourceBytes,
        projectedBytes: storedBytes,
      };
    }
    return {
      status: "stored",
      manifest,
      serialized,
      inventory: manifest.persistedInventory,
      sourceBytes: manifest.persistedInventory.sourceBytes,
      storedBytes,
    };
  }

  const runtimeManifest = withoutPersistedInventory(manifest);
  const completeSerialized = JSON.stringify(runtimeManifest);
  const sourceBytes = utf8ByteLength(completeSerialized);

  if (sourceBytes <= PREFERRED_PERSISTED_MANIFEST_BYTES) {
    return {
      status: "stored",
      manifest: runtimeManifest,
      serialized: completeSerialized,
      inventory: completePersistedManifestInventory(runtimeManifest, sourceBytes),
      sourceBytes,
      storedBytes: sourceBytes,
    };
  }

  const sampledExcluded = excludedSample(manifestItems(runtimeManifest.excluded));
  const inventory = inventoryFor(
    runtimeManifest,
    "excluded-rollup",
    sourceBytes,
    sampledExcluded.length,
  );
  const projectedManifest: ContextManifest = {
    ...runtimeManifest,
    excluded: sampledExcluded,
    persistedInventory: inventory,
  };
  const projectedSerialized = JSON.stringify(projectedManifest);
  const projectedBytes = utf8ByteLength(projectedSerialized);

  if (projectedBytes > HARD_PERSISTED_MANIFEST_BYTES) {
    return { status: "skipped-oversize", sourceBytes, projectedBytes };
  }

  return {
    status: "stored",
    manifest: projectedManifest,
    serialized: projectedSerialized,
    inventory,
    sourceBytes,
    storedBytes: projectedBytes,
  };
}

export function storedManifestInventory(
  manifest: ContextManifest,
  serializedBytes: number,
): PersistedManifestInventory {
  const inventory = manifest.persistedInventory;
  if (inventory?.schema === "ds4-context-manifest-inventory-v1") return inventory;
  return completePersistedManifestInventory(manifest, serializedBytes);
}
