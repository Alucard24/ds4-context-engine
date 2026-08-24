# DS4 Context Engine Extension for Pi
## Piano di sviluppo completo

**Versione documento:** 1.0  
**Data:** 24 agosto 2026  
**Target:** Pi (`earendil-works/pi`)  
**Tecnologia:** TypeScript / Node.js / SQLite  
**Forma di distribuzione:** Pi Extension + Pi Package  
**Obiettivo:** implementare un Context Engine avanzato, non distruttivo, ispezionabile e indipendente dal provider, capace di costruire dinamicamente il miglior working context possibile per ogni chiamata LLM.

---

# 1. Executive Summary

`DS4 Context Engine Extension` è un'estensione per Pi che sostituisce la gestione passiva del contesto con un motore esplicito di **context planning**.

La sessione completa rimane persistita da Pi nel formato JSONL nativo. L'estensione non distrugge tale cronologia e non prova a sostituire il `SessionManager`.

A ogni chiamata al modello, il Context Engine costruisce invece un **active context** ottimizzato composto da:

- istruzioni stabili;
- elementi pinned;
- stato corrente del task;
- summary gerarchici;
- ultimi turni verbatim;
- vecchi eventi recuperati tramite retrieval;
- file o snippet del progetto realmente pertinenti;
- tool result recenti o sintetizzati;
- messaggio corrente.

La caratteristica principale del sistema è la separazione fra:

```text
FULL SESSION HISTORY
        !=
ACTIVE MODEL CONTEXT
```

Esempio:

```text
Sessione completa locale:        640.000 token equivalenti
Contesto attivo corrente:         68.000 token
Context window del modello:      200.000 token
Output reserve:                   32.000 token
```

La cronologia completa rimane interrogabile e recuperabile. Le compaction non sostituiscono o cancellano i dati originali: producono nuovi artefatti derivati.

Il risultato atteso è un coding agent capace di mantenere sessioni molto lunghe senza dipendere dalla memoria compressa del modello e senza essere vincolato a un provider specifico.

---

# 2. Perché implementarlo come estensione Pi

Pi fornisce già gran parte dell'infrastruttura che servirebbe a un runtime agentico completo:

- multi-provider;
- selezione e cambio modello;
- agent loop;
- tool calling;
- streaming;
- sessioni persistenti;
- session tree e branching;
- compaction;
- branch summarization;
- skills;
- extensions;
- package installation;
- CLI;
- TUI;
- token usage e cost accounting;
- custom provider.

Ricostruire tutte queste funzionalità dentro un nuovo `ds4-hub` aumenterebbe enormemente la superficie del progetto senza aggiungere valore alla parte realmente innovativa.

Pi espone inoltre gli hook necessari:

```text
context
session_before_compact
session_compact
session_before_tree
model_select
before_provider_request
after_provider_response
session_start
session_shutdown
```

Il repository Pi documenta inoltre che le sessioni sono memorizzate come JSONL e formano un albero tramite `id` e `parentId`. Le compaction più recenti possono includere un `retainedTail`, rendendo il checkpoint autosufficiente per la ricostruzione del contesto.

La strategia del progetto è quindi:

```text
Pi
    = Agent Runtime

DS4 Context Engine Extension
    = Context Intelligence Layer
```

---

# 3. Visione del prodotto

Il sistema deve trasformare Pi da:

```text
conversation history
        ↓
default compaction
        ↓
LLM
```

a:

```text
canonical Pi session
        │
        ▼
DS4 Context Engine
        │
        ├── budget
        ├── summary graph
        ├── retrieval
        ├── project knowledge
        ├── pinned state
        ├── recent verbatim tail
        ├── artifact references
        └── context manifest
        │
        ▼
provider-specific active context
        │
        ▼
LLM
```

Il motore deve essere in grado di spiegare perché un'informazione è stata inclusa e perché un'altra è stata esclusa.

---

# 4. Obiettivi

## 4.1 Obiettivi principali

1. Rendere la sessione effettivamente più lunga della context window del modello.
2. Evitare compaction distruttive.
3. Conservare la cronologia originale come fonte di verità.
4. Ridurre token inutili inviati ai provider.
5. Migliorare il recupero di decisioni prese molto tempo prima.
6. Mantenere continuità quando cambia modello.
7. Mantenere continuità quando cambia provider.
8. Rendere il contesto ispezionabile.
9. Rendere la selezione del contesto riproducibile.
10. Ridurre l'impatto dei tool result molto grandi.
11. Conservare provenance e source reference dei summary.
12. Gestire differenze fra modelli piccoli, medi e con context window molto grandi.
13. Permettere utilizzo con modelli online e locali.
14. Restare compatibile con il SessionManager nativo di Pi.

## 4.2 Obiettivi secondari

- memoria di progetto;
- retrieval semantico opzionale;
- controllo privacy prima delle chiamate remote;
- context policies per progetto;
- summary verification;
- metriche di qualità del contesto;
- benchmarking fra strategie;
- supporto opzionale a provider continuation;
- integrazione futura con cache/KV locali.

---

# 5. Non-obiettivi iniziali

L'MVP non deve:

- sostituire Pi;
- sostituire il SessionManager;
- implementare un nuovo agent loop;
- implementare un nuovo tool framework;
- implementare un nuovo package manager;
- sostituire il supporto provider di Pi;
- creare un marketplace;
- controllare direttamente il KV cache remoto;
- rendere il context window infinito;
- utilizzare obbligatoriamente embedding o vector database;
- implementare collaborazione multiutente;
- sincronizzare sessioni nel cloud.

---

# 6. Principi architetturali

## 6.1 Pi JSONL è la fonte canonica

```text
Canonical conversation = Pi session JSONL
```

Il database dell'estensione contiene dati derivati:

```text
SQLite
├── indici
├── summary
├── manifest
├── memory item
├── artifact metadata
└── token calibration
```

Se il database SQLite viene eliminato deve essere possibile ricostruirlo partendo dalla sessione Pi e dal repository.

## 6.2 La compaction non cancella mai la cronologia

Una compaction produce:

```text
summary artifact
```

non:

```text
replacement of raw history
```

## 6.3 Il contesto è una vista temporanea

Il Context Engine deve poter produrre contesti diversi dalla stessa sessione:

```text
Session
├── Context for GPT
├── Context for Claude
├── Context for Gemini
└── Context for local model
```

## 6.4 Lo stato del provider è un'ottimizzazione

```text
Provider state != session truth
```

Eventuali:

- prompt cache;
- `previous_response_id`;
- conversation id;
- provider session id;
- local KV checkpoint;

devono essere considerati fast-path sacrificabili.

## 6.5 Ogni selezione deve avere provenance

Per ogni contenuto introdotto nel prompt deve essere possibile ricostruire:

```text
da dove proviene
quando è stato creato
perché è stato selezionato
quale versione era valida
quanti token costa
```

## 6.6 Il core deve essere portabile

