import { describe, expect, it } from "vitest";
import type {
  EmbeddingModelIdentity,
  EmbeddingPort,
  EmbeddingSource,
} from "ds4-context-core/retrieval/embedding";
import { SemanticEmbeddingIndex } from "ds4-context-core/retrieval/semantic-index";
import { ContextDatabase } from "ds4-context-core/persistence/sqlite";
import { LocalFeatureHashEmbedding } from "../../src/pi-adapter/local-embedding.ts";

class CountingPort implements EmbeddingPort {
  calls = 0;
  texts: string[] = [];
  fail = false;

  constructor(
    readonly identity: EmbeddingModelIdentity,
    private readonly delegate = new LocalFeatureHashEmbedding(identity.dimensions),
  ) {}

  embed(texts: readonly string[]): readonly (readonly number[])[] {
    this.calls++;
    this.texts.push(...texts);
    if (this.fail) throw new Error("offline");
    return this.delegate.embed(texts);
  }
}

function source(
  key: string,
  hash: string,
  text: string,
): EmbeddingSource {
  return {
    kind: "project-snippet",
    scopeId: "/project",
    sourceKey: key,
    sourceGroup: `${key}.ts`,
    sourceHash: hash,
    chunkingVersion: "regex-structural-v1",
    text,
  };
}

function semanticIndex(
  database: ContextDatabase,
  port: EmbeddingPort,
  gate?: ConstructorParameters<typeof SemanticEmbeddingIndex>[3],
): SemanticEmbeddingIndex {
  return new SemanticEmbeddingIndex(
    database.embeddings,
    port,
    {
      maxSources: 100,
      candidatePool: 10,
      batchSize: 16,
      queryCacheSize: 4,
      timeoutMs: 1_000,
    },
    gate,
    () => 0,
    () => 100,
  );
}

const localIdentity: EmbeddingModelIdentity = {
  provider: "ds4-local",
  model: "feature-hash-v1",
  dimensions: 256,
  destination: "local",
};

describe("SemanticEmbeddingIndex", () => {
  it("retrieves semantic synonyms and caches source and query vectors", () => {
    const database = ContextDatabase.open(":memory:");
    const port = new CountingPort(localIdentity);
    const index = semanticIndex(database, port);
    const sources = [
      source("auth", "hash-auth", "OAuth token refresh handles expired authentication credentials."),
      source("schema", "hash-schema", "SQLite migration creates a project metadata table."),
    ];

    const sync = index.syncSources("project-snippet", "/project", sources, true);
    const first = index.query(
      "project-snippet",
      "/project",
      "renew authorization secrets after expiry",
      0,
    );
    const callsAfterFirst = port.calls;
    const second = index.query(
      "project-snippet",
      "/project",
      "renew authorization secrets after expiry",
      0,
    );

    expect(sync).toMatchObject({ indexedVectors: 2, indexFresh: true, embeddingCalls: 1 });
    expect(first.hits[0]?.sourceKey).toBe("auth");
    expect(first.diagnostics.queryCacheHit).toBe(false);
    expect(second.hits).toEqual(first.hits);
    expect(second.diagnostics).toMatchObject({ queryCacheHit: true, queryEmbeddingCalls: 0 });
    expect(port.calls).toBe(callsAfterFirst);
    database.close();
  });

  it("applies source limits after stable key ordering", () => {
    const database = ContextDatabase.open(":memory:");
    const port = new CountingPort(localIdentity);
    const index = new SemanticEmbeddingIndex(
      database.embeddings,
      port,
      {
        maxSources: 1,
        candidatePool: 10,
        batchSize: 16,
        queryCacheSize: 4,
        timeoutMs: 1_000,
      },
      undefined,
      () => 0,
      () => 100,
    );

    const sync = index.syncSources("project-snippet", "/project", [
      source("z-last", "hash-z", "last source"),
      source("a-first", "hash-a", "first source"),
    ], false);

    expect(sync.sourceCount).toBe(1);
    expect(port.texts).toEqual(["first source"]);
    database.close();
  });

  it("isolates model and dimension profiles while pruning only changed sources", () => {
    const database = ContextDatabase.open(":memory:");
    const port256 = new CountingPort(localIdentity);
    const identity128 = { ...localIdentity, model: "feature-hash-v1-128", dimensions: 128 };
    const port128 = new CountingPort(identity128);
    const index256 = semanticIndex(database, port256);
    const index128 = semanticIndex(database, port128);
    const initial = [
      source("auth", "hash-auth-v1", "authentication token refresh"),
      source("db", "hash-db", "database schema migration"),
    ];

    index256.syncSources("project-snippet", "/project", initial, true);
    index128.syncSources("project-snippet", "/project", initial, true);
    expect(database.embeddings.countProfile("project-snippet", "/project", localIdentity)).toBe(2);
    expect(database.embeddings.countProfile("project-snippet", "/project", identity128)).toBe(2);

    const changed = [
      source("auth", "hash-auth-v2", "renew expired authentication token"),
      initial[1]!,
    ];
    index256.syncSources("project-snippet", "/project", changed, true);

    expect(database.embeddings.countProfile("project-snippet", "/project", localIdentity)).toBe(2);
    expect(database.embeddings.countProfile("project-snippet", "/project", identity128)).toBe(1);
    expect(database.embeddings.getVector(
      "project-snippet",
      "/project",
      "db",
      "hash-db",
      "regex-structural-v1",
      identity128,
    )).toBeDefined();
    database.close();
  });

  it("never sends privacy-rejected source or query text to a remote port", () => {
    const database = ContextDatabase.open(":memory:");
    const remoteIdentity: EmbeddingModelIdentity = {
      provider: "remote-test",
      model: "embed-v1",
      dimensions: 256,
      destination: "remote",
    };
    const port = new CountingPort(remoteIdentity);
    const index = semanticIndex(database, port, (text) =>
      text.includes("[ds4:local-only]") ? undefined : text
    );

    const sync = index.syncSources("project-snippet", "/project", [
      source("private", "hash-private", "[ds4:local-only]never-send[/ds4:local-only]"),
      source("public", "hash-public", "normal searchable source"),
    ], true);
    const callsBeforePrivateQuery = port.calls;
    const result = index.query(
      "project-snippet",
      "/project",
      "[ds4:local-only]private query[/ds4:local-only]",
      1,
    );

    expect(sync.skippedByPrivacy).toBe(1);
    expect(port.texts).toEqual(["normal searchable source"]);
    expect(port.calls).toBe(callsBeforePrivateQuery);
    expect(result.diagnostics.fallbackReason).toContain("privacy");
    database.close();
  });

  it("returns a metadata-only fallback when the provider fails", () => {
    const database = ContextDatabase.open(":memory:");
    const port = new CountingPort(localIdentity);
    const index = semanticIndex(database, port);
    index.syncSources("project-snippet", "/project", [
      source("auth", "hash-auth", "authentication token refresh"),
    ], true);
    port.fail = true;

    const result = index.query("project-snippet", "/project", "renew credentials", 2);

    expect(result.hits).toEqual([]);
    expect(result.diagnostics.fallbackReason).toContain("provider failure");
    expect(JSON.stringify(result.diagnostics)).not.toContain("renew credentials");
    database.close();
  });
});
