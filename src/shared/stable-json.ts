function normalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "function") return "[function]";
  if (typeof value === "symbol") return String(value);

  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((item) => normalize(item, seen));
      if (value instanceof Uint8Array) return `[bytes:${value.byteLength}]`;
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        result[key] = normalize((value as Record<string, unknown>)[key], seen);
      }
      return result;
    } finally {
      seen.delete(value);
    }
  }

  return String(value);
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value, new WeakSet<object>()));
}