Il codice principale del Context Engine non deve dipendere direttamente dai tipi Pi.

Devono esistere:

```text
core/
pi-adapter/
```

per permettere una futura estrazione del motore.

---

# 7. Architettura generale

```text
┌─────────────────────────────────────────────────┐
│                       Pi                        │
│                                                 │
│  CLI / TUI                                      │
│  Agent Loop                                     │
│  Providers                                      │
│  Models                                         │
│  Tools                                          │
│  Skills                                         │
│  SessionManager                                 │
│  JSONL Session Tree                             │
│  Default Compaction                             │
└──────────────────────┬──────────────────────────┘
                       │ Extension API
                       ▼
┌─────────────────────────────────────────────────┐
│        DS4 Context Engine Extension             │
│                                                 │
│  Extension Adapter                              │
│  Context Planner                                │
│  Token Budget Manager                           │
│  Compaction Engine                              │
│  Summary Graph                                  │
│  Historical Retrieval                          │
│  Project Knowledge Index                        │
│  Memory Manager                                 │
│  Artifact Manager                               │
│  Privacy Filter                                 │
│  Context Manifest                               │
│  Inspector / Commands                           │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│              Local Derived Storage              │
│                                                 │
│  SQLite                                         │
│  SQLite FTS                                     │
│  Artifact Store                                 │
│  Optional Embedding Index                       │
└─────────────────────────────────────────────────┘
```

---

# 8. Flusso di un turno

```text
User message
    │
    ▼
Pi Agent Loop
    │
    ▼
Pi builds base AgentMessage[]
    │
    ▼
"context" hook
    │
    ▼
DS4 Context Planner
    │
    ├── load model profile
    ├── compute budget
    ├── detect current objective
    ├── collect pinned items
    ├── select recent verbatim tail
    ├── load active summaries
    ├── retrieve historical evidence
    ├── retrieve project snippets
    ├── apply privacy policy
    ├── enforce atomic groups
    ├── trim to budget
    └── build manifest
    │
    ▼
Optimized AgentMessage[]
    │
    ▼
Pi provider renderer
    │
    ▼
before_provider_request
    │
    ├── optional provider optimizations
    └── final privacy verification
    │
    ▼
Provider
    │
    ▼
Response / tool call
    │
    ▼
Pi session JSONL
    │
    ▼
Index update
```

---

# 9. Repository proposto

```text
ds4-context-engine/
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE
│
├── src/
│   ├── extension/
│   │   ├── index.ts
│   │   ├── events.ts
│   │   ├── commands.ts
│   │   ├── ui.ts
│   │   └── lifecycle.ts
│   │
│   ├── core/
│   │   ├── context-planner.ts
│   │   ├── context-plan.ts
│   │   ├── budget-manager.ts
│   │   ├── candidate-selector.ts
│   │   ├── atomic-groups.ts
│   │   ├── context-policy.ts
│   │   ├── model-profile.ts
│   │   ├── token-estimator.ts
│   │   └── provenance.ts
│   │
│   ├── compaction/
│   │   ├── compaction-engine.ts
│   │   ├── summary-generator.ts
│   │   ├── summary-validator.ts
│   │   ├── summary-graph.ts
│   │   ├── summary-contract.ts
│   │   └── branch-summary.ts
│   │
│   ├── retrieval/
│   │   ├── historical-retrieval.ts
│   │   ├── fts-retrieval.ts
│   │   ├── exact-retrieval.ts
│   │   ├── semantic-retrieval.ts
│   │   ├── ranking.ts
│   │   └── query-expansion.ts
│   │
│   ├── project/
│   │   ├── project-index.ts
│   │   ├── file-indexer.ts
│   │   ├── symbol-index.ts
│   │   ├── git-state.ts
│   │   ├── snippet-loader.ts
│   │   └── invalidation.ts
│   │
│   ├── memory/
│   │   ├── memory-manager.ts
│   │   ├── memory-item.ts
│   │   ├── contradiction-detector.ts
│   │   └── supersession.ts
│   │
│   ├── artifacts/
│   │   ├── artifact-store.ts
│   │   ├── tool-output-policy.ts
│   │   └── artifact-search.ts
│   │
│   ├── persistence/
│   │   ├── sqlite.ts
│   │   ├── migrations.ts
│   │   ├── repositories/
│   │   └── schema/
│   │
│   ├── manifest/
│   │   ├── context-manifest.ts
│   │   ├── manifest-store.ts
│   │   └── manifest-diff.ts
│   │
│   ├── privacy/
│   │   ├── classifier.ts
│   │   ├── redactor.ts
│   │   └── provider-policy.ts
│   │
│   ├── pi-adapter/
│   │   ├── message-converter.ts
│   │   ├── session-reader.ts
│   │   ├── model-adapter.ts
│   │   ├── compaction-adapter.ts
│   │   └── custom-entry.ts
│   │
│   └── shared/
│       ├── hash.ts
│       ├── ids.ts
│       ├── clock.ts
│       └── logging.ts
│
├── skills/
│   └── context-debugging/
│       └── SKILL.md
│
├── prompts/
│   ├── compact.md
│   ├── validate-summary.md
│   └── extract-memory.md
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── fixtures/
│   ├── golden/
│   └── e2e/
│
└── docs/
    ├── ARCHITECTURE.md
    ├── CONTEXT_POLICY.md
    ├── COMPACTION.md
    ├── RETRIEVAL.md
    ├── STORAGE.md
    ├── PRIVACY.md
    └── ADR/
```

---

# 10. Package Pi

Il progetto deve essere installabile come Pi package.

Esempio concettuale:

```json
{
  "name": "ds4-context-engine",
  "version": "0.1.0",
  "type": "module",
  "dependencies": {
    "@earendil-works/pi-coding-agent": "^CURRENT",
    "better-sqlite3": "^CURRENT"
  }
}
```

Il package deve esporre:

```text
extension
optional skill
optional prompts
```

L'installazione deve poter funzionare tramite i meccanismi supportati da Pi:

```text
pi install <package>
pi install <git repository>
pi install <local path>
```

Non va implementato un package manager parallelo.

---

# 11. Configurazione

File consigliato:

```text
.pi/ds4-context.json
```

Configurazione iniziale:

```json
{
  "enabled": true,

  "context": {
    "targetFillRatio": 0.70,
    "softLimitRatio": 0.80,
    "hardLimitRatio": 0.90,
    "minimumOutputReserve": 8192,
    "preferredOutputReserve": 32768,
    "recentTailTokens": 24000,
    "maxRetrievedHistoryTokens": 16000,
    "maxProjectTokens": 20000,
    "maxSummaryTokens": 12000
  },

  "compaction": {
    "enabled": true,
    "mode": "hierarchical",
    "validate": true,
    "segmentTargetTokens": 30000,
    "preserveRecentVerbatim": true
  },

  "retrieval": {
    "exact": true,
    "fts": true,
    "semantic": false,
    "maxResults": 12
  },

  "artifacts": {
    "enabled": true,
    "maxInlineToolResultChars": 12000,
    "storeLargeOutputs": true
  },

  "privacy": {
    "enabled": false,
    "defaultClassification": "normal"
  },

  "diagnostics": {
    "storeContextManifest": true,
    "storeFullRenderedContext": false,
    "logLevel": "info"
  }
}
```

