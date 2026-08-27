import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";

export const CONTEXT_PERSISTENCE_TOOL_CONTRACT = "ds4-context-persistence-tool-v1" as const;
export const CONTEXT_PERSISTENCE_RESULT_CONTRACT = "ds4-context-persistence-result-v1" as const;
export const CONTEXT_PERSISTENCE_EGRESS_SENTINEL = "[omitted-by-ds4-egress-policy]" as const;
export const CONTEXT_PERSISTENCE_TOOL_NAME = "context_persistence" as const;
export const CONTEXT_PERSISTENCE_DESCRIPTION = "Inspect DS4 Pins/Memory. Write only after an explicit user request; writes require local user confirmation." as const;
export const CONTEXT_PERSISTENCE_PROMPT_SNIPPET = "Inspect or manage user-confirmed DS4 pins and durable memory" as const;
export const CONTEXT_PERSISTENCE_PROMPT_GUIDELINES = [
  "Use context_persistence only to inspect DS4 persistent state or when the user explicitly requests a persistence mutation.",
  "After an explicit persistence request, call the write action directly; context_persistence itself obtains the required local UI confirmation, so do not ask for separate confirmation in chat.",
  "Never reuse an egress omission marker as tool input; use fresh user-provided text or ask the user to restate it.",
  "Never create a pin or memory merely because information appears useful.",
  "Use pins for confirmed constraints or instructions that must remain prominent. Use memory for durable facts, decisions, and historical knowledge.",
  "Default new persistence to session scope. Use project or branch scope only when explicitly requested or unambiguous; durable Memory does not support branch scope.",
  "Before superseding, removing, invalidating, expiring, excluding, or including, read first and use the exact ID or reference plus targetRevision; never mutate from a fuzzy query.",
  "Do not claim local-only protection if a remote model already saw the input; use /context or a local provider for data that must never reach a remote provider.",
] as const;

export const CONTEXT_PERSISTENCE_ACTIONS = [
  "pins_list",
  "pins_find",
  "pin_add",
  "pin_supersede",
  "pin_unpin",
  "memory_list",
  "memory_find",
  "memory_add",
  "memory_supersede",
  "memory_invalidate",
  "memory_expire",
  "memory_sources",
  "memory_source_exclude",
  "memory_source_include",
] as const;

export type ContextPersistenceAction = typeof CONTEXT_PERSISTENCE_ACTIONS[number];

export const CONTEXT_PERSISTENCE_READ_ACTIONS = [
  "pins_list",
  "pins_find",
  "memory_list",
  "memory_find",
  "memory_sources",
] as const satisfies readonly ContextPersistenceAction[];

export type ContextPersistenceReadAction = typeof CONTEXT_PERSISTENCE_READ_ACTIONS[number];

export const CONTEXT_PERSISTENCE_WRITE_ACTIONS = CONTEXT_PERSISTENCE_ACTIONS.filter(
  (action): action is Exclude<ContextPersistenceAction, ContextPersistenceReadAction> =>
    !(CONTEXT_PERSISTENCE_READ_ACTIONS as readonly string[]).includes(action),
);

export const CONTEXT_PERSISTENCE_PARAMS = Type.Object({
  action: StringEnum(CONTEXT_PERSISTENCE_ACTIONS),
  scope: Type.Optional(StringEnum(["session", "branch", "project"] as const, {
    description: "Add only; Memory excludes branch",
  })),
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  targetRevision: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  content: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
  key: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  query: Type.Optional(Type.String({ minLength: 2, maxLength: 200 })),
  reason: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 500,
    description: "Lifecycle or source exclusion only",
  })),
  classification: Type.Optional(StringEnum([
    "normal",
    "internal",
    "sensitive",
    "local-only",
  ] as const)),
  activeOnly: Type.Optional(Type.Boolean()),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });

export type ContextPersistenceParams = Static<typeof CONTEXT_PERSISTENCE_PARAMS>;

const ALLOWED_FIELDS = {
  pins_list: ["action", "activeOnly", "maxResults"],
  pins_find: ["action", "query", "activeOnly", "maxResults"],
  pin_add: ["action", "content", "scope", "classification"],
  pin_supersede: ["action", "id", "targetRevision", "content", "classification"],
  pin_unpin: ["action", "id", "targetRevision", "reason"],
  memory_list: ["action", "activeOnly", "maxResults"],
  memory_find: ["action", "query", "activeOnly", "maxResults"],
  memory_add: ["action", "content", "scope", "key", "classification"],
  memory_supersede: ["action", "id", "targetRevision", "content", "classification"],
  memory_invalidate: ["action", "id", "targetRevision", "reason"],
  memory_expire: ["action", "id", "targetRevision", "reason"],
  memory_sources: ["action", "maxResults"],
  memory_source_exclude: ["action", "id", "targetRevision", "reason"],
  memory_source_include: ["action", "id", "targetRevision"],
} as const satisfies Record<ContextPersistenceAction, readonly (keyof ContextPersistenceParams)[]>;

const REQUIRED_FIELDS = {
  pins_list: [],
  pins_find: ["query"],
  pin_add: ["content"],
  pin_supersede: ["id", "targetRevision", "content"],
  pin_unpin: ["id", "targetRevision"],
  memory_list: [],
  memory_find: ["query"],
  memory_add: ["content"],
  memory_supersede: ["id", "targetRevision", "content"],
  memory_invalidate: ["id", "targetRevision"],
  memory_expire: ["id", "targetRevision"],
  memory_sources: [],
  memory_source_exclude: ["id", "targetRevision"],
  memory_source_include: ["id", "targetRevision"],
} as const satisfies Record<ContextPersistenceAction, readonly (keyof ContextPersistenceParams)[]>;

export type ContextPersistenceValidationCode =
  | "invalid-parameters"
  | "invalid-scope"
  | "egress-placeholder";

export type ContextPersistenceValidation =
  | { ok: true; value: ContextPersistenceParams }
  | { ok: false; errorCode: ContextPersistenceValidationCode };

function isAction(value: unknown): value is ContextPersistenceAction {
  return typeof value === "string"
    && (CONTEXT_PERSISTENCE_ACTIONS as readonly string[]).includes(value);
}

export function isReadAction(action: ContextPersistenceAction): action is ContextPersistenceReadAction {
  return (CONTEXT_PERSISTENCE_READ_ACTIONS as readonly string[]).includes(action);
}

/**
 * Action-specific validation performed after TypeBox transport validation.
 * Values are never included in failures so provider-visible errors stay metadata-only.
 */
export function validateContextPersistenceParams(
  params: ContextPersistenceParams,
): ContextPersistenceValidation {
  if (!params || !isAction(params.action)) return { ok: false, errorCode: "invalid-parameters" };
  const keys = Object.keys(params) as (keyof ContextPersistenceParams)[];
  const allowed = new Set<keyof ContextPersistenceParams>(ALLOWED_FIELDS[params.action]);
  if (keys.some((key) => !allowed.has(key))) {
    return { ok: false, errorCode: "invalid-parameters" };
  }
  if (REQUIRED_FIELDS[params.action].some((key) => params[key] === undefined)) {
    return { ok: false, errorCode: "invalid-parameters" };
  }
  if (keys.some((key) => {
    const value = params[key];
    return typeof value === "string" && value.includes(CONTEXT_PERSISTENCE_EGRESS_SENTINEL);
  })) {
    return { ok: false, errorCode: "egress-placeholder" };
  }
  if (params.scope === "branch" && params.action === "memory_add") {
    return { ok: false, errorCode: "invalid-scope" };
  }
  return { ok: true, value: params };
}
