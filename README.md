# DS4 Context Engine for Pi

DS4 Context Engine is a Pi extension that keeps Pi's JSONL session as the canonical history while building an inspectable, model-aware working context.

> Current status: **M7 Project Knowledge**. Managed context combines branch-local historical recovery with current, hash-validated project snippets selected by file, symbol, phrase, and FTS5 relevance under separate model-aware budgets.

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
/context summaries
/context retrieved
/context project
/context compaction
/context compact-preview
/context health
/context rebuild-index
```

Managed mode is the default. Every model call reserves system/tool overhead, preserves mandatory groups, selects a contiguous recent tail, retrieves branch-local historical evidence, fits current project snippets, then active summaries. Project snippets are indexed only when Pi marks the project trusted, validated against the live SHA-256 before use, and quoted as untrusted data with path, lines, hash, Git revision, score, and reason. Compaction continues to create immutable segment and aggregate nodes rebuildable from Pi JSONL. Planner, retrieval, project-index, and compaction failures remain fail-open.

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
    "preferredOutputReserve": 32768,
    "maxRetrievedHistoryTokens": 16000,
    "maxProjectTokens": 20000
  },
  "retrieval": {
    "exact": true,
    "fts": true,
    "semantic": false,
    "maxResults": 12
  },
  "project": {
    "enabled": true,
    "maxFiles": 10000,
    "maxFileBytes": 512000,
    "maxTotalBytes": 50000000,
    "snippetLines": 80,
    "snippetOverlapLines": 12,
    "maxResults": 8
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

Set `context.mode` to `"observer"` for a pass-through rollback that still records manifests. Unknown or invalid values are ignored with a warning. Project configuration never loads when Pi reports the project as untrusted; project files are likewise neither scanned nor retrieved in that state.

## Architectural invariants

1. Pi JSONL is the canonical session truth.
2. SQLite contains only derived, rebuildable session and project indexes; Pi JSONL and live project files remain canonical.
3. Compaction never deletes raw history.
4. Provider continuation and caches are optional optimizations.
5. Every selected item will carry provenance.
6. Failures are fail-open: Pi continues with its native context.
7. Core policy code does not depend on Pi types; integration stays in `src/pi-adapter` and `src/extension`.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/CONTEXT_PLANNER.md`](docs/CONTEXT_PLANNER.md), [`docs/RETRIEVAL.md`](docs/RETRIEVAL.md), [`docs/PROJECT_KNOWLEDGE.md`](docs/PROJECT_KNOWLEDGE.md), [`docs/COMPACTION.md`](docs/COMPACTION.md), [`docs/SUMMARY_GRAPH.md`](docs/SUMMARY_GRAPH.md), and the original development plan in [`DS4_Context_Engine_Extension_Piano_Sviluppo.md`](DS4_Context_Engine_Extension_Piano_Sviluppo.md).