Il file globale potrà essere:

```text
~/.pi/agent/ds4-context.json
```

con override per progetto.

---

# 12. Modello dati canonico interno

## 12.1 CanonicalMessage

```typescript
export interface CanonicalMessage {
  id: string;
  sourceEntryId?: string;

  role:
    | "system"
    | "user"
    | "assistant"
    | "tool"
    | "custom";

  blocks: CanonicalBlock[];

  createdAt?: number;

  provider?: string;
  model?: string;

  provenance: Provenance;

  tokenEstimate?: number;

  flags: {
    pinned?: boolean;
    atomic?: boolean;
    localOnly?: boolean;
    synthetic?: boolean;
  };
}
```

## 12.2 CanonicalBlock

```typescript
export type CanonicalBlock =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | ToolResultBlock
  | ImageBlock
  | FileReferenceBlock
  | ArtifactReferenceBlock
  | SummaryReferenceBlock
  | OpaqueProviderBlock;
```

L'`OpaqueProviderBlock` permette di conservare informazioni che non devono essere reinterpretate dall'estensione.

---

# 13. Model Profile

Ogni modello deve essere rappresentato mediante un profilo:

```typescript
export interface ModelProfile {
  provider: string;
  modelId: string;

  contextWindow: number;
  maxOutputTokens?: number;

  preferredOutputReserve: number;
  safetyMarginTokens: number;

  supportsImages: boolean;
  supportsTools: boolean;
  supportsThinking: boolean;

  tokenEstimator: string;

  preferredWorkingSetRatio?: number;
}
```

Il profilo deve poter derivare automaticamente i dati dal model registry di Pi e applicare override locali.

---

# 14. Context Budget Manager

## 14.1 Formula

```text
ModelInputHardLimit =
    ContextWindow
    - OutputReserve
    - SafetyMargin
```

Il Context Engine non deve normalmente utilizzare tutto il limite.

```text
PreferredInputTarget =
    ContextWindow * TargetFillRatio
```

Il target effettivo è:

```text
ActiveInputBudget =
    min(
        ModelInputHardLimit,
        PreferredInputTarget
    )
```

Esempio:

```text
Context window:          200.000
Output reserve:           32.000
Safety margin:             4.000
Hard input limit:        164.000

Target fill ratio:          0,70
Preferred target:        140.000

Active input budget:     140.000
```

## 14.2 Budget interno

Il budget viene suddiviso dinamicamente:

```text
System / policies          mandatory
Tool definitions           mandatory
Pinned                     mandatory
Current request            mandatory

Recent tail                priority 100
Task state                 priority 95
Retrieved history          priority 85
Project snippets           priority 80
Hierarchical summaries     priority 75
Older background           priority 40
```

Non devono esserci percentuali rigide; il planner deve adattare le quote al task.

---

# 15. Pipeline del Context Planner

## Fase 1 - Raccolta

Caricare:

- session branch corrente;
- contesto Pi corrente;
- modello corrente;
- system prompt;
- tool disponibili;
- summary attivi;
- memory items;
- project state;
- current request.

## Fase 2 - Individuazione del task corrente

Costruire un `TaskDescriptor`:

```typescript
interface TaskDescriptor {
  objective: string;
  entities: string[];
  symbols: string[];
  files: string[];
  errors: string[];
  technologies: string[];
  keywords: string[];
}
```

## Fase 3 - Candidate generation

Creare candidati provenienti da:

```text
recent messages
summaries
historical events
project files
memory items
tool artifacts
```

## Fase 4 - Ranking

Punteggio iniziale:

```text
score =
    relevance       * 0.30
  + dependency      * 0.20
  + taskContinuity  * 0.20
  + recency         * 0.10
  + authority       * 0.10
  + explicitPin     * 0.10
  - tokenPenalty
```

I pesi devono essere configurabili e successivamente calibrati tramite benchmark.

## Fase 5 - Atomicity

I gruppi atomici vengono inseriti o esclusi per intero.

## Fase 6 - Budget fitting

Ordinare i candidati e riempire il budget.

## Fase 7 - Final validation

Verificare:

- tool call senza result;
- tool result senza call;
- summary senza source;
- contenuto local-only verso provider remoto;
- contesto sopra hard limit;
- current user message presente;
- recent conversation coerente.

## Fase 8 - Manifest

Generare e persistere il `ContextManifest`.

---

# 16. Gruppi atomici

Non devono essere spezzati:

```text
assistant tool call
+ tool result

assistant multi-tool request
+ tutti i relativi tool results

thinking block
+ risposta associata quando richiesto dal provider

approval request
+ approval result

patch proposal
+ patch execution result
```

Definizione:

```typescript
interface AtomicGroup {
  id: string;
  memberIds: string[];
  reason: string;
  estimatedTokens: number;
}
```

---

# 17. Recent Tail

Il motore deve mantenere una coda recente non sintetizzata.

Default consigliato:

```text
24.000 token
```

con adattamento dinamico:

```text
modello 32k   -> 8k-12k
modello 128k  -> 16k-24k
modello 200k  -> 24k-32k
modello 1M    -> non superare automaticamente 64k
```

Il recent tail deve essere costruito rispettando confini di turno e gruppi atomici.

---

# 18. Pinned Context

Gli elementi pinned devono avere priorità massima.

Tipi:

```text
user constraint
architectural decision
project invariant
security rule
active acceptance criterion
current file contract
```

Ogni pin deve avere:

```typescript
interface Pin {
  id: string;
  scope: "session" | "branch" | "project";
  content: string;
  sourceEntryId?: string;
  sourceFile?: string;
  createdAt: number;
  status: "active" | "superseded" | "deleted";
}
```

Comandi:

```text
/context pin
/context unpin
/context pins
```

La creazione automatica dei pin non deve essere abilitata nell'MVP senza conferma o regole molto conservative.

---

# 19. Compaction non distruttiva

## 19.1 Hook principale

Intercettare:

```text
session_before_compact
```

e produrre una compaction custom.

Pi deve continuare a salvare la propria `CompactionEntry`, mentre l'estensione mantiene dati più ricchi nel proprio database.

## 19.2 Trigger

Trigger proattivo:

```text
contextUsage >= softLimit
```

oppure:

```text
predictedNextTurn > availableBudget
```

Overflow effettivo deve essere soltanto una condizione di emergenza.

## 19.3 Segmenti

La cronologia viene divisa in segmenti logici:

```text
Segment A
events 1-42

Segment B
events 43-79

Segment C
events 80-115
```

I segmenti devono rispettare:

- confini di turno;
- tool call;
- transizioni di task;
- cambi modello significativi;
- branch boundaries.

