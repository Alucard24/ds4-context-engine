# DS4 Context Engine for Pi

DS4 Context Engine is a Pi extension that keeps Pi's JSONL session as the canonical history while building an inspectable, model-aware working context.

> Current status: **M4 Custom Compaction**. Managed context now includes non-destructive, source-grounded compaction with a strict summary contract, deterministic validation, provenance hashes, crash recovery, and fail-open fallback to Pi's default compaction.

## Compatibility

- Pi: `@earendil-works/pi-coding-agent` **0.84.3**
- Node.js: **22.19.0 or newer**
- SQLite: Node's built-in `node:sqlite` module

The Pi version is intentionally pinned until extension contract tests validate newer releases.

## Local development

```bash
npm install
npm run check
pi -e ./src/extension/index.ts
```

To install this checkout as a project-local Pi package:

```bash
pi install -l .
```

Pi packages and project extensions execute with the user's full permissions. Review and trust the project before loading it.

## Commands available now

```text
/context
/context status
/context tokens
/context manifest
/context explain
/context included
/context excluded
/context compaction
/context compact-preview
/context health
/context rebuild-index
```

Managed mode is the default. Every model call reserves system/tool overhead, preserves mandatory groups, selects a contiguous recent tail, validates tool-call atomicity, and returns the selected messages through Pi's `context` hook. At the proactive threshold or Pi's own compaction trigger, DS4 summarizes only Pi's discarded span, preserves `firstKeptEntryId`, validates the result, and stores provenance both in Pi JSONL details and the rebuildable database. Planner and compaction failures remain fail-open.

## Configuration

Global configuration:

```text
~/.pi/agent/ds4-context.json
```

Project override (loaded only for a trusted project):

```text
.pi/ds4-context.json
```

Example:

```json
{
  "enabled": true,
  "context": {
    "mode": "managed",
    "targetFillRatio": 0.70,
    "minimumOutputReserve": 8192,
    "preferredOutputReserve": 32768
  },
  "compaction": {
    "enabled": true,
    "validate": true,
    "segmentTargetTokens": 30000,
    "preserveRecentVerbatim": true
  },
  "diagnostics": {
    "logLevel": "info"
  },
  "storage": {
    "databasePath": "~/.pi/agent/ds4-context/context.db"
  }
}
```

Set `context.mode` to `"observer"` for a pass-through rollback that still records manifests. Unknown or invalid values are ignored with a warning. Project configuration never loads when Pi reports the project as untrusted.

## Architectural invariants

1. Pi JSONL is the canonical session truth.
2. SQLite contains only derived, rebuildable data indexed by `(session_id, entry_id)`.
3. Compaction never deletes raw history.
4. Provider continuation and caches are optional optimizations.
5. Every selected item will carry provenance.
6. Failures are fail-open: Pi continues with its native context.
7. Core policy code does not depend on Pi types; integration stays in `src/pi-adapter` and `src/extension`.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/CONTEXT_PLANNER.md`](docs/CONTEXT_PLANNER.md), [`docs/COMPACTION.md`](docs/COMPACTION.md), and the original development plan in [`DS4_Context_Engine_Extension_Piano_Sviluppo.md`](DS4_Context_Engine_Extension_Piano_Sviluppo.md).
