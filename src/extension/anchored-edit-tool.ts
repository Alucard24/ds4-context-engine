import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { Type, type Static } from "@earendil-works/pi-ai";
import {
  createEditToolDefinition,
  defineTool,
  type EditOperations,
  type EditToolOptions,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { normalizeEditText, resolveAnchoredEdit, UPTO_MARKER } from "./anchored-edit.ts";
import { addPostEditReport, createReportingEditTool } from "./post-edit-report.ts";

export const ANCHORED_EDIT_PARAMS = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
  edits: Type.Array(Type.Object({
    oldText: Type.String({
      description: "Unique old text, or head[upto]tail for an inclusive range: head unique in the original file, tail unique after head. Anchors match exactly; newlines immediately after [upto] are separators.",
    }),
    newText: Type.String({ description: "Replacement for the entire old span, including both anchors." }),
    literal: Type.Optional(Type.Boolean({
      description: "Treat [upto] as ordinary text instead of a range marker. Default false.",
    })),
  })),
});
export type AnchoredEditInput = Static<typeof ANCHORED_EDIT_PARAMS>;

const localOperations: EditOperations = {
  access: (path) => access(path, constants.R_OK | constants.W_OK),
  readFile: (path) => readFile(path),
  writeFile: (path, content) => writeFile(path, content, "utf8"),
};

function usesAnchors(edit: Partial<AnchoredEditInput["edits"][number]>): boolean {
  return edit.literal !== true && typeof edit.oldText === "string" && edit.oldText.includes(UPTO_MARKER);
}

// tool_call handlers can mutate already-validated arguments. Recheck before I/O.
function validateInput(input: AnchoredEditInput): void {
  if (!input || typeof input.path !== "string" || !Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("Edit input requires a path and at least one replacement in edits");
  }
  for (const [index, edit] of input.edits.entries()) {
    if (!edit || typeof edit.oldText !== "string" || typeof edit.newText !== "string"
      || (edit.literal !== undefined && typeof edit.literal !== "boolean")) {
      throw new Error(`Invalid edits[${index}]: expected oldText/newText strings and optional literal boolean`);
    }
  }
}

/**
 * Expand inside native edit's read operation, NOT in prepareArguments/tool_call.
 * Native edit holds its shared mutation queue from access/read through write.
 * Per-call copies keep expanded file contents out of canonical tool arguments.
 */
