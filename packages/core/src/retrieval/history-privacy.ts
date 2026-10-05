import { classifyMarkedContent, highestClassification, isPrivacyClassification, type PrivacyClassification } from "../privacy/privacy-policy.ts";

export const HISTORY_RESULT_SCHEMA = "ds4-history-result-v1";
/** Carries explicit classifications through quoted/serialized history data and checkpoint construction. */
export function historyPrivacyClassification(value: unknown): PrivacyClassification | undefined {
  let count = 0;
  const seen = new WeakSet<object>();
  const walk = (node: unknown, depth: number): PrivacyClassification | undefined => {
    if (++count > 10_000 || depth > 64) return "local-only"; // Oversized/malformed traversal fails closed.
    if (typeof node === "string") {
      const marked = classifyMarkedContent(node);
      const protocol = /"schema"\s*:\s*"ds4-history-result-v1"/u.test(node);
      const start = node.trimStart()[0];
      const serializedContainer = node.includes(HISTORY_RESULT_SCHEMA) && (start === "{" || start === "[" || start === '"');
      if (!protocol && !serializedContainer) return marked;
      try {
        const parsed = walk(JSON.parse(node), depth + 1);
        return marked && parsed ? highestClassification(marked, parsed) : marked ?? parsed;
      } catch { return "local-only"; }
    }
    if (!node || typeof node !== "object" || seen.has(node)) return undefined;
    seen.add(node);
    const record = node as Record<string, unknown>;
    let classification: PrivacyClassification | undefined = record.schema === HISTORY_RESULT_SCHEMA && record.quotedData !== true ? "local-only" as const : undefined;
    if (isPrivacyClassification(record.classification)) classification = classification
      ? highestClassification(classification, record.classification) : record.classification;
    for (const child of Object.values(node)) {
      const floor = walk(child, depth + 1);
      if (floor) classification = classification ? highestClassification(classification, floor) : floor;
    }
    return classification;
  };
  return walk(value, 0);
}
