import {
  CONTEXT_PERSISTENCE_ACTIONS,
  CONTEXT_PERSISTENCE_EGRESS_SENTINEL,
  CONTEXT_PERSISTENCE_TOOL_NAME,
} from "./context-persistence-contract.ts";
import {
  renderHistoricalContextPersistenceResult,
  sanitizeHistoricalContextPersistenceDetails,
} from "./context-persistence-result.ts";

export { CONTEXT_PERSISTENCE_EGRESS_SENTINEL } from "./context-persistence-contract.ts";

const ACTIONS = new Set<string>(CONTEXT_PERSISTENCE_ACTIONS);
const SAFE_ARGUMENT_KEYS = new Set([
  "action",
  "scope",
  "id",
  "targetRevision",
  "classification",
  "activeOnly",
  "maxResults",
]);
const SENSITIVE_ARGUMENT_KEYS = new Set(["content", "query", "key", "reason"]);
const OPAQUE_ID = /^(?:source_[A-Za-z0-9_-]{22,57}|[A-Za-z0-9._:-]{1,128})$/u;
const REVISION = /^rev_[A-Za-z0-9_-]{1,60}$/u;
const SAFE_ENUM = /^(?:session|branch|project|normal|internal|sensitive|local-only)$/u;
const SAFE_METADATA_LINE = /^(?:pin|memory|project-memory-source) (?:source_[A-Za-z0-9_-]{22,57}|[A-Za-z0-9._:-]{1,128})(?:; (?:scope|status|classification|applicable|createdAt|updatedAt|revision|match|score|indexedMutations|activeProjectMemories|activeProjectPins|hasMalformedLines|error)=[A-Za-z0-9_-]+)+$/u;
const SAFE_SUMMARY_LINE = /^(?:pins_list|pins_find|memory_list|memory_find|memory_sources): \d{1,3} (?:item\(s\)|match\(es\)); truncated=(?:true|false); incomplete=(?:true|false)\.$/u;
const PREVIEW_LINE = /^(pin|memory) ([\x21-\x7e]{1,128}): /u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeArgumentValue(key: string, value: unknown): unknown {
  if (key === "action") return typeof value === "string" && ACTIONS.has(value)
    ? value
    : CONTEXT_PERSISTENCE_EGRESS_SENTINEL;
  if (key === "activeOnly") return typeof value === "boolean"
    ? value
    : CONTEXT_PERSISTENCE_EGRESS_SENTINEL;
  if (key === "maxResults") return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 100
    ? value
    : CONTEXT_PERSISTENCE_EGRESS_SENTINEL;
  if (key === "scope" || key === "classification") {
    return typeof value === "string" && SAFE_ENUM.test(value)
      ? value
      : CONTEXT_PERSISTENCE_EGRESS_SENTINEL;
  }
  if (key === "id") {
    return typeof value === "string" && OPAQUE_ID.test(value)
      ? value
      : CONTEXT_PERSISTENCE_EGRESS_SENTINEL;
  }
  if (key === "targetRevision") {
    return typeof value === "string" && REVISION.test(value)
      ? value
      : CONTEXT_PERSISTENCE_EGRESS_SENTINEL;
  }
  return CONTEXT_PERSISTENCE_EGRESS_SENTINEL;
}

/** Arguments are reduced without retaining raw content in temporary result objects. */
export function sanitizeHistoricalContextPersistenceArguments(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const sanitized: Record<string, unknown> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (SAFE_ARGUMENT_KEYS.has(key)) sanitized[key] = safeArgumentValue(key, candidate);
    else if (SENSITIVE_ARGUMENT_KEYS.has(key)) sanitized[key] = CONTEXT_PERSISTENCE_EGRESS_SENTINEL;
    else sanitized[key] = CONTEXT_PERSISTENCE_EGRESS_SENTINEL;
  }
  return sanitized;
}

function sanitizeArgumentContainer(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.stringify(sanitizeHistoricalContextPersistenceArguments(JSON.parse(value)));
    } catch {
      return JSON.stringify({ omitted: CONTEXT_PERSISTENCE_EGRESS_SENTINEL });
    }
  }
  return sanitizeHistoricalContextPersistenceArguments(value);
}