export function createAnchoredEditTool(cwd: string, options?: EditToolOptions, postEditReport = false) {
  const base = createEditToolDefinition(cwd, options);
  const operations = options?.operations ?? localOperations;
  return defineTool({
    ...base,
    description: "Edit a single file with unique, non-overlapping replacements against its original content. For large old spans, use head[upto]tail in oldText to replace the inclusive range between exact anchors. Use literal: true to match [upto] literally.",
    promptSnippet: "Edit files with exact text or compact [upto] anchored ranges; supports disjoint edits[]",
    promptGuidelines: [
      "Use edit with edits[] for precise file changes. Match every edit against the original file; reject overlaps and merge nearby changes instead of overlapping edits.",
      "For large old spans, prefer oldText containing first lines, [upto], then final lines. The head must be unique in the file and the tail unique after the head; include both anchors in newText if you want to keep them.",
      "Copy anchors exactly from inspected content. Newlines immediately after [upto] are separators, not part of the tail anchor. Never omit the tail or use multiple markers. Use literal: true when oldText contains literal [upto] text.",
      "All oldText in a batch containing anchors must match exactly. Native fuzzy fallback is available only in calls without anchored edits.",
      "Keep ordinary oldText as small as possible while unique. Re-read after anchor or overlap errors; do not guess or broaden a destructive range.",
    ],
    parameters: ANCHORED_EDIT_PARAMS,
    // Native argument preparation also supports JSON-string/single-object edits
    // and legacy top-level oldText/newText. It preserves optional literal flags.
    prepareArguments: base.prepareArguments,
    async execute(toolCallId, input, signal, onUpdate, ctx) {
      validateInput(input);
      // The targeted Pi version binds cwd at construction.
      const executionCwd = ctx.cwd || cwd;
      if (!input.edits.some(usesAnchors)) {
        const ordinary = await createEditToolDefinition(executionCwd, options).execute(toolCallId, input, signal, onUpdate, ctx);
        return postEditReport ? addPostEditReport(ordinary) : ordinary;
      }
      const requests = input.edits.map((edit) => ({ ...edit }));
      const edits = requests.map((edit) => ({ oldText: edit.oldText, newText: edit.newText }));
      const ranges: Array<{ editIndex: number; startLine: number; endLine: number }> = [];
      const delegate = createEditToolDefinition(executionCwd, {
        ...options,
        operations: {
          access: (path) => operations.access(path),
          writeFile: (path, content) => operations.writeFile(path, content),
          async readFile(path) {
            const buffer = await operations.readFile(path);
            if (signal?.aborted) throw new Error("Operation aborted");
            const original = normalizeEditText(buffer.toString("utf8").replace(/^\uFEFF/, ""));
            for (const [index, edit] of requests.entries()) {
              if (!usesAnchors(edit)) {
                // Native fuzzy fallback changes the coordinate space for the
                // WHOLE batch. Prevent it from relocating an exact anchored span.
                if (!original.includes(normalizeEditText(edit.oldText))) {
                  throw new Error(`edits[${index}] in ${input.path}: anchored batches require exact ordinary oldText; re-read the file or use a separate marker-free call`);
                }
                continue;
              }
              try {
                const span = resolveAnchoredEdit(original, edit.oldText);
                edits[index]!.oldText = span.oldText;
                ranges.push({ editIndex: index, startLine: span.startLine, endLine: span.endLine });
              } catch (error) {
                throw new Error(`edits[${index}] in ${input.path}: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
            return buffer;
          },
        },
      });
      // Native batch validation, overlap/no-op checks, cancellation, BOM/EOL
      // restoration, write and diff generation all remain on the native path.
      const nativeResult = await delegate.execute(toolCallId, { path: input.path, edits }, signal, onUpdate, ctx);
      const result = postEditReport ? addPostEditReport(nativeResult) : nativeResult;
      return {
        ...result,
        content: [...result.content, {
          type: "text" as const,
          text: `Anchored replacements (original lines): ${ranges.map((range) => `edits[${range.editIndex}] ${range.startLine}-${range.endLine}`).join(", ")}.`,
        }],
        details: result.details && { ...result.details, anchoredRanges: ranges },
      };
    },
    renderCall(args, theme, context) {
      // The native preview matcher does not understand markers. Do not run a
      // misleading pre-execution preview; renderResult supplies the actual diff.
      const anchored = Array.isArray(args.edits) && args.edits.some((edit) => edit && usesAnchors(edit));
      return base.renderCall!(args, theme, anchored ? { ...context, argsComplete: false } : context);
    },
  });
}

/** Session-bound opt-in. Do not claim tools reported as extension-/SDK-owned. */
export function createAnchoredEditRegistration(pi: ExtensionAPI) {
  let registered = false;
  return (features: boolean | { anchored: boolean; postEditReport: boolean }, ctx: ExtensionContext): void => {
    const anchored = typeof features === "boolean" ? features : features.anchored;
    const postEditReport = typeof features === "boolean" ? false : features.postEditReport;
    const enabled = anchored || postEditReport;
    if (!enabled && !registered) return;
    const existing = pi.getAllTools().find((tool) => tool.name === "edit");
    if (!registered && existing?.sourceInfo.source !== "builtin") {
      if (ctx.hasUI) ctx.ui.notify("DS4 anchored edit not registered: native edit is unavailable or already overridden.", "warning");
      return;
    }
    // Pi has no unregisterTool API. After an enabled session, restore the native
    // definition on disable. A fresh reload while disabled registers nothing.
    pi.registerTool(anchored ? createAnchoredEditTool(ctx.cwd, undefined, postEditReport)
      : postEditReport ? createReportingEditTool(ctx.cwd) : createEditToolDefinition(ctx.cwd));
    registered = true;
  };
}
