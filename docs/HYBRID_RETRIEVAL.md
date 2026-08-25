# Hybrid Semantic Retrieval

M16 adds opt-in vector candidate generation to historical and trusted-project retrieval. Exact identifiers and FTS5 remain active and authoritative; semantic candidates are fused into the same bounded, deterministic ranking and never replace source provenance or live-hash checks.

## Configuration

Semantic retrieval remains disabled for upgrades from 0.1:

```json
{
  "retrieval": {
    "semantic": true
  }
}
```

The supported default is the runtime-owned local feature-hash embedding:

```json
{
  "retrieval": {
    "semantic": true,
    "embedding": {
      "mode": "local",
      "provider": "ds4-local",
      "model": "feature-hash-v1",
      "dimensions": 256,
      "maxSources": 50000,
      "candidatePool": 80,
      "batchSize": 64,
      "queryCacheSize": 64,
      "timeoutMs": 2000
    }
  }
}
```

It is deterministic, has no native dependency and performs no network access. Core defines `EmbeddingPort`; the Pi adapter supplies the implementation. Other runtimes can inject a compatible local, WASM or remote port without adding model invocation to core.

Remote embedding requires all of the following:

- `mode: "remote"`;
- an exact `provider/model` entry in `remoteProfiles` (wildcards are rejected);
- `privacy.enabled: true`;
- provider-specific privacy allow rules;
- a runtime-injected `EmbeddingPort` whose provider, model, dimensions and remote destination exactly match configuration.

```json
{
  "retrieval": {
    "semantic": true,
    "embedding": {
      "mode": "remote",
      "provider": "embedding.example",
      "model": "semantic-v2",
      "dimensions": 768,
      "remoteProfiles": ["embedding.example/semantic-v2"]
    }
  },
  "privacy": {
    "enabled": true,
    "remoteProviders": {
      "embedding.example": ["normal", "internal"]
    }
  }
}
```

The packaged Pi adapter intentionally includes no default remote embedding client. Missing or mismatched ports produce lexical-only results.

## Privacy

Every remote source and query passes through `PrivacyPolicyEngine` before `EmbeddingPort.embed`. A value whose effective classification is `local-only`, or which contains a provider-blocked span, is excluded as a whole and never reaches the remote port. Allowed text is secret-redacted before invocation. Local mode does not cross a provider boundary.

Embedding diagnostics contain only counts, model identity, dimensions, destination, freshness, cache status, timings and normalized fallback reasons. They never contain query text, source text, vectors, provider response IDs or remote handles.

## Derived storage

SQLite schema v13 adds `derived_embeddings`. Each row is keyed by:

```text
source kind + scope + source key + source hash + chunking version
+ embedding provider + embedding model + dimensions
```

Rows contain the source group, numeric vector JSON and indexing time, but no copied query or evidence text. Session entries use `pi-session-entry-v1`; project chunks use their parser version or `text-window-v1`.

A source edit prunes only vectors whose key/hash/chunk version is no longer current. Unchanged source rows and unrelated model/dimension profiles remain intact. A model or dimension switch selects a separate profile instead of rewriting compatible rows. Deleting SQLite discards the whole vector projection; canonical Pi JSONL and live project files rebuild it.

## Candidate generation and rank fusion

Candidate pools are bounded. Generation order is:

1. exact project path, qualified symbol, simple symbol, quoted phrase or historical identifier;
2. escaped FTS5 candidates;
3. cosine-ranked vector candidates.

The lexical and vector ranks are combined with deterministic reciprocal-rank fusion, semantic similarity and stable source-ID tie-breaking. Exact matches retain a score tier that vectors cannot displace. Historical candidates still require active-branch membership and exclusion from the active native context. Project candidates still require project trust, sensitive-file exclusion and a live SHA-256 match before injection.

Source vectors are generated during session/project index sync. Query vectors use a bounded volatile hash-keyed cache. Repeating a request with current source vectors performs no embedding call. Query hashes and vectors are not persisted as conversation state.

## Failure behavior

Missing models, consent failure, privacy exclusion, invalid dimensions, corrupt vectors, synchronous-port timeout, provider exceptions, vector storage errors and vector search errors all return the available exact/FTS result. They cannot fail context planning. Diagnostics expose the fallback reason without source content.

## Quality gate

[`quality/semantic-corpus-v1.json`](../quality/semantic-corpus-v1.json) is a synthetic extension of the M14 replay methodology. It measures the same evidence-recall and irrelevant-token signals for semantic synonyms and exact-match preservation. The byte-stable golden report records:

```text
lexical evidence recall  0.25
hybrid evidence recall   1.00
recall delta             +0.75
irrelevant-token delta    0.00
```

Verification covers local query reuse, source-vector caching, profile isolation, changed-source pruning, remote `local-only` exclusion, provider failure, exact priority, historical/project fusion and schema v13 rebuild behavior.
