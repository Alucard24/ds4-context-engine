# Optional anchored editing

DS4 can replace Pi's native `edit` definition with a compatible, opt-in wrapper.
This is execution-time editing, not a generation-time forcer. It works with any
provider that can call Pi tools; it does not require a custom inference backend.

## Enable or disable

Default: `editing.anchored: false`. In a trusted project:

```text
/context config set editing.anchored true
/reload
```

Use `--global` on the config command to target the agent-directory configuration.
As with other DS4 config writes, the active session configuration is not changed
by `set`/`unset`; it is loaded on session startup/replacement or reload.

When updating a development checkout, rebuild the core (`npm run build:core`)
and fully restart Pi. Reloading extension TypeScript can retain previously loaded
compiled core modules. A core configuration without `editing` safely leaves this
feature disabled, but the updated core must be loaded to recognize the option.

```json
{
  "editing": { "anchored": true }
}
```

`enabled: false` also disables this override. `context.mode` still controls context
planning, not explicitly opted-in editing. Project configuration is ignored when
Pi does not trust the project; global configuration continues to apply.

On a fresh disabled load DS4 does not register `edit` at all. If an enabled
extension instance later loads disabled configuration, it restores Pi's native
edit definition, schema and guidelines. Pi has no public `unregisterTool`; a
reload while disabled removes DS4's registration entirely.

Registration is skipped if native `edit` is unavailable or already owned by
another extension/SDK tool, with a UI warning when available. DS4 does not enable
an inactive native edit tool. Only ownership reported by Pi can be checked: SDK
custom base tools labeled as built-ins cannot be distinguished through this API.
Do not enable this feature with other edit replacements or remote/sandbox edit
implementations; the registered wrapper uses local filesystem operations.

## Tool input

The tool name remains `edit`, with `path` and `edits[]`:

```json
{
  "path": "src/example.ts",
  "edits": [{
    "oldText": "function oldImplementation() {\n[upto]\n}\n// end oldImplementation\n",
    "newText": "function oldImplementation() {\n  return improved();\n}\n// end oldImplementation\n"
  }]
}
```

Each anchored `oldText` must contain exactly one `[upto]` marker:

- The **head**, before the marker, must occur exactly once in the original file.
- The **tail**, after the marker, must occur exactly once after the end of the
  head. The same tail occurring before the head is allowed.
- Both anchors must contain non-whitespace text. Spaces are significant.
- Newlines immediately after the marker are separators and are removed from the
  tail needle, matching DS4's marker-line convention. Other whitespace is not
  trimmed. Anchors may be inline; full distinctive lines are usually clearer.
- Replacement is **inclusive**: head, intermediate content and tail are all
  replaced. Put anchors in `newText` if they should be retained.
- All edits refer to the original file, not previous replacements in the batch.
  Overlaps (including mixed ordinary/anchored overlaps), missing or ambiguous
  anchors and no-op batches are rejected without a write.
- No 64-byte/two-line threshold applies to manually supplied anchors; those DS4
  thresholds belong to automatic marker forcing, which is not implemented here.

A marker is special only in `oldText`, never in `newText`. To match literal marker
text, set `literal: true` **on that edit**:

```json
{
  "path": "notes.md",
  "edits": [{ "oldText": "[upto]", "newText": "range marker", "literal": true }]
}
```

Calls without anchored edits use native Pi matching, including its normalized
fuzzy fallback (also for `literal: true` edits). **Every edit in a batch containing
anchors must match exactly**, ordinary edits included. Pi's fuzzy fallback changes
the coordinate space for the entire batch and can relocate an otherwise exact
anchored span; mixed fuzzy batches therefore fail closed. Re-read and correct the
ordinary oldText, or perform the ordinary edit separately and re-read before
anchored edits.

Exact matching uses BOM-free, LF-normalized original content. Expanded spans then
pass through native batch checks, including Pi's stricter normalized-ambiguity
check. Thus a range can be rejected even if its literal anchors pass, when the
expanded text is ambiguous under Pi's normalization. Re-read and disambiguate;
do not silently broaden the range.

## Execution and feedback

`src/extension/anchored-edit-tool.ts` uses public Pi `createEditToolDefinition` and
`EditOperations`. Its per-call read operation expands anchors only after native
edit has entered `withFileMutationQueue`. Native edit then performs batch matching,
overlap checks, cancellation checks, BOM/line-ending restoration, writing and
diff generation. It is deliberately **not** a `tool_call` preflight expansion:
there is no unqueued read followed by a later queued write.

Expansion uses private argument copies: the full old span is not inserted into
canonical tool-call arguments or sent back as an expanded input. Native results
and diff/patch details remain available, plus a compact text report of anchored
ranges in original line numbers. Canonical result details can still contain old
text through native diffs; this is not an output privacy/filtering feature.

The native TUI matcher cannot preview marker syntax. Anchored calls therefore
skip its pre-execution preview and display the **actual native result diff** after
execution. Ordinary edits retain their native preview behavior.

The shared Pi queue serializes cooperating edits/writes in the same runtime,
including symlink aliases. It is not a cross-process file lock, transaction with
external editors, atomic filesystem write or rollback guarantee. Cancellation
retains native behavior; once a write has begun it may still complete. Existing
`tool_call`/`tool_result` hooks continue to see the `edit` tool, not a new tool name.
Hooks that interpret `oldText` themselves must understand the opt-in syntax.

## Scope and verification

The implementation targets the project's Pi **0.84.3** dependency. No dependency
upgrade, provider grammar, streaming interception, KV rewind or forced continuation
is included. The reference adapter does not implement this Pi editing capability.

Tests cover exact matching, suffix-only tail uniqueness, overlapping matches,
malformed markers, literal escaping, mixed batches, fuzzy-fallback compatibility,
BOM/CRLF/Unicode, unchanged arguments, result diffs, cancellation, queue ordering,
symlinks, permissions, working-directory selection and session-bound registration.
The package smoke check also inspects the real Pi tool registry offline with the
flag absent, enabled, master-disabled and enabled while native edit is inactive
or unavailable.
A deterministic large-block fixture compares serialized request bytes and verifies
the same output as native editing. Real-provider reliability, token usage and
latency improvements have **not** been measured; shorter oldText can save generated
text, while the opt-in tool schema/instructions also add prompt overhead.