## 19.4 Summary contract

Ogni summary deve includere:

```text
## Objective
## User Constraints
## Durable Decisions
## Completed Work
## Current State
## Files Read
## Files Modified
## Commands / Tests
## Errors / Risks
## Open Questions
## Next Actions
## Critical Exact Values
```

I valori tecnici importanti devono essere preservati verbatim quando necessario:

```text
nomi classe
nomi tabella
nomi colonna
file path
error code
versioni
ID tecnici
comandi
flag
```

## 19.5 Summary Graph

Non sostituire summary vecchi.

```text
Raw Event Range 1
      ↓
Summary S1

Raw Event Range 2
      ↓
Summary S2

S1 + S2
      ↓
Higher Summary H1
```

Struttura:

```typescript
interface SummaryNode {
  id: string;
  kind: "segment" | "aggregate" | "task-state" | "branch";
  sourceEventIds: string[];
  childSummaryIds: string[];
  content: string;
  sourceHash: string;
  createdAt: number;
  model?: string;
  provider?: string;
  validationStatus: "pending" | "valid" | "warning" | "invalid";
}
```

---

# 20. Summary Validation

Dopo la generazione del summary eseguire almeno una validazione deterministica.

Controlli:

1. Tutti i file citati devono comparire nelle source entry.
2. Gli error code citati devono comparire nelle source entry.
3. I comandi citati devono essere verificabili.
4. I valori pinned non devono essere alterati.
5. Nessun fatto dichiarato come completato deve provenire da un'ipotesi.
6. Nessuna decisione rifiutata deve comparire come decisione attiva.
7. I riferimenti devono essere ancora validi.

Fase avanzata:

```text
LLM validator
```

che confronta source + summary.

La validazione LLM deve essere opzionale per evitare costo aggiuntivo e loop.

---

# 21. Historical Retrieval

## 21.1 Obiettivo

Recuperare informazioni originali che non sono presenti nel contesto recente o sono state semplificate dai summary.

Esempio:

```text
Utente:
"come avevamo deciso di gestire LastExportUtc?"
```

Il motore deve poter recuperare il messaggio originale, non soltanto un summary generico.

## 21.2 Ordine dei motori

```text
1. exact identifier matching
2. exact phrase matching
3. SQLite FTS
4. metadata matching
5. semantic retrieval opzionale
```

Per coding e database, la ricerca lessicale deve avere precedenza.

## 21.3 Indicizzazione

Indicizzare:

```text
user message
assistant text
tool name
tool arguments
tool results
file paths
symbols
error messages
SQL object names
command lines
```

## 21.4 Ranking

Punteggio retrieval:

```text
exact identifier     very high
exact phrase         high
same current file    high
same current symbol  high
same branch          medium-high
recent               medium
semantic similarity  medium
```

## 21.5 Evidence block

Il retrieval non deve inserire contenuto anonimo.

Esempio:

```text
[Historical evidence]
Source: session entry 01K...
Date: ...
Reason: exact match "LastExportUtc"

...
```

Questa marcatura aiuta il modello a distinguere contesto recente da materiale recuperato.

---

# 22. Project Knowledge

## 22.1 Non inserire l'intero repository

L'indice deve servire per trovare rapidamente file rilevanti.

## 22.2 File metadata

```typescript
interface IndexedFile {
  path: string;
  hash: string;
  size: number;
  language?: string;
  gitCommit?: string;
  modified: boolean;
  indexedAt: number;
}
```

## 22.3 Symbol index

Nella prima versione può essere euristico:

```text
class
interface
function
method
SQL object
namespace
```

Successivamente può usare parser specifici o tree-sitter.

## 22.4 Invalidation

Se cambia l'hash:

```text
old snippets = stale
```

I risultati vecchi non vanno riutilizzati senza segnalazione.

## 22.5 Git awareness

Conservare:

```text
branch
HEAD commit
working tree dirty
changed files
```

Il Context Manifest deve riportare la revisione del progetto sulla quale è stato creato.

---

# 23. Memory Manager

La memoria deve differire dalla cronologia.

Un memory item rappresenta un fatto durevole:

```typescript
interface MemoryItem {
  id: string;
  scope: "session" | "project";
  claim: string;

  sourceEntryIds: string[];

  createdAt: number;

  status:
    | "active"
    | "superseded"
    | "invalid"
    | "expired";

  supersededBy?: string;
}
```

Esempio:

```text
"Package export mode defaults to PerEndpoint."
```

Se una decisione cambia:

```text
old memory
    status = superseded

new memory
    status = active
```

Non sovrascrivere silenziosamente.

L'estrazione automatica delle memory deve essere conservativa.

---

# 24. Tool Result e Artifact Store

I tool result grandi sono una delle cause principali di crescita inutile del contesto.

## 24.1 Regola

Se:

```text
toolResult.size > inlineThreshold
```

salvare l'output completo nell'Artifact Store.

Contesto:

```text
Command: dotnet test
Exit code: 1
Output size: 8.4 MB
Errors found: 47

Relevant excerpts:
...

Full output:
artifact://sha256/...
```

## 24.2 Artifact layout

```text
~/.pi/agent/ds4-context/
└── artifacts/
    └── ab/
        └── abcdef...
```

## 24.3 Metadata

```text
artifact_id
sha256
mime_type
size
created_at
source_tool_call
source_session
```

## 24.4 Ricerca

Il modello non deve ricevere automaticamente l'intero artifact.

Implementare un tool opzionale:

```text
context_artifact_search
```

oppure usare internamente il retrieval engine.

---

# 25. Context Manifest

Ogni chiamata LLM deve avere un manifest.

```typescript
interface ContextManifest {
  id: string;

  sessionId: string;
  branchLeafId?: string;

  provider: string;
  model: string;

  contextWindow: number;
  outputReserve: number;
  hardInputLimit: number;
  targetInputTokens: number;

  estimatedInputTokens: number;
  actualInputTokens?: number;

  included: ContextManifestItem[];
  excluded: ContextManifestItem[];

  summaryIds: string[];
  retrievedEventIds: string[];
  projectSnippets: ProjectSnippetRef[];

  policyVersion: string;
  plannerVersion: string;

  promptHash?: string;

  createdAt: number;
}
```

## 25.1 Item

```typescript
interface ContextManifestItem {
  kind:
    | "system"
    | "tool"
    | "pin"
    | "recent"
    | "summary"
    | "history"
    | "project"
    | "memory"
    | "current";

  sourceId?: string;
  tokens: number;
  score?: number;
  reason: string;
}
```

---

# 26. Comandi utente

Implementare:

```text
/context
/context status
/context explain
/context tokens
/context included
/context excluded
/context retrieved
/context summaries
/context compact
/context compact preview
/context manifest
/context diff
/context pins
/context pin
/context unpin
/context memory
/context rebuild-index
/context health
```

## 26.1 `/context`

Esempio:

```text
DS4 Context Engine

Session total indexed:        486,220 tokens
Current active context:        71,840 tokens
Model context window:         200,000 tokens
Output reserve:                32,000 tokens

Composition
----------------------------------
System / policies               6,230
Tool definitions                4,120
Pinned state                    5,010
Task summaries                  7,420
Recent verbatim                28,900
Historical retrieval            8,760
Project snippets               11,050
Current request                   350
----------------------------------
Estimated total                71,840
```

## 26.2 `/context explain`

Mostrare:

```text
Why was entry X included?
- exact symbol match: OracleProvider
- referenced in current task
- source newer than conflicting result
- score: 0.92
```

---

# 27. Persistenza SQLite

Percorso consigliato:

```text
~/.pi/agent/ds4-context/context.db
```

oppure database per progetto.

## 27.1 Tabelle principali

```sql
CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    session_file TEXT NOT NULL,
    project_path TEXT,
    indexed_at INTEGER NOT NULL
);

CREATE TABLE entries (
    entry_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    parent_id TEXT,
    entry_type TEXT NOT NULL,
    created_at INTEGER,
    content_hash TEXT NOT NULL,
    searchable_text TEXT,
    FOREIGN KEY(session_id) REFERENCES sessions(session_id)
);

CREATE TABLE summaries (
    summary_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    summary_kind TEXT NOT NULL,
    content TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    validation_status TEXT NOT NULL,
    provider TEXT,
    model TEXT
);

CREATE TABLE summary_sources (
    summary_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    PRIMARY KEY(summary_id, entry_id)
);

CREATE TABLE summary_edges (
    parent_summary_id TEXT NOT NULL,
    child_summary_id TEXT NOT NULL,
    PRIMARY KEY(parent_summary_id, child_summary_id)
);

CREATE TABLE memory_items (
    memory_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    session_id TEXT,
    project_path TEXT,
    claim TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    superseded_by TEXT
);

CREATE TABLE pins (
    pin_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    session_id TEXT,
    project_path TEXT,
    content TEXT NOT NULL,
    source_entry_id TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE context_manifests (
    manifest_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    estimated_tokens INTEGER,
    actual_tokens INTEGER,
    manifest_json TEXT NOT NULL
);

CREATE TABLE artifacts (
    artifact_id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    file_path TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    source_entry_id TEXT
);
```

## 27.2 FTS

Creare indice FTS per `entries.searchable_text`.

---

# 28. Sincronizzazione con Pi Session JSONL

All'avvio sessione:

```text
session_start
    ↓
read session id / file
    ↓
compare last indexed entry
    ↓
incremental index
```

Se il database non esiste:

```text
full rebuild
```

Se il file JSONL cambia:

```text
compare entry IDs + hashes
```

Il database deve poter essere rigenerato completamente.

---

# 29. Integrazione Pi Extension API

## 29.1 Skeleton

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function ds4ContextEngine(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    await runtime.openSession(ctx);
  });

  pi.on("context", async (event, ctx) => {
    return runtime.transformContext(event, ctx);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    return runtime.beforeCompact(event, ctx);
  });

  pi.on("session_compact", async (event, ctx) => {
    await runtime.afterCompact(event, ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    await runtime.modelChanged(event, ctx);
  });

  pi.on("before_provider_request", async (event, ctx) => {
    return runtime.beforeProviderRequest(event, ctx);
  });

  pi.on("after_provider_response", async (event, ctx) => {
    await runtime.afterProviderResponse(event, ctx);
  });

  pi.on("session_shutdown", async () => {
    await runtime.shutdown();
  });
}
```

L'implementazione reale deve essere allineata ai tipi della versione Pi utilizzata.

---

# 30. Hook `context`

È il punto più importante del progetto.

Pseudo implementazione:

```typescript
pi.on("context", async (event, ctx) => {
  const session = await sessionAdapter.snapshot(ctx);

  const task = await taskAnalyzer.analyze({
    session,
    currentMessages: event.messages
  });

  const profile = modelProfiles.resolve(ctx.model);

  const budget = budgetManager.calculate(profile);

  const plan = await planner.plan({
    session,
    task,
    budget,
    baseMessages: event.messages,
    model: profile
  });

  await manifestStore.save(plan.manifest);

  return {
    messages: piAdapter.toAgentMessages(plan.messages)
  };
});
```

Questo hook deve rimanere veloce. Retrieval, indexing e summary generation non devono bloccare ogni turno inutilmente.

---

# 31. Performance Budget

Obiettivo iniziale:

```text
context planning senza LLM:
< 150 ms tipico

retrieval FTS:
< 50 ms

incremental indexing:
< 100 ms per piccolo aggiornamento
```

L'uso di un modello per summary o memory extraction deve avvenire solo durante eventi specifici, non durante ogni `context` hook.

---

# 32. Compaction Hook

Pseudo flusso:

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const segment = compactionAdapter.fromPiPreparation(
    event.preparation
  );

  const summary = await compactionEngine.createSummary({
    segment,
    previousSummary: event.preparation.previousSummary,
    model: selectSummaryModel(ctx)
  });

  const validation = await summaryValidator.validate(summary, segment);

  await summaryGraph.store(summary, validation);

  return {
    compaction: {
      summary: summary.activeText,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
      usage: summary.usage,
      details: {
        ds4ContextEngine: {
          summaryId: summary.id,
          sourceHash: summary.sourceHash,
          validationStatus: validation.status,
          schemaVersion: 1
        }
      }
    }
  };
});
```

---

# 33. Branching e `/tree`

Pi possiede già session tree.

L'estensione deve:

- indicizzare parent/child;
- distinguere branch attivo;
- evitare retrieval indiscriminato da branch alternativi;
- assegnare penalità a eventi appartenenti a rami non correnti;
- permettere retrieval cross-branch quando esplicitamente utile.

`session_before_tree` può essere utilizzato per produrre branch summary compatibili con il Summary Graph.

---

# 34. Cambio modello

Su `model_select`:

1. rilevare nuovo provider;
2. caricare nuovo `ModelProfile`;
3. invalidare budget cached;
4. controllare capacità:
   - images;
   - tools;
   - thinking;
5. modificare quote del Context Planner;
6. non cancellare nessuna memoria;
7. generare il prossimo contesto dal medesimo stato canonico.

Il cambio provider deve quindi essere semanticamente trasparente.

---

# 35. Strategie per provider online

## 35.1 Managed Context - default

```text
Pi JSONL
    ↓
Context Engine
    ↓
selected complete context
    ↓
online provider
```

È la modalità principale.

Vantaggi:

- controllo massimo;
- provider independence;
- context portability;
- privacy;
- retrieval consistente;
- comportamento prevedibile.

## 35.2 Provider Native Continuation - opzionale

Fase avanzata.

Possibili meccanismi:

```text
previous_response_id
conversation_id
provider session IDs
```

Questa modalità richiede maggiore integrazione con provider e non è necessaria per l'MVP.

Regola:

```text
provider continuation = optimization
```

