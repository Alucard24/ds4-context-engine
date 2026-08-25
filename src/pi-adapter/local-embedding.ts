import type {
  EmbeddingModelIdentity,
  EmbeddingPort,
} from "ds4-context-core/retrieval/embedding";
import { sha256 } from "ds4-context-core/shared/hash";

const CONCEPTS: Readonly<Record<string, string>> = {
  auth: "auth",
  authentication: "auth",
  authorize: "auth",
  authorization: "auth",
  credential: "credential",
  credentials: "credential",
  password: "credential",
  secret: "credential",
  token: "credential",
  cache: "cache",
  cached: "cache",
  caching: "cache",
  reuse: "cache",
  memoize: "cache",
  database: "database",
  datastore: "database",
  persistence: "database",
  sqlite: "database",
  storage: "database",
  crash: "failure",
  error: "failure",
  errors: "failure",
  fail: "failure",
  failed: "failure",
  failure: "failure",
  exception: "failure",
  delete: "remove",
  deleted: "remove",
  deletion: "remove",
  purge: "remove",
  remove: "remove",
  refresh: "renew",
  renew: "renew",
  renewal: "renew",
  rotate: "renew",
  expiry: "expire",
  expired: "expire",
  expiration: "expire",
  timeout: "timeout",
  timedout: "timeout",
  latency: "performance",
  performance: "performance",
  slow: "performance",
  optimize: "performance",
  optimization: "performance",
  validate: "validate",
  validation: "validate",
  verify: "validate",
  verification: "validate",
  check: "validate",
  config: "configuration",
  configuration: "configuration",
  setting: "configuration",
  settings: "configuration",
  index: "index",
  indexing: "index",
  search: "retrieval",
  retrieve: "retrieval",
  retrieval: "retrieval",
  lookup: "retrieval",
};

function stem(token: string): string {
  if (token.length > 6 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 5 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 5 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function canonical(token: string): string {
  const lower = token.toLocaleLowerCase("en-US");
  return CONCEPTS[lower] ?? CONCEPTS[stem(lower)] ?? stem(lower);
}

function tokens(text: string): string[] {
  const separated = text
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[_./\\:-]+/gu, " ")
    .toLocaleLowerCase("en-US");
  return [...separated.matchAll(/[\p{L}\p{N}]{2,}/gu)]
    .map((match) => canonical(match[0]))
    .filter((token) => token.length >= 2)
    .slice(0, 20_000);
}

function addFeature(vector: number[], feature: string, weight: number): void {
  const hash = sha256(feature);
  const bucket = Number.parseInt(hash.slice(0, 8), 16) % vector.length;
  const sign = Number.parseInt(hash.slice(8, 10), 16) % 2 === 0 ? 1 : -1;
  vector[bucket] = (vector[bucket] ?? 0) + weight * sign;
}

function embedText(text: string, dimensions: number): readonly number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  const values = tokens(text);
  const frequencies = new Map<string, number>();
  for (const value of values) frequencies.set(value, (frequencies.get(value) ?? 0) + 1);
  for (const [value, frequency] of frequencies) {
    addFeature(vector, `token:${value}`, 1 + Math.log(frequency));
  }
  for (let index = 0; index + 1 < values.length; index++) {
    addFeature(vector, `pair:${values[index]}:${values[index + 1]}`, 0.35);
  }
  if (values.length === 0) addFeature(vector, "empty", 1);
  const magnitude = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  return magnitude > 0 ? vector.map((value) => value / magnitude) : vector;
}

export class LocalFeatureHashEmbedding implements EmbeddingPort {
  readonly identity: EmbeddingModelIdentity;

  constructor(dimensions = 256) {
    this.identity = {
      provider: "ds4-local",
      model: "feature-hash-v1",
      dimensions,
      destination: "local",
    };
  }

  embed(texts: readonly string[]): readonly (readonly number[])[] {
    return texts.map((text) => embedText(text, this.identity.dimensions));
  }
}