/** Preserves only the fixed metadata grammar emitted by the V1 result renderer. */
export function sanitizeHistoricalContextPersistenceText(value: unknown): string {
  if (typeof value !== "string" || value.length > 96 * 1024) return CONTEXT_PERSISTENCE_EGRESS_SENTINEL;
  const output: string[] = [];
  for (const line of value.split("\n").slice(0, 205)) {
    if (SAFE_SUMMARY_LINE.test(line)
      || SAFE_METADATA_LINE.test(line)
      || line === "Search incomplete; refine the query or use an exact opaque ID.") {
      output.push(line);
      continue;
    }
    const preview = PREVIEW_LINE.exec(line);
    if (preview) {
      output.push(`${preview[1]} ${preview[2]}: preview omitted by policy`);
      continue;
    }
    if (/^(?:pins_|pin_|memory_)[a-z_]+ (?:ok|rejected|cancelled|unavailable|committed|committed_projection_pending|indeterminate)(?:: [a-z0-9-]{1,64})?\.$/u.test(line)) {
      output.push(line);
      continue;
    }
    output.push(CONTEXT_PERSISTENCE_EGRESS_SENTINEL);
  }
  return output.join("\n") || CONTEXT_PERSISTENCE_EGRESS_SENTINEL;
}

function toolName(record: Record<string, unknown>): string | undefined {
  if (typeof record.name === "string") return record.name;
  if (typeof record.toolName === "string") return record.toolName;
  return undefined;
}

function identifiers(record: Record<string, unknown>): string[] {
  return [
    record.id,
    record.call_id,
    record.toolCallId,
    record.tool_call_id,
    record.toolUseId,
    record.tool_use_id,
  ].filter((value): value is string => typeof value === "string");
}

function collectToolCallIds(value: unknown, ids: Set<string>, seen: WeakSet<object>): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) collectToolCallIds(child, ids, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  if (toolName(record) === CONTEXT_PERSISTENCE_TOOL_NAME) {
    for (const id of identifiers(record)) ids.add(id);
  }
  for (const child of Object.values(record)) collectToolCallIds(child, ids, seen);
}

function sanitizeContent(value: unknown, safeText: string): unknown {
  if (typeof value === "string") return safeText;
  if (!Array.isArray(value)) return [{ type: "text", text: safeText }];
  return [{ type: "text", text: safeText }];
}

function sanitizeNode(
  value: unknown,
  toolCallIds: ReadonlySet<string>,
  seen: WeakMap<object, unknown>,
): { value: unknown; changed: boolean } {
  if (!value || typeof value !== "object") return { value, changed: false };
  const prior = seen.get(value);
  if (prior !== undefined) return { value: prior, changed: false };
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    let changed = false;
    for (const child of value) {
      const sanitized = sanitizeNode(child, toolCallIds, seen);
      output.push(sanitized.value);
      changed ||= sanitized.changed;
    }
    return changed ? { value: output, changed: true } : { value, changed: false };
  }

  const record = value as Record<string, unknown>;
  const directToolCall = toolName(record) === CONTEXT_PERSISTENCE_TOOL_NAME;
  const linkedResult = identifiers(record).some((id) => toolCallIds.has(id))
    || (record.role === "toolResult" && record.toolName === CONTEXT_PERSISTENCE_TOOL_NAME);
  let changed = false;
  const output: Record<string, unknown> = {};
  seen.set(value, output);

  for (const [key, child] of Object.entries(record)) {
    if (directToolCall && (key === "arguments" || key === "args" || key === "input")) {
      output[key] = sanitizeArgumentContainer(child);
      changed = true;
      continue;
    }
    if (linkedResult && key === "details") {
      const details = sanitizeHistoricalContextPersistenceDetails(child);
      output[key] = details ?? {};
      changed = true;
      continue;
    }
    if (linkedResult && (key === "content" || key === "output")) {
      const details = sanitizeHistoricalContextPersistenceDetails(record.details);
      const text = details
        ? renderHistoricalContextPersistenceResult(details)
        : sanitizeHistoricalContextPersistenceText(
          typeof child === "string"
            ? child
            : Array.isArray(child)
              ? child.flatMap((block) => isRecord(block) && typeof block.text === "string" ? [block.text] : []).join("\n")
              : undefined,
        );
      output[key] = sanitizeContent(child, text);
      changed = true;
      continue;
    }
    if (linkedResult && key === "response") {
      const response = isRecord(child) ? child : {};
      const responseKey = "error" in response ? "error" : "output";
      output[key] = {
        [responseKey]: sanitizeHistoricalContextPersistenceText(response[responseKey]),
      };
      changed = true;
      continue;
    }
    const sanitized = sanitizeNode(child, toolCallIds, seen);
    output[key] = sanitized.value;
    changed ||= sanitized.changed;
  }
  return changed ? { value: output, changed: true } : { value, changed: false };
}

export function sanitizeContextPersistenceHistory<T>(value: T): { value: T; changed: boolean } {
  const ids = new Set<string>();
  collectToolCallIds(value, ids, new WeakSet());
  const sanitized = sanitizeNode(value, ids, new WeakMap());
  return { value: sanitized.value as T, changed: sanitized.changed };
}