non fonte di verità.

## 35.3 Local KV - futura

Con DS4 locale o altro runtime:

```text
Context Engine
    ↓
initial active prompt
    ↓
local inference engine
    ↓
KV reuse
```

Il KV cache è un'accelerazione dell'inferenza, non la memoria semantica del progetto.

---

# 36. `before_provider_request`

Usarlo soltanto per:

- verifica privacy finale;
- provider-specific optimization;
- eventuali prompt cache hint;
- routing metadata;
- diagnostica;
- future continuation support.

Non usare questo hook come motore principale del context planning: il `context` hook deve rimanere il punto canonico di selezione.

---

# 37. Prompt Caching

Il Context Planner deve facilitare il caching mantenendo stabile l'inizio del prompt:

```text
system instructions
tool definitions
stable pinned project rules
```

e collocando materiale volatile successivamente.

Importante:

```text
prompt caching
    riduce costo / latenza

prompt caching
    NON riduce context occupancy
```

Il planner deve funzionare correttamente anche con cache completamente assente.

---

# 38. Privacy e provider remoti

Classificazioni opzionali:

```text
NORMAL
INTERNAL
SENSITIVE
LOCAL_ONLY
```

Un blocco `LOCAL_ONLY` non deve essere inviato a provider remoti.

Il Context Manifest deve registrare:

```text
excluded due to privacy policy
```

Possibile configurazione:

```json
{
  "privacy": {
    "enabled": true,
    "remoteProviders": {
      "openai": ["NORMAL", "INTERNAL"],
      "anthropic": ["NORMAL", "INTERNAL"],
      "openrouter": ["NORMAL"]
    }
  }
}
```

Le policy vanno mantenute semplici nel primo rilascio.

---

# 39. Token Estimation

Livelli:

1. token usage reale dell'ultima risposta;
2. tokenizer provider specifico, se disponibile;
3. tokenizer compatibile;
4. stima caratteri/token con margine di sicurezza.

Registrare:

```text
estimated vs actual
```

per calibrare automaticamente.

Tabella:

```text
token_calibration
provider
model
estimated
actual
ratio
created_at
```

Il safety margin deve aumentare per modelli con stima poco affidabile.

---

# 40. Context Health

Calcolare indicatori:

```text
Context pressure
Summary depth
Retrieval dependency
Stale snippet count
Unvalidated summary count
Pinned token ratio
Tool-output ratio
Historical coverage
```

Esempio:

```text
/context health

Pressure:             62%  OK
Summary depth:          2  OK
Unvalidated summaries:  0  OK
Stale snippets:         1  WARN
Tool-result share:     31%  WARN
Retrieval coverage:    84%  OK
```

---

# 41. Logging

Usare log strutturati.

Livelli:

```text
error
warn
info
debug
trace
```

Non registrare automaticamente:

- API key;
- Authorization header;
- secret;
- contenuto completo del prompt;
- dati classificati local-only.

Il full rendered context deve essere disabilitato per default.

---

# 42. Telemetria locale

Metriche:

```text
context_build_count
context_build_ms
active_input_tokens
full_session_tokens_estimate
summary_generation_count
summary_tokens
retrieval_hits
retrieval_misses
artifact_offloaded_bytes
context_overflows
provider_cache_read_tokens
provider_cache_write_tokens
model_switch_count
```

Nessuna telemetria esterna nell'MVP.

---

# 43. Strategie di fallback

## SQLite non disponibile

```text
fallback:
Pi default context
```

## Retrieval fallisce

```text
recent + summary + Pi context
```

## Summary generation fallisce

```text
allow Pi default compaction
```

## Summary validator fallisce

```text
mark warning
do not destroy raw source
```

## Context Planner genera overflow

```text
1. drop low-score project snippets
2. drop low-score historical evidence
3. reduce summaries
4. shrink recent tail preserving current turn
5. fallback Pi compaction
```

Il plugin non deve rendere inutilizzabile Pi.

---

# 44. Crash Recovery

Tutte le scritture SQLite importanti devono essere transazionali.

Artifact:

```text
temp write
fsync
rename atomic
```

All'avvio:

- verificare migration;
- verificare orphan artifact;
- verificare manifest incompleti;
- reindicizzare entry mancanti.

---

# 45. Testing Strategy

## 45.1 Unit Test

Copertura:

- budget;
- scoring;
- atomic groups;
- token fitting;
- summary source hash;
- stale file detection;
- memory supersession;
- privacy filter;
- manifest generation.

## 45.2 Integration Test

Con SessionManager fixture:

- session_start;
- context transformation;
- compaction;
- resume;
- branch;
- model change.

## 45.3 Golden Test

Fixture versionate:

```text
tests/golden/
├── long-csharp-session/
├── sql-debug-session/
├── tool-heavy-session/
├── branching-session/
└── provider-switch-session/
```

Per ogni fixture:

```text
input session
expected selected evidence
expected exclusions
expected summary facts
```

Non richiedere necessariamente uguaglianza testuale del summary; verificare fatti e provenance.

## 45.4 End-to-End

Scenari reali Pi:

```text
pi + extension + model
```

---

# 46. Scenari di test critici

## Scenario A - Decisione antica

Turno 12:

```text
LastExportUtc deve essere catturato prima dell'export.
```

Turno 250:

```text
Come avevamo deciso di gestire LastExportUtc?
```

Criterio:

- retrieve evento originale;
- non dipendere esclusivamente dal summary.

## Scenario B - Tool output enorme

```text
dotnet test -> 5 MB output
```

Criterio:

- full output salvato come artifact;
- contesto riceve solo estratto;
- ricerca dell'artifact possibile.

## Scenario C - Cambio provider

```text
Claude -> GPT -> Gemini
```

Criterio:

- vincoli e stato task invariati;
- budget adattato;
- nessuna dipendenza obbligatoria da provider state.

## Scenario D - Branch

Due implementazioni alternative.

Criterio:

- retrieval preferisce branch corrente;
- branch alternativo non contamina automaticamente il contesto.

## Scenario E - Compaction multipla

Sessione superiore a 500k token equivalenti.

Criterio:

- raw JSONL intatto;
- graph summary valido;
- active context sotto target.

## Scenario F - File modificato

Snippet recuperato da `DatabaseManager.cs`, poi file modificato.

Criterio:

- snippet precedente marcato stale;
- nuova versione preferita.

## Scenario G - Plugin failure

SQLite corrotto o non disponibile.

Criterio:

- Pi continua usando fallback.

---

# 47. Benchmark

Creare benchmark con la stessa sessione e lo stesso task:

```text
A. Pi default
B. DS4 Context Engine
```

Misurare:

- input token;
- costo;
- time-to-first-token;
- risposta corretta;
- recupero decisioni;
- tool call necessarie;
- errori dovuti a contesto mancante;
- numero compaction;
- quantità di materiale irrilevante.

Dataset iniziali:

