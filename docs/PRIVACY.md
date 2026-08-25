# Privacy and Remote Provider Policy

M10 adds an opt-in, provider-aware privacy boundary around the existing managed context. Pi JSONL remains canonical and may retain restricted local content; the policy controls only provider-facing copies, summary-generation input, artifact excerpts, and the final serialized provider payload.

Privacy is disabled by default for backward compatibility.

## Classifications

DS4 recognizes four classifications, ordered from least to most restrictive:

```text
normal < internal < sensitive < local-only
```

`local-only` is a hard ceiling: configuration validation rejects every remote allow rule containing it. A marker cannot downgrade a stricter default or explicit classification.

Content can be marked inline:

```text
\[ds4:internal]team-only context\[/ds4:internal]
\[ds4:sensitive]restricted value\[/ds4:sensitive]
\[ds4:local-only]must remain on this machine\[/ds4:local-only]
```

Remove the example backslashes to activate the markers. A leading marker without a closing tag classifies the remainder of that text. Unbalanced markers split across content blocks conservatively classify the complete message. Markers are control metadata: allowed local/remote copies contain the enclosed text without the tags; disallowed copies contain only a classification placeholder. Prefix a marker's opening bracket with `\` when the syntax itself must remain literal source/documentation.

Persistent pin and memory commands also accept an explicit classification:

```text
/context pin --scope project --classification local-only -- "Private deployment rule"
/context memory add --scope project --classification sensitive --key release-channel -- "Release channel defaults to private."
/context memory supersede MEMORY_ID --classification internal -- "Replacement claim"
```

The classification is part of the canonical Pi custom-entry mutation and survives SQLite deletion, session resume, branch changes, and compaction. Existing unclassified mutations use `privacy.defaultClassification` at selection time.

Automatic sensitivity classification remains disabled. M10 uses explicit markers, explicit pin/memory metadata, and the configured default.

## Provider destination and allow rules

All providers are treated as remote unless their exact, case-insensitive provider ID appears in `localProviders`.

```json
{
  "privacy": {
    "enabled": true,
    "defaultClassification": "normal",
    "localProviders": ["ollama", "llama-cpp", "lmstudio"],
    "remoteDefaultAllowed": ["normal", "internal"],
    "remoteProviders": {
      "openrouter": ["normal"],
      "anthropic": ["normal", "internal"],
      "private-gateway": ["normal", "internal", "sensitive"]
    },
    "redactSecrets": true
  }
}
```

Rules are exact allow lists, not maximum-enum shorthand. `remoteDefaultAllowed` applies to unknown remote providers. Provider-specific rules override it. A provider cannot appear in both `localProviders` and `remoteProviders`. Only mark a provider local when its transport is guaranteed to remain local; a trusted project configuration has the same execution authority as other trusted Pi project resources.

Defaults when privacy is enabled:

```text
known configured local provider -> normal, internal, sensitive, local-only
remote provider override        -> exact configured allow list
other provider                  -> normal, internal
```

The shipped `faux` test provider is in the default local list. Real unknown/custom provider IDs are remote by default.

## Enforcement pipeline

### Context hook

Before artifact condensation, retrieval, or planning, DS4 sanitizes every native `AgentMessage` content field and records a classification without storing its text in diagnostics. Tool call arguments, text/thinking blocks, tool results, and image/binary content participate; protocol identifiers such as role, type, model, tool name, and call ID remain intact.

DS4 separately sanitizes the effective system prompt and active tool descriptions/schema text for token accounting and manifest hashing. The final provider hook applies the same policy to their actual serialized forms.

Historical retrieval, project snippets, pin, and memory supplements are checked independently. A supplement containing a prohibited block is omitted as a whole and receives a metadata-only `excluded due to privacy policy` record. Native turns remain structurally valid: prohibited spans become placeholders so current-user and complete tool-call/result atomic groups survive.

Planner exceptions return the already-sanitized native array. If privacy preparation itself fails, every message content field is replaced with a fail-closed placeholder while protocol identity is preserved. Privacy enforcement therefore does not use the ordinary fail-open rule.

### Compaction and summary graph

Conversation text, custom instructions, and file lists are sanitized before summary generation. Validation runs against the sanitized source. Generated segment/aggregate nodes inherit the highest source classification and persist it as a DS4 marker around the summary. A local model may summarize local-only source, but switching to a remote provider strips that summary before it can be serialized.

Pi's fallback compactor is still covered by the final provider-payload hook.

### Artifact store and search

The local content-addressed object may retain exact restricted bytes because Pi JSONL is canonical and object hashes require exact recovery. Artifact references persist the derived classification in `metadata_json`. Context selection hides prohibited tool results before offload/reference injection. `context_artifact_search` applies the stored artifact classification to every returned excerpt; a remote request receives no matches/content for a prohibited artifact.

### Final provider payload

`before_provider_request` runs after provider-specific serialization. DS4 recursively checks known provider content containers (`system`, `messages`, `input`, `contents`, `context`, tool descriptions/arguments, and related text fields), strips classification markers, removes prohibited blocks, and redacts credential-like values. Structural provider fields remain unchanged.

The handler catches its own failures because Pi 0.84.3 reports extension-hook exceptions and would otherwise continue with the unchanged payload. On an unexpected sanitizer failure DS4 returns an empty object, intentionally causing the provider request to fail rather than leaking content.

Extension handlers execute in load order. A later extension can replace the payload after DS4. For the strongest boundary, load DS4 after every extension that mutates context or provider payloads. DS4 cannot police network traffic created directly by another extension outside Pi's provider pipeline.

## Secret redaction

For remote destinations, `redactSecrets` recognizes common private-key blocks, Bearer tokens, OpenAI/Anthropic-style keys, GitHub tokens, AWS access IDs, and common key/token/password assignments. It is defense in depth, not an automatic data-classification oracle. Local providers retain allowed exact content.

Redaction is performed on provider-facing copies only. Canonical JSONL, local artifact objects, and trusted local SQLite indexes may retain source bytes.

## Manifest and logging contract

Context Manifest items may contain:

- classification;
- source ID/kind and inclusion/exclusion reason;
- counts by selected classification;
- provider ID and local/remote destination;
- allowed classification names;
- blocked/excluded/redacted counts;
- final provider-check/redaction counts;
- enforcement stage.

They never contain classified text, memory claims, pin content, project/retrieval excerpts, provider payloads, or secret values. A provider check updates the pending manifest in place after serialization.

Structured privacy logs contain provider/destination and numeric counters only. On a fail-closed exception DS4 records only the exception type, never its message or payload.

Inspect locally with:

```text
/context privacy
/context manifest
/context included
/context excluded
/context health
```

## Tests and performance

Coverage includes:

- span and prefix classification, no-downgrade, split-marker fail-closed behavior;
- local/remote and provider-specific rules;
- current messages, system prompt, tools, history, project, pins, memory, summaries, and artifacts;
- secret redaction and metadata-only manifests/logs;
- provider switch, planner/preparation failure, final provider-payload recheck, and real Pi faux-provider E2E.

`tests/benchmarks/privacy-policy.bench.ts` sanitizes a 1,000-message provider payload on the development host:

```text
mean 1.75 ms, p99 3.03 ms, max 6.91 ms
```

This is below the initial 50 ms typical context-operation target, not a portable guarantee.
