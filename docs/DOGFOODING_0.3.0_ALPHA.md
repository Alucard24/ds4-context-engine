# Dogfooding DS4 0.3.0 Alpha

This runbook validates the published `ds4-context-engine@0.3.0-alpha.2` package through sustained real Pi use. It complements automated tests and release smoke checks; it does not replace them.

The primary target is the model-callable `context_persistence` surface. Pi JSONL must remain canonical and append-only, SQLite must remain rebuildable, and no model-callable write may occur without a fresh positive local UI decision.

## Safety and scope

- Use the exact prerelease version, not the mutable `alpha` dist-tag.
- Use a disposable trusted project and a dedicated session directory.
- Use synthetic, non-secret Pin/Memory content. Local TUI dialogs and JSON event streams may display current tool arguments.
- Published alpha.1 had a retry limitation: copying `[omitted-by-ds4-egress-policy]` from sanitized history could present a confirmation for the literal marker. Alpha.2 reserves that output-only marker and must reject it as `egress-placeholder` before runtime access, confirmation, canonical append, or derived-policy update.
- Do not use `--no-session` except for the explicit fail-closed test. Without a persistent Pi JSONL destination, both reads and writes return `runtime-unavailable`.
- Do not retry `committed_projection_pending` or `indeterminate`. Inspect state with a read, `/context health`, or `/context rebuild-index` first.
- Use `/context` only for local inspection and recovery. Mutations under test must go through `context_persistence` so the confirmation and provider-egress boundaries are exercised.
- Never edit a Pi session JSONL file during the run.

Recommended minimum before promoting the alpha: three normal work sessions, two process restarts, one branch change, one projection rebuild, the TUI/RPC/print/JSON matrix, one configured remote provider, and—when available—one verified local provider.

## Isolated setup

Pi packages execute with the user's full permissions. Review the package before installation.

```bash
mkdir -p /tmp/ds4-alpha-dogfood
cd /tmp/ds4-alpha-dogfood
git init
mkdir -p sessions evidence
pi install -l npm:ds4-context-engine@0.3.0-alpha.2
pi list
pi --version
```

The `-l` installation is project-local and the exact npm version is pinned. Run Pi from this directory. Use `--approve` only after trusting this disposable project; non-interactive modes cannot show the project-trust dialog.

Use the same dedicated session directory throughout:

```bash
export DS4_DOGFOOD_SESSIONS="$PWD/sessions"
```

Record the Pi version, DS4 version, provider/model, mode, session name, expected result, observed result, and pass/fail status for every scenario.

## Synthetic test data

Use unique non-sensitive values so duplicates from earlier runs cannot hide a failure. Example run label:

```text
alpha2-run-01
```

Example Pin:

```text
For alpha2-run-01 verification, use Node.js 22 in this disposable project.
```

Example Memory:

```text
For alpha2-run-01, the synthetic release channel is amber.
```

Never use real credentials, customer data, private paths, or production policy in dogfooding prompts.

## TUI procedure

Start a persistent interactive session:

```bash
pi --approve --session-dir "$DS4_DOGFOOD_SESSIONS" \
  --name "ds4-alpha-tui"
```

Run these scenarios in order:

1. Inspect `/context health`, `/context pins`, `/context memory`, and `/context privacy`.
2. Send an ordinary suggestion without asking to persist it, for example: `The synthetic release channel amber seems useful.` No `context_persistence` call or confirmation dialog should appear.
3. Explicitly request the synthetic Memory: `Remember for this session that the synthetic release channel for alpha2-run-01 is amber.` Verify that the dialog identifies the action and canonical persistence class. Accept it. Expect one committed Memory mutation.
4. Ask the model to use `context_persistence` to list active Memory. Verify bounded metadata and no complete claim, key, reason, path, or raw error in the result.
5. Explicitly request the synthetic Pin, but reject or close the confirmation dialog. Verify with `/context pins` that it was not created.
6. Ask the model to retry using the sanitized value remaining in history. If it copies `[omitted-by-ds4-egress-policy]`, expect `rejected / egress-placeholder` before any new confirmation, runtime mutation, or append. If it asks for fresh text instead, record that safe routing result and run the exact-marker case from the JSON procedure.
7. Request the Pin again with fresh synthetic text and accept it. Ask the model to list Pins, then use the exact returned Pin ID and `targetRevision` to unpin it in the same process. Accept the destructive confirmation. Fuzzy targeting must not be used.
8. With a remote provider, request a `local-only` Pin. Expect provider-policy denial before confirmation and no append.
9. Restart Pi and continue the session:

   ```bash
   pi --approve --session-dir "$DS4_DOGFOOD_SESSIONS" -c
   ```

   Verify the accepted Memory remains visible. Revision handles from the previous process are intentionally invalid; perform a fresh read before any targeted write.
