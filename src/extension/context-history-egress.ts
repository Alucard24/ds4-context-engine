import { historyPrivacyClassification } from "ds4-context-core/retrieval/history-privacy";
import { isPrivacyClassification, type PrivacyClassification } from "ds4-context-core/privacy/privacy-policy";
import { HISTORY_OMISSION, HISTORY_RESULT_SCHEMA, HISTORY_TOOL_NAMES, historyUnavailable, renderHistoryResult } from "./context-history-contract.ts";

type Sanitizer = (text: string, classification?: PrivacyClassification) => { text?: string; omitted: boolean };
const names = new Set<string>(HISTORY_TOOL_NAMES);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function name(value: Record<string, unknown>): string | undefined {
  const nested = record(value.function) ? value.function.name : undefined;
  return [value.name, value.toolName, nested].find((candidate) => typeof candidate === "string" && names.has(candidate)) as string | undefined;
}
function ids(value: Record<string, unknown>): string[] {
  return [value.id, value.toolCallId, value.tool_call_id, value.call_id, value.tool_use_id].filter((id): id is string => typeof id === "string");
}
function sanitizeText(value: unknown, sanitize: Sanitizer): string {
  if (typeof value !== "string" || value.length > 32_000) return renderHistoryResult(historyUnavailable("invalid-historical-result"));
  try {
    const result: unknown = JSON.parse(value);
    if (!record(result) || result.schema !== HISTORY_RESULT_SCHEMA || result.quotedData !== true) throw new Error();
    // Keep only the documented scalar metadata, and classify every content-bearing field afresh.
    const scalarKeys = new Set(["schema", "quotedData", "status", "effectiveScope", "coverage", "sourceRef", "projectId", "sessionId", "entryId", "kind", "role", "timestamp", "relation", "classification", "score", "truncated", "startLine", "nextLine", "indexedEntries"]);
    const clean = (node: Record<string, unknown>, inherited?: PrivacyClassification): Record<string, unknown> => {
      const classification = isPrivacyClassification(node.classification) ? node.classification : inherited;
      if (("text" in node || "excerpt" in node) && !classification) throw new Error();
      const out: Record<string, unknown> = Object.create(null);
      for (const [key, child] of Object.entries(node)) {
        if (key === "text" || key === "excerpt") {
          const safe = typeof child === "string" ? sanitize(child, classification) : { omitted: true };
          out[key] = safe.omitted || safe.text === undefined ? HISTORY_OMISSION : safe.text;
        } else if (key === "source" && record(child)) out[key] = clean(child);
        else if (key === "hits" && Array.isArray(child)) out[key] = child.slice(0, 12).map((hit) => record(hit) ? clean(hit) : {});
        else if ((key === "warnings" || key === "matchReasons") && Array.isArray(child)) {
          out[key] = child.slice(0, 12).filter((s) => typeof s === "string" && /^[a-z-]{1,48}$/u.test(s));
        } else if (scalarKeys.has(key) && (typeof child === "boolean" || (typeof child === "number" && Number.isFinite(child)))) out[key] = child;
        else if (scalarKeys.has(key) && typeof child === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(child)) {
          const safe = sanitize(child, "normal");
          out[key] = !safe.omitted && safe.text === child ? child : HISTORY_OMISSION;
        }
      }
      return out;
    };
    const floor = record(result.source) && isPrivacyClassification(result.source.classification) ? result.source.classification : undefined;
    return JSON.stringify(clean(result, floor));
  } catch { return renderHistoryResult(historyUnavailable("invalid-historical-result")); }
}
/** Runs even with managed context/privacy disabled, and again at provider transport after provider changes. */
export function sanitizeHistoryEgress<T>(value: T, sanitize: Sanitizer): { value: T; changed: boolean } {
  const calls = new Set<string>();
  const visited = new WeakSet<object>();
  const collect = (node: unknown): void => {
    if (!node || typeof node !== "object" || visited.has(node)) return;
    visited.add(node);
    if (record(node) && name(node)) for (const id of ids(node)) calls.add(id);
    for (const child of Object.values(node)) collect(child);
  };
  collect(value);
  let changed = false;
  const seen = new WeakMap<object, unknown>();
  const walk = (node: unknown): unknown => {
    if (typeof node === "string" && node.includes("[DS4 REBASE HANDOFF")) {
      const safe = sanitize(node, historyPrivacyClassification(node)); changed = true;
      return safe.omitted || safe.text === undefined ? HISTORY_OMISSION : safe.text;
    }
    if (!node || typeof node !== "object") return node;
    if (seen.has(node)) return seen.get(node);
    if (Array.isArray(node)) {
      const out: unknown[] = []; seen.set(node, out);
      for (const child of node) out.push(walk(child));
      return out;
    }
    const item = node as Record<string, unknown>;
    const direct = Boolean(name(item));
    const result = ids(item).some((id) => calls.has(id)) && (item.role === "toolResult" || item.role === "tool" || item.type === "tool_result" || item.type === "function_call_output" || "response" in item)
      || (direct && (item.role === "toolResult" || "response" in item));
    const out: Record<string, unknown> = Object.create(null); seen.set(node, out);
    for (const [key, child] of Object.entries(item)) {
      if (direct && ["arguments", "args", "input"].includes(key)) {
        // Historical queries can themselves contain secrets; arguments are not needed after execution.
        out[key] = typeof child === "string" ? JSON.stringify({ omitted: HISTORY_OMISSION }) : { omitted: HISTORY_OMISSION };
        changed = true;
      } else if (result && key === "details") { out[key] = {}; changed = true; }
      else if (result && ["content", "output", "response"].includes(key)) {
        const text = typeof child === "string" ? child : Array.isArray(child)
          ? child.flatMap((block) => record(block) && typeof block.text === "string" ? [block.text] : []).join("\n")
          : record(child) ? child.output : undefined;
        const safe = sanitizeText(text, sanitize);
        out[key] = typeof child === "string" ? safe : Array.isArray(child) ? [{ type: "text", text: safe }] : { output: safe };
        changed = true;
      } else out[key] = walk(child);
    }
    return out;
  };
  const output = walk(value);
  return { value: changed ? output as T : value, changed };
}