1. sviluppo C# lungo;
2. debugging SQL;
3. refactoring multi-file;
4. sessione con numerosi test/build;
5. cambio provider;
6. branch multipli.

---

# 48. Roadmap

## M0 - Project Skeleton

Implementare:

- repository;
- package Pi;
- TypeScript;
- test runner;
- extension entrypoint;
- config loader;
- logging;
- SQLite bootstrap.

Criterio:

```text
pi loads extension successfully
/context responds
```

## M1 - Session Index

Implementare:

- session_start;
- session ID;
- incremental JSONL indexing;
- FTS;
- content hash;
- `/context rebuild-index`.

Criterio:

```text
resume existing Pi session
index rebuilt correctly
```

## M2 - Context Manifest Baseline

Implementare:

- model profile;
- token budget;
- manifest;
- `/context`;
- `/context tokens`;
- `/context manifest`.

In questa milestone non modificare ancora il contesto.

Criterio:

```text
observer mode
```

mostra esattamente cosa Pi sta mandando.

## M3 - Context Planner v1

Implementare:

- recent tail;
- pinned context;
- deterministic candidate ranking;
- budget fitting;
- atomic groups;
- `context` hook.

Criterio:

```text
managed context active
without custom summaries
```

## M4 - Custom Compaction

Implementare:

- `session_before_compact`;
- summary contract;
- summary storage;
- source hash;
- retained tail;
- `session_compact`;
- fallback default Pi.

Criterio:

```text
session continues beyond first context overflow
```

## M5 - Hierarchical Summary Graph

Implementare:

- segment summaries;
- aggregate summaries;
- validation;
- provenance;
- `/context summaries`.

Criterio:

```text
multiple compactions do not overwrite historical knowledge
```

## M6 - Historical Retrieval

Implementare:

- exact search;
- FTS;
- ranking;
- retrieval blocks;
- `/context retrieved`.

Criterio:

```text
recover old decision not present in current summary
```

## M7 - Project Knowledge

Implementare:

- file index;
- hash;
- Git state;
- snippet retrieval;
- invalidation;
- project token budget.

Criterio:

```text
only relevant current file snippets are injected
```

## M8 - Artifact Store

Implementare:

- large output detection;
- artifact persistence;
- tool-result condensation;
- artifact search.

Criterio:

```text
multi-megabyte tool output no longer dominates context
```

## M9 - Memory and Pins

Implementare:

- persistent pins;
- memory items;
- supersession;
- contradiction detection.

Criterio:

```text
durable decision remains available across compactions
```

## M10 - Privacy and Remote Provider Policy

Implementare:

- classification;
- local-only blocks;
- provider allow rules;
- final check in `before_provider_request`.

Criterio:

```text
local-only content cannot leak into remote request
```

## M11 - Advanced Model Awareness

Implementare:

- model-specific calibration;
- adaptive tail;
- adaptive retrieval;
- provider cache metrics;
- model-switch optimization.

## M12 - Optional Native Continuation

Valutare:

- custom provider Pi;
- OpenAI continuation;
- provider conversation IDs;
- state invalidation;
- fallback managed replay.

Questa milestone è opzionale e non deve bloccare il rilascio principale.

## M13 - Portable Core

Estrarre:

```text
ds4-context-core
```

senza dipendenza Pi.

Adapter:

```text
pi-adapter
```

Questo abilita future integrazioni con altri agent runtime.

---

# 49. Piano dei primi sprint

## Sprint 1 - Foundation

Task:

- [ ] creare package;
- [ ] extension skeleton;
- [ ] `/context`;
- [ ] SQLite;
- [ ] migration system;
- [ ] config global/project;
- [ ] logging;
- [ ] session identification;
- [ ] unit test setup.

Output:

```text
installable extension
```

## Sprint 2 - Observer Mode

Task:

- [ ] read branch entries;
- [ ] CanonicalMessage adapter;
- [ ] model profile;
- [ ] token estimator;
- [ ] manifest;
- [ ] context composition metrics;
- [ ] `/context tokens`;
- [ ] `/context manifest`.

Output:

```text
exact visibility into current context
```

## Sprint 3 - Planner v1

Task:

- [ ] recent-tail selector;
- [ ] atomic tool groups;
- [ ] ranking;
- [ ] budget fitting;
- [ ] context hook;
- [ ] overflow guard;
- [ ] fallback.

Output:

```text
first managed-context version
```

## Sprint 4 - Compaction

Task:

- [ ] custom summary prompt;
- [ ] summary data model;
- [ ] compaction hook;
- [ ] summary provenance;
- [ ] validation deterministic;
- [ ] compact preview.

Output:

```text
non-destructive custom compaction
```

## Sprint 5 - Retrieval

Task:

- [ ] entry FTS;
- [ ] exact identifiers;
- [ ] task descriptor;
- [ ] retrieval ranking;
- [ ] historical evidence injection;
- [ ] retrieval diagnostics.

Output:

```text
old facts can return to context
```

## Sprint 6 - Project Intelligence

Task:

- [ ] file hashes;
- [ ] Git state;
- [ ] source snippets;
- [ ] stale invalidation;
- [ ] project retrieval budget.

## Sprint 7 - Artifacts and Hardening

Task:

- [ ] artifact store;
- [ ] tool-output condensation;
- [ ] crash recovery;
- [ ] database rebuild;
- [ ] profiling;
- [ ] load tests.

---

# 50. MVP

L'MVP deve includere:

- Pi package installabile;
- SQLite index;
- Context Manifest;
- `/context`;
- model-aware budget;
- recent tail;
- atomic groups;
- Context Planner;
- custom compaction;
- non-destructive summary persistence;
- exact + FTS historical retrieval;
- fallback affidabile;
- multi-provider funzionante tramite Pi.

L'MVP può escludere:

- embeddings;
- project symbol parser avanzato;
- privacy classifier automatico;
- provider native continuation;
- local KV integration;
- LLM summary validator;
- portable core.

---

# 51. Definition of Done MVP

L'MVP è completo quando:

- [ ] installabile tramite Pi package;
- [ ] può essere disabilitato senza modificare Pi;
- [ ] non altera il JSONL canonico in modo incompatibile;
- [ ] può ricostruire SQLite da zero;
- [ ] supporta resume di una sessione esistente;
- [ ] supporta session tree;
- [ ] supporta cambio modello;
- [ ] active context non supera hard limit;
- [ ] conserva il current request;
- [ ] conserva tool call/result atomicamente;
- [ ] compaction conserva provenance;
- [ ] raw history non viene eliminata;
- [ ] retrieval recupera una vecchia decisione;
- [ ] `/context` mostra composizione token;
- [ ] ogni elemento recuperato ha una sorgente;
- [ ] in caso di errore Pi continua con fallback;
- [ ] test critici automatizzati passano.

---

# 52. ADR iniziali

## ADR-001 - Pi rimane agent runtime

Decisione:

```text
non creare un nuovo agent runtime
```

## ADR-002 - Pi JSONL è canonical source

