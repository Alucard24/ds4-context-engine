# Optional portable agent tools

These features are separate opt-ins, also gated by the DS4 master `enabled` switch. They do not implement inference rewind, forced sampling, or native KV-cache integration. Pi remains the agent runtime.

Enable only the features you want, then reload:

```text
/context config set editing.postEditReport true
/context config set reading.adaptive true
/context config set artifacts.adaptiveBudget true
/context config set jobs.enabled true
/reload
```

All four default to `false`. Configuration writes apply on the next session load, not immediately. The default target is the trusted project configuration; add `--global` for the agent-directory file. Disable with the same commands using `false`, then reload.

## Post-edit reports

`editing.postEditReport` works with native ordinary edits, independently of `editing.anchored`. Enable both to combine reports with [`[upto]` ranges](ANCHORED_EDITING.md).

After a successful edit, the tool result content and details include:

- actual old/new changed ranges from Pi's native unified patch;
- total line delta and cumulative shift for subsequent lines;
- bounded numbered context from the updated content, encoded as quoted JSON data.

Regions combine nearby changes in the same native patch hunk. Zero-length ranges identify insertion/deletion boundaries. Coordinates refer to the completed write, not future file state. Reports include at most six regions and six short context lines per region; rendered report text stays below 6000 characters. The native patch/diff remains available and the TUI continues to display the native diff. There is no separate file read after the write and no change to matching or mutation queues. If reporting fails, the successful edit result is retained rather than encouraging a duplicate write.

## Adaptive reads

`reading.adaptive` changes only the default line limit of the native `read` tool:

| Execution-time model window | Default lines |
| --- | ---: |
| <= 8192 tokens | 120 |
| <= 16384 tokens | 240 |
| larger | 500 |
| missing/invalid model window | native default |

Explicit positive integer `offset`/`limit` values are honored; native byte limits can still shorten a response. Images, path resolution, access errors and cancellation remain native. The model is checked on each execution, so switching models does not require reload. Arguments are copied, not rewritten in canonical tool calls.

Use the native continuation notice, e.g. `offset=121`, to read more. There is deliberately no shared `more` cursor, which could become ambiguous after concurrent reads, branching or compaction. This does not reduce the native reader's full-file I/O or memory use.

Both file overrides skip initial registration if their built-in tool is missing or visibly overridden. Disabling an already-enabled instance restores the native definition; fresh disabled loads register nothing. Compatibility is tested against the project's Pi dependency, currently `0.84.3`. Custom SDK/remote filesystem integrations are not covered by these local wrappers.

## Adaptive tool-result/artifact budget

`artifacts.adaptiveBudget` operates only where artifact offload already operates: DS4 enabled, managed context, and artifact storage enabled/available.

The per-context policy uses the same calibrated active input budget as the planner, after output reserve and safety margin. It subtracts estimated system/tool-schema overhead, other messages and non-text blocks, then shares 75% of remaining capacity among candidate text results. It can only lower `artifacts.maxInlineToolResultChars` and `artifacts.excerptChars`, never raise them. The reference-metadata floor is 1600 characters or the configured inline maximum, whichever is smaller.

This is estimated budgeting, not a tokenizer-exact fit guarantee. Irreducible metadata, errors, missing provenance or unavailable storage can still leave a context oversized. The existing planner and fallback behavior remain responsible; there is no recursive `ctx.compact()` call inside the context hook.

Canonical Pi messages stay unchanged. Only privacy-prepared provider-facing text is transformed, with the original tool identity, source IDs and non-text blocks preserved. Artifact storage/search caps and branch/privacy checks remain unchanged. Rebuild uses the conservative adaptive floor so earlier small-budget artifacts remain reconstructible; consequently it may reconstruct more small artifacts than the fixed-threshold policy. A result is not replaced with a larger estimated result.

## Managed local bash jobs

The `bash_job` tool is implemented in a separate optional module, not in the portable core. It does not replace `bash` and is not a new agent loop or a separate published package.

Examples of tool arguments:

```json
{"action":"start","command":"npm test","timeout":300}
{"action":"list"}
{"action":"status","id":"<returned-job-id>"}
{"action":"stop","id":"<returned-job-id>"}
```

### Authorization and execution

- Requires an active built-in local `bash`, an unclaimed `bash_job` name, a trusted project, and local UI confirmation for every start. Missing UI or refused confirmation means no command starts. Tool-call arguments are revalidated, and the confirmed command/cwd/timeout are snapshotted.
- Executes in the current working directory using Pi's public local BashOperations. It **does not inherit** custom bash-only permission hooks, remote/sandbox behavior, SDK shell settings/command prefixes, or session-specific `PI_*` injection. It must not be used to bypass those controls. The confirmation explicitly identifies the local execution boundary.
- Status/stop/list use opaque IDs owned by the current session and originating branch entry, never arbitrary PIDs. Stop remains available for owned jobs even if bash is later deactivated.
- Four running jobs maximum; sixteen retained records maximum. Oldest completed records/logs are evicted first. Timeout defaults to 300 seconds; valid range is 1–3600 seconds.

### Output and lifecycle

Logs combine stdout/stderr in native arrival order. Each private local log is capped at 8 MiB; reaching the cap or a write error stops the job. Status returns at most 512 bytes of head plus 512 bytes of non-overlapping tail, quoted in JSON, and the local output path. For larger logs, read that path while the session remains open. `outputTruncated` also indicates omitted middle output; `status=output-limit` distinguishes a capped log. A nonzero exit code is reported, not hidden.

Successful start returns immediately; subsequent agent cancellation does not silently kill the independently running job. Cancelling a status request does not stop it. Use `stop` explicitly. Completion marks project indexing dirty but does not trigger another model turn.

Jobs survive compaction. The extension appends a bounded canonical **metadata snapshot** after compaction, without command/output text or a follow-up model request. Refresh status before acting on any old snapshot. Branch navigation stops jobs no longer visible from the new branch; ancestor-owned jobs remain visible. Session replacement, reload and graceful shutdown stop jobs and remove their logs. State is not persisted in SQLite, Memory or Pins and is not restored after restart.

Native Pi handles process-tree cancellation. There is no rollback of command side effects and no guarantee of controlling deliberately escaped daemons. Forced process termination/crashes can leave temporary logs; abrupt-exit cleanup is not guaranteed. Raw logs can contain secrets: do not publish or persist them blindly. Linux tests do not establish Windows execution success.

Architecture: [ADR 060](ADR/060-optional-portable-agent-tools.md).