10. Run `/context rebuild-index`, then verify the same canonical Memory/Pin lifecycle state is reconstructed.

TUI passes when accepted writes append once, refusal/closure appends nothing, destructive writes require an exact fresh revision, ordinary conversation does not persist, and rebuild preserves canonical state.

## RPC procedure

RPC mode exposes extension dialogs through a JSON request/response protocol. It reports `ctx.hasUI=true` because a client can answer those requests; the client is the UI bridge.

Start a persistent RPC process from the disposable project:

```bash
pi --mode rpc --approve \
  --session-dir "$DS4_DOGFOOD_SESSIONS" \
  --name "ds4-alpha-rpc" \
  2>evidence/rpc.stderr.log
```

Enter one JSON object per line on stdin. First request a read:

```json
{"id":"read-1","type":"prompt","message":"Use context_persistence with action pins_list to inspect active Pins. Do not perform a write."}
```

Wait for the turn to end before sending the next prompt. For a write:

```json
{"id":"write-1","type":"prompt","message":"Persist a session Pin for alpha2-run-01 stating that this disposable project uses Node.js 22 for verification."}
```

Pi should emit a request shaped like:

```json
{"type":"extension_ui_request","id":"<dynamic-id>","method":"confirm","title":"DS4 Context Persistence","message":"..."}
```

After inspecting the request, approve it with the exact dynamic ID:

```json
{"type":"extension_ui_response","id":"<dynamic-id>","confirmed":true}
```

Expect the `context_persistence` tool result to report a committed outcome without echoing complete Pin content. Repeat with a different synthetic value and reject it:

```json
{"type":"extension_ui_response","id":"<dynamic-id>","confirmed":false}
```

The rejected call must report cancellation and append nothing. `{"cancelled":true}` is also a valid dialog dismissal response.

### RPC without a responding UI client

Start a separate disposable RPC process, request a write, and do not send an `extension_ui_response`. In Pi `0.84.3`, the confirmation remains pending because RPC still advertises UI capability. This is not converted to `confirmation-required`; no append may occur before a positive response. Terminate the disposable process after recording the pending request, then inspect the session from TUI.

### RPC without a persistent session

Start a separate process:

```bash
pi --mode rpc --approve --no-session
```

Send a read and a write prompt. Both must return `runtime-unavailable`; no `extension_ui_request` should be emitted and no canonical commit should be claimed.

RPC passes when positive confirmation commits once, negative/cancelled confirmation appends nothing, an unanswered dialog remains pending without append, `--no-session` fails before confirmation, and result content/details remain bounded and metadata-only.

## Print-mode procedure

Print mode has no extension UI. Keep session persistence enabled:

```bash
pi -p --approve --session-dir "$DS4_DOGFOOD_SESSIONS" \
  "Use context_persistence with action memory_list to inspect active Memory. Do not write."
```

The read should complete. Then request a write:

```bash
pi -p --approve --session-dir "$DS4_DOGFOOD_SESSIONS" \
  "Use context_persistence to add a session Memory saying that alpha2-run-01 uses the synthetic channel amber."
```

Expected behavior:

```text
outcome=unavailable
errorCode=confirmation-required
```

No dialog can appear and no canonical custom entry may be appended. The assistant's final wording can vary; use JSON mode or the canonical audit below when the exact tool envelope is needed. If the model does not call the tool, record that separately as a routing observation and repeat with the explicit action name to isolate runtime behavior.

Adding `--no-session` changes the expected error to `runtime-unavailable` for both reads and writes.

## JSON event-stream procedure

JSON mode is also non-interactive, but it exposes authoritative tool lifecycle events. Capture the complete local stream; it may include current non-secret tool arguments.

Read case:

```bash
pi --mode json --approve --session-dir "$DS4_DOGFOOD_SESSIONS" \
  "Use context_persistence with action pins_list to inspect active Pins. Do not write." \
  2>evidence/json-read.stderr.log | tee evidence/json-read.jsonl
```

Write case:

```bash
pi --mode json --approve --session-dir "$DS4_DOGFOOD_SESSIONS" \
  "Use context_persistence to add a session Pin for alpha2-run-01 stating that this disposable project uses Node.js 22." \
  2>evidence/json-write.stderr.log | tee evidence/json-write.jsonl
```

Reserved historical-placeholder regression:

```bash
pi --mode json --approve --session-dir "$DS4_DOGFOOD_SESSIONS" \
  "Call context_persistence exactly once with action pin_add, scope session, classification normal, and content exactly [omitted-by-ds4-egress-policy]." \
  2>evidence/json-placeholder.stderr.log | tee evidence/json-placeholder.jsonl
```

Extract tool completions:

```bash
jq -c '
  select(.type == "tool_execution_end" and .toolName == "context_persistence")
  | {isError, result}
' evidence/json-*.jsonl
```

The read should succeed. The ordinary write must return `confirmation-required` and append nothing. The placeholder case must return `rejected / egress-placeholder`, not request confirmation, and append nothing. Inspect `result.content` and `result.details` for bounded allowlisted metadata; they must not echo complete content, claims, keys, reasons, paths, source-session identity, confirmation text, or raw errors.

The local `tool_execution_start.args` event can contain the current synthetic arguments supplied to the tool. That local event is not the provider-facing result contract, which is why dogfooding must use non-sensitive data and evidence files must not be published blindly.

## Canonical append audit

List only metadata for canonical Pin/Memory entries in the dedicated sessions:

```bash
find "$DS4_DOGFOOD_SESSIONS" -name '*.jsonl' -print0 \
  | xargs -0 -r jq -r '
      select(
        .type == "custom"
        and (
          .customType == "ds4-context-pin-v1"
          or .customType == "ds4-context-memory-v1"
        )
      )
      | [.customType, .id, .timestamp, (.data.operation // "unknown")]
      | @tsv
    '
```

Expected invariants:

- each accepted canonical add/supersede/status operation contributes exactly one append-only custom entry;
- cancelled, rejected, unavailable, and unanswered-confirmation operations contribute none;
- print/JSON writes contribute none;
- `--no-session` contributes none;
- source include/exclude policy contributes no Pin/Memory custom entry because it is derived local SQLite policy;
- rebuild changes projections, not the JSONL mutation sequence.

Do not publish the session files: they are canonical local history and may contain prompt/tool argument text even when tool results are metadata-only.

## Extended provider and lifecycle matrix

After the basic mode matrix passes, repeat the relevant TUI/RPC cases with:

- a configured remote provider;
- a verified local provider whose exact provider ID is listed in `privacy.localProviders`;
- privacy enabled and disabled;
- a provider switch between read and targeted write;
- a branch switch between read and targeted write;
- trusted and untrusted project state;
- two simultaneous Pi sessions using the shared SQLite database;
- cross-session project Memory when `memory.crossSession` is explicitly enabled.

Provider, trust, branch, provenance, capability, target state, and classification changes after confirmation must fail safely. A model-supplied `local-only` classification is never evidence that earlier input stayed local.

## Result record

Use one record per scenario:

```text
Run ID:
Date:
Pi version:
DS4 exact version:
Provider/model:
Mode and session persistence:
Scenario:
Expected outcome:
Observed outcome:
Confirmation shown/answered:
Canonical entries before/after:
Projection/rebuild observation:
Result leak check:
Pass/fail:
Issue/reference:
```

## Promotion criteria

Do not promote the alpha if any run shows:

- a write without a fresh positive local UI decision;
- canonical JSONL rewrite, loss, duplication, or a false commit claim;
- complete persistent content or prohibited metadata in provider-facing results/history;
- fuzzy destructive targeting or acceptance of a stale revision;
- failure to reconstruct canonical state from JSONL;
- an actionable warning hidden as routine debug output;
- a reproducible regression above the release latency/quality/schema gates.

A missing live local-provider run should remain explicitly recorded rather than inferred from remote-provider or automated-test results.