SQLite è ricostruibile.

## ADR-003 - Compaction non distruttiva

I summary sono derivati.

## ADR-004 - Context hook come integration point principale

`before_provider_request` è secondario.

## ADR-005 - Retrieval lessicale prima di semantic retrieval

Particolarmente importante per coding.

## ADR-006 - Provider state non canonico

Continuation e cache sono ottimizzazioni.

## ADR-007 - Core separabile dall'adapter Pi

Preparare portabilità futura.

## ADR-008 - Fail-open verso Pi

Se l'estensione fallisce, Pi deve poter continuare.

---

# 53. Rischi

## R1 - Context planner elimina informazioni importanti

Mitigazione:

- recent verbatim tail;
- pins;
- retrieval;
- summary provenance;
- manifest;
- benchmark.

## R2 - Summary hallucination

Mitigazione:

- raw history;
- deterministic validation;
- exact values extraction;
- optional LLM validator.

## R3 - Token estimation imprecisa

Mitigazione:

- safety margin;
- calibration;
- actual token telemetry.

## R4 - SQLite diventa inconsistente

Mitigazione:

- rebuild dal JSONL;
- transaction;
- content hash.

## R5 - Retrieval rumoroso

Mitigazione:

- exact identifiers;
- branch weighting;
- score thresholds;
- token cap.

## R6 - Extension API Pi cambia

Mitigazione:

- Pi adapter isolato;
- pin della versione supportata;
- contract tests.

## R7 - Latenza del planner

Mitigazione:

- no LLM nel normale `context` hook;
- FTS locale;
- cache;
- incremental indexing.

## R8 - Prompt cache ridotta dalla trasformazione dinamica

Mitigazione:

- mantenere prefisso stabile;
- evitare riordinamenti inutili;
- misurare cache read tokens.

## R9 - Branch contamination

Mitigazione:

- branch-aware retrieval;
- alternative branch penalty.

---

# 54. Sicurezza

L'estensione deve trattare come non attendibili:

- file repository;
- tool output;
- testo recuperato;
- artifact;
- summary generati da LLM.

Le istruzioni contenute nel repository non possono automaticamente sovrascrivere policy di sistema.

Il progetto deve inoltre rispettare il trust model di Pi per estensioni e risorse di progetto.

---

# 55. Primo vertical slice da implementare

Prima versione funzionante:

```text
Pi
 ↓
session_start
 ↓
index JSONL
 ↓
context hook
 ↓
budget manager
 ↓
recent tail + current turn
 ↓
context manifest
 ↓
LLM
```

Niente summary custom.  
Niente embeddings.  
Niente project index.

Criterio:

```text
/context
```

deve mostrare esattamente quale contesto è stato costruito.

Successivamente aggiungere:

```text
compaction
    ↓
retrieval
    ↓
project knowledge
```

---

# 56. Sequenza concreta di implementazione

Ordine consigliato:

```text
01. package skeleton
02. config
03. SQLite
04. Pi session adapter
05. canonical message model
06. model profile
07. token budget
08. context manifest
09. /context
10. context planner recent-only
11. atomic groups
12. custom context hook
13. custom compaction
14. summary persistence
15. summary validation
16. historical FTS
17. retrieval injection
18. project file index
19. artifact store
20. memory/pins
21. privacy
22. adaptive model profiles
23. benchmarks
24. optional continuation
25. portable core
```

---

# 57. Criteri per la prima release pubblica

La release `1.0` dovrebbe essere considerata pronta quando:

1. l'estensione viene utilizzata stabilmente su sessioni lunghe;
2. non causa corruzione delle sessioni;
3. non causa overflow evitabili;
4. il database derivato può essere ricostruito;
5. il Context Manifest è affidabile;
6. retrieval e summary mantengono provenance;
7. il fallback è robusto;
8. sono disponibili benchmark Pi default vs DS4 Context Engine;
9. sono documentate versioni Pi compatibili;
10. sono presenti migration del database;
11. sono documentati limiti e privacy;
12. sono disponibili test end-to-end almeno con due provider.

---

# 58. Possibili evoluzioni future

- semantic retrieval locale;
- tree-sitter symbol index;
- cross-session project memory;
- shared project knowledge;
- automatic memory extraction;
- summary consensus;
- specialized cheap model for compaction;
- remote/local routing basato su privacy;
- custom provider con continuation nativa;
- DS4 local KV integration;
- visual context graph;
- web UI per manifest e summary;
- branch comparison;
- context quality score;
- learned ranking;
- automatic context policy tuning;
- supporto ad altri agent runtime tramite `ds4-context-core`.

---

# 59. Identità finale del progetto

Il progetto non deve essere presentato come:

```text
"un plugin che comprime la conversazione"
```

ma come:

> **un context management layer per Pi che separa la memoria completa della sessione dal working context del modello e costruisce dinamicamente, a ogni chiamata, il contesto più utile, verificabile e compatibile con il budget disponibile.**

La compaction è soltanto una delle sue funzioni.

Le componenti fondamentali sono:

```text
Canonical History
+
Context Planning
+
Hierarchical Compaction
+
Historical Retrieval
+
Project Knowledge
+
Provenance
+
Context Manifest
```

---

# 60. Riferimenti tecnici verificati

Documentazione Pi utilizzata come riferimento architetturale:

- Pi repository: https://github.com/earendil-works/pi
- Extensions: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- Compaction: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md
- Session format: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md
- Sessions: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md
- SDK: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md
- Custom compaction example: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/custom-compaction.ts

I nomi e le firme esatte delle API devono essere verificati contro la versione di Pi fissata nel `package.json` al momento dell'implementazione.

---

# 61. Checklist di partenza

Prima del primo commit funzionale:

- [ ] creare repository `ds4-context-engine`;
- [ ] scegliere la versione Pi target;
- [ ] fissare la versione nel package;
- [ ] creare `src/extension/index.ts`;
- [ ] creare `/context`;
- [ ] creare SQLite schema v1;
- [ ] importare una sessione JSONL reale come fixture;
- [ ] creare CanonicalMessage;
- [ ] creare ContextManifest;
- [ ] implementare observer mode;
- [ ] scrivere i primi contract test sugli hook Pi;
- [ ] documentare ADR-001..ADR-008;
- [ ] solo successivamente attivare la modifica reale del contesto.

---

# 62. Risultato atteso

A regime, una sessione dovrebbe poter funzionare così:

```text
Pi Session
630k token equivalenti di storia

        ↓

DS4 Context Engine

Current task:
"Implement OracleProvider"

Relevant state:
- architectural decisions
- 3 summaries
- 7 historical events
- 4 project snippets
- latest tool results
- 22k recent verbatim

        ↓

Active context:
74k token

        ↓

Claude / GPT / Gemini / local model

        ↓

new events appended to Pi

        ↓

history continues indefinitely at session level
while model working set remains controlled
```

Questa è la caratteristica centrale da preservare in ogni scelta implementativa.
