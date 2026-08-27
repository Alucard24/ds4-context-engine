# DS4 Context Engine — Piano di sviluppo del tool LLM per Memory e Persistent Pins

> **Obiettivo:** aggiungere a DS4 Context Engine un tool Pi invocabile dall'LLM per amministrare Persistent Pins e Durable Memory tramite linguaggio naturale, senza indebolire i contratti architetturali, di privacy e di ricostruibilità già stabilizzati.
>
> Repository analizzato: `Alucard24/ds4-context-engine`
>
> Baseline verificata: `main` a `f130115`, release stabile `0.2.0`, Pi `0.84.3`, Node.js `>=22.19.0`
>
> Contratti stabili di partenza: config `ds4-context-config-v1`, SQLite schema `15`, runtime adapter `runtime-adapter-v1`
>
> Target raccomandato: linea `0.3.0`, prima prerelease `0.3.0-alpha.1`
>
> Data verifica: 26 agosto 2026

---

## Indice

1. [Executive summary](#1-executive-summary)
2. [Baseline e stato attuale](#2-baseline-e-stato-attuale)
3. [Decisioni architetturali](#3-decisioni-architetturali)
4. [Obiettivi funzionali](#4-obiettivi-funzionali)
5. [Non-obiettivi e invarianti](#5-non-obiettivi-e-invarianti)
6. [Nome e responsabilità del tool](#6-nome-e-responsabilità-del-tool)
7. [Operazioni supportate](#7-operazioni-supportate)
8. [Semantica conversazionale](#8-semantica-conversazionale)
9. [Schema e contratto del tool](#9-schema-e-contratto-del-tool)
10. [Architettura interna](#10-architettura-interna)
11. [Integrazione con il runtime DS4](#11-integrazione-con-il-runtime-ds4)
12. [Read path: list e find](#12-read-path-list-e-find)
13. [Write path e classi di persistenza](#13-write-path-e-classi-di-persistenza)
14. [Privacy e prevenzione dei leak](#14-privacy-e-prevenzione-dei-leak)
15. [Consenso e autorizzazione locale](#15-consenso-e-autorizzazione-locale)
16. [Ambiguità, exact target e concorrenza](#16-ambiguità-exact-target-e-concorrenza)
17. [Stati operativi, errori e abort](#17-stati-operativi-errori-e-abort)
18. [Logging e diagnostica](#18-logging-e-diagnostica)
19. [Configurazione e limiti](#19-configurazione-e-limiti)
20. [File da creare e modificare](#20-file-da-creare-e-modificare)
21. [Piano di implementazione per milestone](#21-piano-di-implementazione-per-milestone)
22. [Test plan completo](#22-test-plan-completo)
23. [Scenari end-to-end](#23-scenari-end-to-end)
24. [Criteri di accettazione](#24-criteri-di-accettazione)
25. [Compatibilità, schema e versioning](#25-compatibilità-schema-e-versioning)
26. [Documentazione da aggiornare](#26-documentazione-da-aggiornare)
27. [Rollout e release](#27-rollout-e-release)
28. [Evoluzioni future](#28-evoluzioni-future)
29. [Checklist implementativa](#29-checklist-implementativa)
30. [Fonti tecniche verificate](#30-fonti-tecniche-verificate)

---

# 1. Executive summary

DS4 espone già Persistent Pins e Durable Memory tramite `/context` e dispone delle API runtime necessarie:

```text
runtime.listPins()
runtime.createPin()
runtime.unpin()

runtime.listMemories()
runtime.createMemory()
runtime.supersedeMemory()
runtime.setMemoryStatus()

runtime.projectMemorySources()
runtime.setProjectMemorySourceExcluded()
```

Pi supporta tool LLM-callable con `pi.registerTool()`. DS4 registra già `context_artifact_search`; il nuovo tool raccomandato è:

```text
context_persistence
```

L'architettura corretta è un adapter conversazionale Pi-specific sopra `Ds4ContextRuntime`, non un relay di stringhe `/context` e non un accesso diretto a SQLite.

Per Pin e Memory canonici:

```text
utente
  ↓
LLM
  ↓
context_persistence
  ↓
Ds4ContextRuntime
  ↓
pi.appendEntry()
  ↓
ds4-context-pin-v1 / ds4-context-memory-v1
  ↓
Pi JSONL canonico
  ↓
SQLite ricostruibile
```

Per l'esclusione o reinclusione di una source cross-session, il contratto corrente è differente:

```text
context_persistence
  ↓
Ds4ContextRuntime.setProjectMemorySourceExcluded()
  ↓
policy locale derivata in SQLite
```

Questa seconda operazione **non è oggi una mutation Pi JSONL** e non deve essere descritta come tale. La policy resta locale e disposable: eliminando il database si perde, mentre le sessioni Pi JSONL non vengono mai riscritte.

Le correzioni di sicurezza centrali sono:

1. risultati bounded e metadata-only per default;
2. egress guard del tool sempre attiva, anche con `privacy.enabled=false`;
3. sanitizzazione provider-aware anche degli argomenti dei tool call storici, senza riscrivere Pi JSONL;
4. nessun contenuto raw in `details`, errori o log;
5. provenance primaria risolta automaticamente dall'ultimo messaggio utente precedente nel branch attivo, mai fornita arbitrariamente dal modello;
6. operazioni distruttive solo su ID esatto e revisione restituiti da una read precedente;
7. conferma locale per **ogni write** LLM-callable;
8. write rifiutate quando non è disponibile una UI di conferma;
9. outcome distinti tra rifiuto pre-append, commit riuscito, commit con projection pending ed esito indeterminato;
10. `executionMode="sequential"` per impedire ordering nondeterministico tra sibling tool call;
11. neutralità rispetto ai file del progetto e al relativo index refresh;
12. tool unico V1, con misura obbligatoria del costo schema/token come release gate.

Il lavoro appartiene alla linea `0.3.0`; la release stabile `0.2.0` e i suoi contratti non devono essere riaperti.

---

# 2. Baseline e stato attuale

## 2.1 Repository

Baseline verificata:

```text
ds4-context-engine:               0.2.0 stable
commit/tag target:                f130115 / v0.2.0
Pi target:                        0.84.3
Node.js:                          >=22.19.0
configuration contract:          ds4-context-config-v1
SQLite schema:                    15
runtime adapter contract:        runtime-adapter-v1
```

Le migration `1`–`15` sono immutabili. Un'eventuale modifica futura alla projection deve aggiungere una migration successiva, mai riscrivere checksum o contenuto delle migration esistenti.

## 2.2 Extension e command esistenti

La root extension è:

```text
src/extension/index.ts
```

e registra già:

```ts
registerContextCommand(pi, runtime);
pi.registerTool(defineTool({ name: "context_artifact_search", ... }));
```

`src/extension/commands.ts` gestisce:

```text
/context pins
/context pin
/context unpin
/context memory
/context memory list
/context memory add
/context memory supersede
/context memory invalidate
/context memory expire
/context memory sources
/context memory exclude
/context memory include
```

Il nuovo tool deve riusare la stessa business logic di dominio senza tradurre parametri strutturati in stringhe command.

## 2.3 Persistenza canonica

Le mutation di Pin e Memory accettate sono append-only:

```text
ds4-context-pin-v1
ds4-context-memory-v1
```

Nel Pi adapter il percorso termina in `pi.appendEntry()`. Pi JSONL resta canonico; SQLite è una projection locale, unica e condivisa tra sessioni Pi, WAL, coordinata e ricostruibile.

Il reference adapter conserva separatamente il proprio history contract append-only `runtime-history-v1` con record `ds4-runtime-session-v1`. Il tool è Pi-specific e non introduce una seconda implementazione di persistence nel reference adapter; eventuali bump coordinati di package non autorizzano rewrite del suo JSONL.

Le migration e i rebuild non devono modificare:

- Pi JSONL;
- JSONL del reference adapter;
- file del progetto;
- ranking artifacts;
- handle o contenuto Local KV.

## 2.4 Project-memory source exclusion

`setProjectMemorySourceExcluded()` aggiorna oggi una policy derivata tramite il repository SQLite. Non appende `ds4-context-memory-v1` o `ds4-context-pin-v1`.

Decisione V1 di questo piano:

- mantenere l'implementazione corrente;
- documentarla come policy locale e disposable;
- non prometterne il rebuild da JSONL;
- non inventare un nuovo custom entry nel solo adapter tool;
- rinviare un'eventuale canonicalizzazione a un ADR e a un contratto autonomo.

## 2.5 Limiti e opt-in esistenti

I limiti di dominio sono già configurabili:

```text
memory.maxPinChars
memory.maxClaimChars
memory.maxResults
```

Cross-session memory resta opt-in:

```text
memory.crossSession = false   // default
```

Privacy, semantic retrieval, learned ranking e Local KV conservano i propri default e fallback esistenti. Il tool non deve abilitarli implicitamente.

---

# 3. Decisioni architetturali

## 3.1 Adapter diretto al runtime

Decisione:

```text
context_persistence → Ds4ContextRuntime
```

Non usare come percorso principale:

```text
context_persistence
  ↓
pi.sendUserMessage("/context ...")
  ↓
parser command
```

Motivi:

1. parametri strutturati e validabili;
2. nessun escaping shell-like;
3. errori e outcome tipizzati;
4. stessa business logic di `/context`;
5. risultato sincrono;
6. nessuna seconda implementazione di Pin o Memory;
7. nessun accesso diretto a repository o SQLite dal tool.

## 3.2 Tool unico V1

La V1 usa un solo tool `context_persistence` con campo `action`, perché condivide validazione, privacy, conferma e rendering. Questa è la decisione implementativa del piano, non una scelta lasciata al codice.

M0 misura comunque costo schema e qualità di routing. Se uno dei gate fallisce, l'implementazione si ferma prima del freeze: servono ADR e revisione del piano con nuovi nomi/contratti. Non effettuare uno split implicito durante lo sviluppo e non pubblicare una V1 oltre budget.

## 3.3 Due classi di write

Il tool espone due classi esplicite:

### A. Canonical mutation

```text
pin_add
pin_supersede
pin_unpin
memory_add
memory_supersede
memory_invalidate
memory_expire
```

Garanzie:

- append-only Pi JSONL;
- rebuild deterministico;
- SQLite derivato;
- nessuna cancellazione fisica del passato.

### B. Derived local policy update

```text
memory_source_exclude
memory_source_include
```

Garanzie:

- accesso solo tramite runtime/repository coordinato;
- nessuna riscrittura del JSONL sorgente;
- stato locale, disposable e non ricostruibile da JSONL;
- perdita deliberata dopo cancellazione del database.

La documentazione, i result e i test devono distinguere le due classi.

## 3.4 Portable core invariato

Il tool è Pi-specific. `ds4-context-core` non deve acquisire:

- dipendenze runtime da Pi;
- `ExtensionContext`;
- UI Pi;
- `pi.appendEntry()`;
- logica di registrazione tool.

---

# 4. Obiettivi funzionali

L'utente deve poter amministrare esplicitamente lo stato DS4 con linguaggio naturale, senza conoscere `/context`.

Il tool deve permettere di:

1. elencare e trovare Pin;
2. creare Pin session, branch e project;
3. supersedere un Pin tramite target esatto;
4. rimuovere un Pin tramite target esatto;
5. elencare e trovare Memory;
6. creare Memory session e project;
7. supersedere, invalidare o far scadere una Memory tramite target esatto;
8. ispezionare metadata bounded delle source cross-session;
9. escludere o reincludere una source esatta quando cross-session è abilitato;
10. ricevere outcome strutturati, bounded e privacy-safe;
11. mantenere la parità dello stato materializzato con `/context` per le capability comuni.

---

# 5. Non-obiettivi e invarianti

La V1 non deve:

- creare Pin o Memory da conversazione ordinaria senza richiesta esplicita;
- fare harvesting automatico della history;
- interpretare una valutazione del modello come consenso utente;
- sostituire `/context`;
- inviare stringhe `/context` tramite `sendUserMessage()`;
- modificare direttamente SQLite dal tool;
- scrivere direttamente Pi JSONL bypassando `pi.appendEntry()`;
- cambiare `ds4-context-pin-v1` o `ds4-context-memory-v1`;
- cambiare il Context Planner o le priorità di Pin/Memory;
- rendere Memory equivalenti a istruzioni;
- rendere Pin superiori a system/developer instructions;
- abilitare automaticamente `memory.crossSession`;
- introdurre embedding per `find`;
- esporre raw content, claim, query, reason, key, file path o source file nei result;
- accettare `sourceFile` o source entry arbitrarie dal modello;
- persistere mapping handle→stato locale, process secret o revisioni operative come stato DS4; gli opachi `sourceRef`/`targetRevision` restituiti dal tool possono comparire soltanto nel normale tool result Pi JSONL;
- creare un nuovo schema SQLite se non strettamente necessario;
- riaprire la linea stabile `0.2`.

Invarianti assoluti:

```text
Pi JSONL canonical
append-only canonical mutations
SQLite rebuildable/disposable
project files never rewritten
privacy before tool-result egress
Local KV handle/content absent from Pi/reference JSONL, tool result, manifest, SQLite, ranking artifacts and diagnostics
privacy/egress sanitization before KV eligibility or prefix extraction
fail-open for context planning, fail-closed for persistence writes
```

---

# 6. Nome e responsabilità del tool

## 6.1 Nome

```text
context_persistence
```

## 6.2 Label

```text
DS4 Context Persistence
```

## 6.3 Description proposta

```text
Inspect and manage DS4 Persistent Pins and Durable Memory.
Use write actions only after an explicit user request to persist, replace,
remove, invalidate, expire, or change DS4 state. Writes require local user
confirmation. Never create persistent state merely because it seems useful.
```

## 6.4 promptSnippet

```text
Inspect or manage user-confirmed DS4 pins and durable memory
```

## 6.5 promptGuidelines

```text
Use context_persistence only to inspect DS4 persistent state or when the user
explicitly requests a persistence mutation.

Never create a pin or memory merely because information appears useful.

Use pins for confirmed constraints or instructions that must remain prominent.
Use memory for durable facts, decisions, and historical knowledge.

Default new persistence to session scope. Use project or branch scope only when
the user explicitly requests it or the wording unambiguously establishes it.
Durable Memory does not support branch scope.

Before superseding, removing, invalidating, expiring, excluding, or including,
perform a read action and use the returned exact ID/reference and targetRevision.
Never mutate from a fuzzy query or a merely dominant match.

Do not claim that local-only input was protected if a remote model already saw
the user message or tool arguments. Use /context or a local provider for data
that must never be disclosed to a remote provider.
```

Le guideline orientano il modello, ma **non sono un controllo di autorizzazione**. L'enforcement delle write avviene localmente come descritto nella sezione 15.

---

# 7. Operazioni supportate

## 7.1 Read-only

```text
pins_list
pins_find
memory_list
memory_find
memory_sources
```

## 7.2 Canonical writes

```text
pin_add
pin_supersede
pin_unpin
memory_add
memory_supersede
memory_invalidate
memory_expire
```

## 7.3 Derived local policy writes

```text
memory_source_exclude
memory_source_include
```

Contratto V1: quattordici action.

`pin_supersede` è un'action esplicita anziché un `pin_add` con parametro nascosto `supersedes`. Questo riduce l'ambiguità, permette una conferma UI corretta e rende chiara la natura distruttiva dell'operazione.

---

# 8. Semantica conversazionale

## 8.1 Creazione Pin

Utente:

```text
Fissa per tutto il progetto che dobbiamo restare compatibili con SQL Server 2012.
```

Tool call proposta:

```json
{
  "action": "pin_add",
  "scope": "project",
  "content": "Maintain compatibility with SQL Server 2012."
}
```

Il tool mostra una conferma locale. Solo dopo conferma chiama `runtime.createPin()`.

## 8.2 Creazione Memory

Utente:

```text
Ricordati per questo progetto che il default dell'export è PerEndpoint.
```

```json
{
  "action": "memory_add",
  "scope": "project",
  "key": "package-export-mode",
  "content": "Package export mode defaults to PerEndpoint."
}
```

La conferma locale può mostrare il contenuto completo perché resta nella UI locale; il tool result inviabile al modello non lo ecoa.

## 8.3 Scope omesso

```json
{
  "action": "memory_add",
  "content": "The current test uses the staging database."
}
```

Il tool applica:

```text
scope = session
```

Non delegare il default al modello e non promuovere implicitamente a project.

## 8.4 Rimozione Pin per descrizione

Primo call:

```json
{
  "action": "pins_find",
  "query": "Node.js 22"
}
```

Result operativo:

```json
{
  "id": "pin_abc123",
  "targetRevision": "rev_...",
  "scope": "project",
  "status": "active",
  "matchKind": "all-terms"
}
```

Secondo call, separato:

```json
{
  "action": "pin_unpin",
  "id": "pin_abc123",
  "targetRevision": "rev_...",
  "reason": "User requested removal."
}
```

Il tool verifica revisione e stato, poi chiede conferma locale. Nessuna action distruttiva accetta `query` al posto di `id`.

## 8.5 Supersede Memory

```text
memory_find
  ↓
exact id + targetRevision
  ↓
memory_supersede
  ↓
local confirmation
  ↓
canonical append
```

Esempio:

```json
{
  "action": "memory_supersede",
  "id": "memory_old_id",
  "targetRevision": "rev_...",
  "content": "Package export mode defaults to SingleFile."
}
```

## 8.6 Invalidazione ed expiration

`memory_invalidate` e `memory_expire` richiedono sempre:

```text
id
targetRevision
```

`reason` è opzionale, bounded, non viene ecoato né loggato.

## 8.7 Source exclusion

`memory_sources` restituisce un `sourceRef` opaco e process-local, non `sessionFile` o project path.

```json
{
  "sourceRef": "source_...",
  "targetRevision": "rev_...",
  "status": "ready",
  "indexedMutations": 4
}
```

L'action successiva usa `id=sourceRef`. Il riferimento:

- si risolve solo localmente;
- la sua mapping verso `sessionId` non è persistita; la stringa opaca può restare nel normale tool result Pi JSONL;
- scade per TTL/eviction e sempre al restart;
- non rende canonica la policy di esclusione.

---

# 9. Schema e contratto del tool

Identificatori V1:

```text
tool contract:   ds4-context-persistence-tool-v1
result contract: ds4-context-persistence-result-v1
```

Il primo identifica nome, action, parametri, modalità di esecuzione e comportamento di autorizzazione; il secondo identifica esclusivamente l'envelope e i DTO restituiti. Possono evolvere indipendentemente. La V1 di questo piano resta il tool unico `context_persistence`; un eventuale split richiede prima un ADR e nuovi identificatori.

La registrazione V1 del tool unico deve dichiarare:

```ts
executionMode: "sequential"
```

Pi può eseguire sibling tool call in parallelo per default. La modalità sequenziale è quindi parte del contratto operativo: ordina le mutation della stessa risposta del modello, ma non sostituisce `SqliteWriteCoordinator`, revision check o i controlli cross-process.

## 9.1 Schema compatto

Per ridurre il costo nella tool definition, usare un oggetto compatto con campi opzionali e validazione action-specific. Impostare `additionalProperties: false`.

Esempio concettuale:

```ts
import { StringEnum, Type } from "@earendil-works/pi-ai";

const CONTEXT_PERSISTENCE_PARAMS = Type.Object({
  action: StringEnum([
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
  ] as const),

  scope: Type.Optional(StringEnum(["session", "branch", "project"] as const)),
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  targetRevision: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  content: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
  key: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  query: Type.Optional(Type.String({ minLength: 2, maxLength: 200 })),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  classification: Type.Optional(StringEnum([
    "normal", "internal", "sensitive", "local-only",
  ] as const)),
  activeOnly: Type.Optional(Type.Boolean()),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });
```

Usare `StringEnum` per tutti gli enum stringa, non `Type.Union` di `Type.Literal`, per la compatibilità degli schema con provider Google-like e in coerenza con le API Pi correnti.

## 9.2 Campi intenzionalmente esclusi

La V1 non espone:

```text
sourceFile
sourceEntryId
sourceEntryIds
supersedes
projectPath
sessionFile
includeRaw
```

Motivazioni:

- un path fornito dal modello non è provenance verificata;
- un entry ID arbitrario, anche se esistente, può descrivere una relazione semantica falsa;
- `supersedes` è sostituito da action esplicite;
- raw output e path non devono entrare nella conversazione del provider.

La mutation conserva comunque provenance strutturale generata dal runtime: session identity, mutation entry e branch leaf quando applicabile.

## 9.3 Validazione action-specific

Aggiungere:

```ts
validateContextPersistenceParams(params, runtimeState)
```

La funzione deve:

- rifiutare campi non pertinenti all'action;
- applicare default solo dove documentato;
- verificare stato e capability prima della UI;
- lasciare al runtime i limiti configurabili di dominio;
- non duplicare business logic di conflitto, scope o trust.

Matrice minima:

| Action | Richiesti | Opzionali |
|---|---|---|
| `pins_list` | — | `activeOnly`, `maxResults` |
| `pins_find` | `query` | `activeOnly`, `maxResults` |
| `pin_add` | `content` | `scope`, `classification` |
| `pin_supersede` | `id`, `targetRevision`, `content` | `classification` |
| `pin_unpin` | `id`, `targetRevision` | `reason` |
| `memory_list` | — | `activeOnly`, `maxResults` |
| `memory_find` | `query` | `activeOnly`, `maxResults` |
| `memory_add` | `content` | `scope`, `key`, `classification` |
| `memory_supersede` | `id`, `targetRevision`, `content` | `classification` |
| `memory_invalidate` | `id`, `targetRevision` | `reason` |
| `memory_expire` | `id`, `targetRevision` | `reason` |
| `memory_sources` | — | `maxResults` |
| `memory_source_exclude` | `id`, `targetRevision` | `reason` |
| `memory_source_include` | `id`, `targetRevision` | — |

`memory_add(scope=branch)` deve essere rifiutata. `scope` omesso per add significa `session`.

La classificazione effettiva usata per egress, UI e DTO è:

```text
effectiveClassification = storedClassification ?? privacy.defaultClassification
```

Per `pin_supersede` e `memory_supersede`, `classification` omessa conserva il valore canonico del target, inclusa l'assenza del campo, salvo auto-elevazione dovuta a marker/secret detection. Una classificazione esplicita può soltanto mantenere o rendere più restrittiva la classificazione **effettiva** secondo l'ordine:

```text
normal < internal < sensitive < local-only
```

Un tentativo di downgrade viene rifiutato con `invalid-classification`. `pin_unpin`, `memory_invalidate` e `memory_expire` usano la classificazione effettiva del target per UI, historical-argument egress e diagnostica, anche se la status mutation non duplica il campo nel payload canonico. Per gli add con classificazione omessa, il campo canonico può restare assente se non emerge un floor più restrittivo; ogni decisione di policy usa comunque il default effettivo corrente.

## 9.4 Limiti statici e dinamici

Lo schema applica soltanto hard ceiling di trasporto compatibili con i massimi ammessi dal config loader.

Il runtime resta source of truth per:

```text
memory.maxPinChars
memory.maxClaimChars
memory.maxResults
context.maxPinnedTokens
project trust
active branch provenance
```

Per le read:

```text
effectiveMaxResults = min(requested ?? memory.maxResults, memory.maxResults)
```

Non fissare nel tool un limite content/claim più basso che renda non utilizzabile una configurazione valida. Gli ID emessi dal runtime devono essere ASCII opachi lunghi al massimo 128 caratteri; `targetRevision` e `sourceRef` al massimo 64. Un item proiettato con identificatori fuori contratto viene omesso con diagnostica safe, mai troncato in un ID ambiguo.

Budget hard del result serializzato:

```text
content text totale UTF-8 <= 96 KiB
details JSON UTF-8       <= 64 KiB
items                    <= 100
```

Il builder misura l'output finale e fail-closed con `unavailable/result-budget-exceeded` se un'invariante teoricamente impossibile supera questi ceiling; non taglia JSON o identificatori.

## 9.5 Result schema

Tutti i result usano `ds4-context-persistence-result-v1`.

Campi comuni obbligatori in `details`:

```text
schema
action
outcome
persistenceClass
```

Outcome previsti:

```text
ok
rejected
cancelled
unavailable
committed
committed_projection_pending
indeterminate
```

Per una read con `outcome=ok`:

```json
{
  "schema": "ds4-context-persistence-result-v1",
  "action": "memory_find",
  "outcome": "ok",
  "persistenceClass": "read-only",
  "count": 0,
  "truncated": false,
  "incomplete": false,
  "items": []
}
```

Semantica esatta:

- `count === items.length`;
- `truncated=true` solo se, tra i match effettivamente valutati dopo filtri e ordering, esiste almeno un elemento oltre `effectiveMaxResults`;
- `incomplete=true` solo per un find la cui scansione candidata raggiunge il ceiling operativo prima della fine del corpus oppure incontra un body legacy oltre 20.000 code unit che non può valutare integralmente; per list/source vale sempre `false`;
- implementare la verifica dei result leggendo al massimo `effectiveMaxResults + 1` match dal set valutato;
- `totalCount` non appartiene alla V1: evita scansioni aggiuntive e numeri non confrontabili tra projection concorrenti;
- `createdAt` e `updatedAt`, quando presenti, sono integer Unix epoch milliseconds, mai stringhe locale-dependent.

Enum e DTO metadata-only:

```text
persistenceClass = read-only | canonical-jsonl | derived-local-policy
kind             = pin | memory | project-memory-source
previewStatus    = included | omitted-by-policy
```

| Read | Campi item ammessi |
|---|---|
| `pins_list` | `id`, `kind`, `scope`, `status`, `classification`, `applicableToActiveBranch`, `createdAt`, `updatedAt`, `targetRevision` |
| `memory_list` | `id`, `kind`, `scope`, `status`, `classification`, `createdAt`, `updatedAt`, `targetRevision` |
| `pins_find`, `memory_find` | rispettivi campi list + `matchKind`, `score`, `previewStatus` |
| `memory_sources` | `sourceRef`, `kind`, `targetRevision`, `status`, `indexedMutations`, `activeProjectMemories`, `activeProjectPins`, `hasMalformedLines`, eventuale `errorCode` safe |

Status ammessi:

```text
Pin:     active | superseded | deleted
Memory:  active | superseded | invalid | expired
Source:  ready | missing | corrupt | excluded
```

Tutti i campi elencati nella riga DTO sono obbligatori per ogni item di quella action, salvo `errorCode`, presente soltanto come `source-missing`, `source-corrupt` o `source-malformed` quando applicabile. Non emettere proprietà `undefined` o `null`. `classification` è sempre il valore effettivo, anche quando il campo canonico era assente. `applicableToActiveBranch` è distinto da `status`: un Pin branch può essere lifecycle-active ma non applicabile al branch corrente.

Pi invia al modello soltanto `content`; `details` è metadata per UI/log e non entra nel provider payload. Di conseguenza ogni read deve rendere in `content[].text` anche una riga metadata-only deterministica per item, contenente esclusivamente i campi allowlisted del relativo DTO (ID/ref, scope/status/classification, timestamp, revisione e metadata di match/source). Senza questa riga il modello non potrebbe usare l'exact ID e la revisione in una tool call separata. La duplicazione limitata di questi metadata è quindi intenzionale e coperta da golden test; claim, Pin content, key, path e reason non vengono mai duplicati.

La preview sanitizzata dei soli find compare una sola volta in `content[].text`, nel formato bounded `<kind> <opaque-id>: <preview>`; non viene duplicata in `details.items`. Se è soppressa, il testo contiene solo ID e `preview omitted by policy`, mentre l'item usa `previewStatus=omitted-by-policy`.

Per una write, `details` non usa `items`, `count`, `truncated` o `incomplete`. Può contenere soltanto:

```text
id o sourceRef
kind
scope
status
classification
targetRevision
duplicate
errorCode safe
```

Shape per outcome:

- canonical `committed`: `id`, `kind`, `scope`, `status`, classificazione effettiva e revisione post-operazione obbligatori;
- derived-policy `committed`: `sourceRef`, `kind=project-memory-source`, `status` e revisione post-operazione obbligatori;
- duplicate/idempotent `ok`: stessa shape materializzata più `duplicate=true` solo per add duplicate;
- `rejected`, `cancelled`, `unavailable`: solo campi comuni ed eventuale `errorCode` safe;
- `committed_projection_pending`: eventuali `id`, `kind`, `scope` noti e `errorCode=committed-projection-pending`, mai revisione;
- `indeterminate`: eventuale `id` solo se già noto e `errorCode=append-indeterminate`, mai revisione o stato affermato.

Un add duplicate senza nuovo append usa `outcome=ok`, `duplicate=true`, l'ID esistente e la sua revisione corrente. Una source policy già nello stato richiesto usa `outcome=ok` senza fingere una mutation canonica. Una canonical o derived write realmente riuscita usa `outcome=committed` con il `persistenceClass` appropriato. Quando la materializzazione è disponibile, `targetRevision` è quella **post-operazione**; va omessa per `committed_projection_pending` e `indeterminate`, perché lo stato locale potrebbe essere stale o ignoto. Gli outcome non riusciti includono soltanto `errorCode` e metadata necessari a decidere se una nuova read sia richiesta.

`content[].text` usa template V1 fissi, senza JSON duplicato:

```text
read list/source: <action>: <count> item(s); truncated=<bool>; incomplete=<bool>.
find summary:     <action>: <count> match(es); truncated=<bool>; incomplete=<bool>.
metadata item:    <kind> <opaque-id/ref>; <allowlisted-key>=<safe-value>; ...
find preview:     <kind> <opaque-id>: <sanitized-preview | preview omitted by policy>
canonical commit: Committed <kind> <opaque-id>.
derived commit:   Updated derived local policy for <opaque-sourceRef>.
duplicate:        Existing <kind> <opaque-id>; no mutation appended.
pending:          Canonical mutation committed; projection pending. Do not retry automatically.
indeterminate:    Append outcome indeterminate. Inspect state before retrying.
other failure:    <action> <outcome>: <safe-error-code>.
```

`cancelled` senza error code usa `<action> cancelled.`. I summary e le righe item sono rendering metadata-only coerenti con `details`: non costituiscono un secondo DTO con campi diversi e non possono aggiungere campi non allowlisted. Envelope, template e ogni DTO action-specific devono avere golden test prima della prerelease.

## 9.6 Budget della tool definition

Prima di congelare il contratto:

1. serializzare la definizione effettivamente inviata ai provider supportati;
2. misurare byte e token stimati con fixture riproducibili;
3. misurare il delta per request con tool attivo;
4. verificare il routing su scenari positivi e negativi;
5. registrare byte/token e routing del tool unico come evidenza del release gate.

Gate raccomandato:

```text
incremento <= 1.500 input token stimati per request
AND
incremento <= 1% della più piccola context window supportata/testata
```

Se uno dei due limiti viene superato, M0 è bloccato: non implementare o pubblicare il contratto V1 finché un ADR e una revisione del piano non definiscono l'alternativa.

---

# 10. Architettura interna

Struttura raccomandata:

```text
src/extension/
├── index.ts
├── commands.ts
├── runtime.ts
├── context-persistence-contract.ts      NEW
├── context-persistence-tool.ts          NEW
└── context-persistence-result.ts        NEW se necessario
```

## 10.1 Contract module

Responsabilità:

- action enum;
- TypeBox schema;
- action-specific validation;
- result schema/types;
- allowlist dei metadata;
- nessuna dipendenza da repository.

## 10.2 Tool module

Responsabilità:

- `pi.registerTool()` con contratto `ds4-context-persistence-tool-v1`;
- `executionMode: "sequential"`;
- state/capability check;
- read dispatch;
- exact-target revision check;
- conferma UI;
- write dispatch;
- abort handling;
- privacy-safe rendering.

## 10.3 Volatile operational state

Il tool può mantenere in memoria soltanto:

- `sourceRef` process-local;
- revisioni/selection metadata;
- timestamp bounded per expiry;
- nessun raw content.

Questo stato:

- non è canonico;
- non viene scritto in JSONL; soltanto i token opachi già restituiti possono essere serializzati da Pi come normale tool result, senza mapping o secret;
- non entra in SQLite;
- non entra nei manifest;
- non entra nei ranking artifacts;
- viene perso al restart;
- è limitato dimensionalmente e temporalmente.

## 10.4 Runtime

Il tool importa solo `Ds4ContextRuntime` e tipi adapter-level. Non importa:

```text
MemoryManager
MemoryRepository
ProjectMemorySynchronizer
SqliteWriteCoordinator
SQLite repositories
```

Aggiungere a `Ds4ContextRuntime` API tipizzate adapter-facing, invece di ricostruire logica nel tool:

```text
listPinsPage / listMemoriesPage / projectMemorySourcesPage
findPinsBounded / findMemoriesBounded
resolveVisiblePin / resolveVisibleMemory / resolveVisibleSource
resolveToolProvenance
```

Le page API usano query ordinate e keyset cursor volatile dentro una read transaction SQLite coerente; non usano `OFFSET`, non restituiscono path e non cambiano le API pubbliche esistenti. Il find runtime applica normalizzazione, score, exact-ID fast path, page size e scan cap definiti nella sezione 12. Il tool si limita a dispatch, egress e authorization.

Se servono primitive interne di page/read, aggiungerle in modo additivo a `MemoryManager`/`MemoryRepository`, senza spostare dipendenze Pi nel core portabile e senza duplicare business logic già esposta dal runtime.

## 10.5 Neutralità rispetto ai file del progetto

`context_persistence` è project-file-neutral:

- non crea, modifica o elimina file del progetto;
- non riscrive Pi JSONL, reference-adapter JSONL o file live durante rebuild e migration;
- non deve attivare un refresh del project file index dopo `tool_execution_end`;
- le write SQLite della source policy non sono file mutation del progetto.

Il registration/runtime adapter deve quindi classificare esplicitamente il tool come neutrale, oppure escluderne il nome dal percorso `runtime.projectMayHaveChanged()`. Un test verifica che ogni action lasci invariati file-index generation, scan count e project knowledge refresh state.

---

# 11. Integrazione con il runtime DS4

## 11.1 Provenance primaria per add/supersede

Prima della conferma, l'adapter ottiene una sola volta `ctx.sessionManager.getBranch()` e risolve l'ultimo entry `message` con ruolo utente che precede l'assistant tool call corrente:

```ts
const provenance = runtime.resolveToolProvenance(ctx, toolCallId);
const primarySourceEntryId = provenance.primarySourceEntryId;
```

Il nome è concettuale: l'helper resta Pi-specific. Se nello snapshot esiste un assistant entry contenente `toolCallId`, la scan si ferma prima di quell'entry; se il call corrente non è ancora materializzato nella branch, parte dalla leaf corrente. Il result interno include soltanto `primarySourceEntryId`, session identity, branch entry-ID revision e active leaf, mai testo utente.

Immediatamente dopo la conferma e prima del dispatch, l'adapter acquisisce un nuovo snapshot e verifica stessa session identity, stessa branch revision e presenza della primary source. Qualunque divergenza produce `provenance-unavailable`; non usa `[]`, path o ID inventati come fallback. Sibling calls sono sequenziali e ciascuno acquisisce il proprio snapshot dopo il completamento del precedente.

## 11.2 Pin add

```ts
runtime.createPin(
  { content, scope, classification, sourceEntryId: primarySourceEntryId },
  ctx,
  appender,
);
```

Dove:

```ts
const appender = (customType, data) => pi.appendEntry(customType, data);
```

## 11.3 Pin supersede

```ts
runtime.createPin(
  {
    content,
    scope: existing.scope,
    supersedes: existing.id,
    classification: nextStoredClassification,
    sourceEntryId: primarySourceEntryId,
  },
  ctx,
  appender,
);
```

Il tool ricava scope, classificazione canonica e classificazione effettiva dal target corrente; il modello non può cambiare scope o ridurre la protezione durante il supersede. `nextStoredClassification` è la più restrittiva tra classificazione esplicita, valore canonico del target ed eventuale floor marker/secret; non forza nel JSONL il solo default di config se target e request erano assenti e non emerge alcun floor.

## 11.4 Unpin

```ts
runtime.unpin(id, reason, ctx, appender);
```

La policy di egress del `reason` usa la classificazione del Pin target e non lo ecoa nel result.

## 11.5 Memory add

```ts
runtime.createMemory(
  {
    claim: content,
    scope,
    key,
    classification,
    sourceEntryIds: [primarySourceEntryId],
  },
  ctx,
  appender,
);
```

## 11.6 Memory supersede

```ts
runtime.supersedeMemory(
  id,
  content,
  [primarySourceEntryId],
  nextStoredClassification,
  ctx,
  appender,
);
```

## 11.7 Memory status

```ts
runtime.setMemoryStatus(id, "invalid", reason, ctx, appender);
runtime.setMemoryStatus(id, "expired", reason, ctx, appender);
```

La policy di egress del `reason` usa la classificazione della Memory target.

## 11.8 Project source policy

```ts
runtime.setProjectMemorySourceExcluded(sessionId, true, reason);
runtime.setProjectMemorySourceExcluded(sessionId, false);
```

Il tool risolve `sourceRef` → `sessionId` localmente. Il result dichiara:

```text
persistenceClass = derived-local-policy
```

Non dichiarare `canonical=true` e non chiamare `pi.appendEntry()` artificialmente.

## 11.9 Outcome post-append

Le API runtime attuali possono fallire dopo che `pi.appendEntry()` è già riuscita, durante sync o materializzazione. Ogni canonical execute crea un `TrackedCanonicalAppender` locale con state machine:

```text
not-invoked
  ↓ prima della call
invoking
  ↓ appendEntry ritorna
committed
  ↓ runtime ritorna item materializzato
materialized
```

Regole di mapping:

- runtime throw con state `not-invoked` → pre-append `rejected` o `unavailable` secondo il safe code;
- `pi.appendEntry()` throw con state `invoking` → `indeterminate`, perché il void API non prova che nessun byte sia stato scritto;
- runtime throw con state `committed` → `committed_projection_pending`;
- runtime return con state `materialized` → `committed`;
- duplicate return senza invocazione → `ok/duplicate=true`;
- seconda invocazione dell'appender o custom type diverso dai due canonici → invariant failure; se il primo append era committed, non degradare mai l'outcome sotto `committed_projection_pending`.

Il tracker osserva dal payload soltanto custom type, operation e ID opaco per costruire l'outcome; non conserva payload o raw content dopo `execute`. L'errore adapter-level tipizzato contiene esclusivamente:

```text
commitState
itemId se noto
mutationType
safe errorCode
```

Le source-policy write non usano il tracker: la transaction SQLite coordinata è considerata riuscita solo al return. Un throw produce `unavailable` e richiede una nuova `memory_sources` prima di un eventuale retry idempotente. Nessun outcome include payload mutation o raw content.

---

# 12. Read path: list e find

## 12.1 Principio

I command `/context` mostrano dati nella UI locale. Un tool result può entrare nella richiesta successiva al provider. Le due superfici non devono condividere automaticamente lo stesso rendering.

## 12.2 Ordering deterministico

`memory_list` ordina per:

```text
status active prima
updatedAt decrescente
id ASCII crescente come tie-break finale
```

`pins_list` inserisce dopo lo status:

```text
applicableToActiveBranch=true prima
```

`find` ordina per:

```text
score decrescente
status active prima
per i Pin: applicableToActiveBranch=true prima
updatedAt decrescente
id ASCII crescente
```

`memory_sources` ordina sui dati locali non esposti:

```text
indexedAt decrescente
sessionId ASCII crescente come tie-break finale
```

Nessun ordinamento dipende dall'ordine non garantito di SQLite, dal `sourceRef` casuale o dalla locale di sistema.

## 12.3 List result

Per default `activeOnly=true`.

Dopo filtri e ordering, list/source chiedono al runtime una pagina SQL già ordinata di `effectiveMaxResults + 1` elementi, restituiscono i primi `effectiveMaxResults`, impostano `truncated` in base all'elemento extra e `incomplete=false`. `count` è sempre la lunghezza di `items`; la V1 non espone `totalCount`.

Metadata ammessi per Pin/Memory, presenti nel DTO `details.items` e resi anche come righe metadata-only in `content` perché Pi non invia `details` al modello:

```text
id
kind
scope
status
classification effettiva
applicableToActiveBranch boolean, solo Pin
createdAt/updatedAt come Unix epoch milliseconds
targetRevision
```

`activeOnly=true` filtra lo status lifecycle. Non elimina un Pin branch lifecycle-active solo perché non è applicabile al branch corrente: il DTO lo distingue con `applicableToActiveBranch=false` e il planner continua a usare la propria verifica di ancestry.

Esclusi per default:

```text
content
claim
key
statusReason
sourceFile
sourceEntryIds
projectPath
sessionFile
```

## 12.4 Find locale

Il matching è locale, deterministico e bounded. Non usare embedding nella V1.

Normalizzazione unica per query, key e testo candidato:

```text
Unicode NFKC
trim + collapse di whitespace Unicode
toLocaleLowerCase("en-US")
tokenizzazione deterministica su lettere e numeri Unicode
```

Non usare la locale di sistema. La query normalizzata serve solo durante l'execute: non viene inclusa in result, log, sourceRef/revision o nuovo stato persistente.

Lo score usa un solo tier base, scelto per precedenza, più l'eventuale bonus lifecycle-active:

```text
exact opaque id match          120  → metadata-only
exact normalized key match     100  → exact-key
exact normalized phrase         80  → exact-phrase
all query terms present          60  → all-terms
almeno un query term presente    30  → partial-terms
lifecycle-active                +10
recency                          tie-break only
```

Per i Pin il tier key non si applica. I candidati senza alcun tier non vengono restituiti. Lo score è quindi un integer bounded tra `30` e `130`; non è una probabilità e non contiene spiegazioni testuali derivate dal match.

Il find usa prima un visible exact-ID lookup. Altrimenti legge dal runtime pagine stabili di `128` candidati, ordinate per `updatedAt DESC, id ASC`, mantiene in memoria soltanto i migliori `effectiveMaxResults + 1`, controlla l'abort tra le pagine e valuta al massimo `4.096` candidati dopo scope/trust/`activeOnly`. La presenza di un candidato `4.097` o di un body legacy oltre ceiling imposta `incomplete=true`; `truncated` continua a indicare soltanto un match aggiuntivo già noto. Il summary safe avvisa di affinare la query o usare un exact ID quando `incomplete=true`.

Il result espone soltanto il relativo enum `matchKind`:

```text
exact-key
exact-phrase
all-terms
partial-terms
metadata-only
```

## 12.5 Preview

La list non restituisce preview.

Il find può restituire una preview solo se passa l'egress guard sempre attiva:

- il ceiling locale è `20.000` code unit UTF-16, uguale all'hard ceiling del config loader;
- leggere e processare una sorgente soltanto se è completa entro quel ceiling, mai un prefisso già troncato;
- se una projection legacy/malformata supera il ceiling, non scansionarne il body e usare solo eventuale exact ID/key match; la preview è `omitted-by-policy`;
- applicare classification policy e secret redaction all'intera sorgente bounded;
- sopprimere integralmente la preview se la classificazione non è consentita;
- solo dopo la sanitizzazione, troncare l'output sanitizzato a massimo 160 Unicode scalar value senza spezzare surrogate pair;
- trattare provider sconosciuto come remote;
- non copiare la preview nei `details` in aggiunta al testo già sanitizzato.

Questa sequenza evita che la truncation precedente alla sanitizzazione separi marker, credenziali o pattern sensibili.

Quando la preview non è consentita:

```text
previewStatus = omitted-by-policy
```

Non restituire placeholder che includano frammenti del contenuto.

## 12.6 Project sources

`memory_sources` restituisce solo:

```text
sourceRef
targetRevision
status
indexedMutations
activeProjectMemories
activeProjectPins
hasMalformedLines boolean
eventuale errorCode safe
```

Non restituire:

```text
sessionId raw
sessionFile
projectPath
lastError
exclusionReason raw
```

Gli errori delle source diventano codici/enumerazioni safe. `count` e `truncated` seguono la stessa regola `effectiveMaxResults + 1` delle altre read.

I `sourceRef` sono handle casuali di almeno 128 bit, base64url e prefissati `source_`. L'adapter mantiene una map esclusivamente in memoria:

```text
max entries = 1024
TTL         = 15 minuti dall'ultima emissione
key interna = active project identity + sessionId
value       = sourceRef + emittedAt + lastAccessAt
```

Si allocano handle solo per gli item effettivamente restituiti, si riusa lo stesso handle finché valido, una nuova emissione aggiorna `emittedAt`, il solo lookup non prolunga il TTL, si rigenera in caso di collisione e si espelle per TTL poi LRU. La mapping e il process state degli handle non vengono scritti in JSONL, SQLite, manifest, ranking artifacts, Local KV, log o diagnostica persistente. Il solo token opaco emesso compare inevitabilmente nel normale tool result Pi JSONL, senza `sessionId` o mapping riutilizzabile dopo expiry. La risoluzione verifica active project identity, esistenza della source e `targetRevision`; un handle scaduto/evicted produce `source-not-found`. L'ordering viene calcolato sui metadata sottostanti prima dell'allocazione, mai sul valore casuale del ref.

---

# 13. Write path e classi di persistenza

## 13.1 Canonical Pin/Memory mutation

Il tool non deve eseguire:

```text
INSERT INTO pins
UPDATE memory_items
DELETE FROM ...
writeFile(session.jsonl)
```

Percorso obbligatorio:

```text
context_persistence
  ↓
Ds4ContextRuntime
  ↓
MemoryManager proposal
  ↓
pi.appendEntry()
  ↓
Pi CustomEntry
  ↓
sync/reconcile
  ↓
SQLite projection
```

Questo conserva duplicate detection, conflict handling, supersession, status lifecycle e rebuild.

## 13.2 Derived source policy

Percorso obbligatorio:

```text
context_persistence
  ↓
Ds4ContextRuntime
  ↓
ProjectMemorySynchronizer/repository
  ↓
SqliteWriteCoordinator
  ↓
derived SQLite policy
```

Il tool non accede direttamente al repository. Questa operazione non modifica la source JSONL e non è inclusa nel rebuild canonico.

## 13.3 Provenance

La V1 usa soltanto provenance verificabile generata dal runtime:

- source session identity;
- mutation entry identity;
- active branch leaf;
- ultimo messaggio utente precedente al tool call per ogni add/supersede content-bearing;
- supersession target verificato.

Il resolver opera sullo snapshot del branch attivo immediatamente prima della conferma e rivalida session identity, branch entry-ID revision e source prima del dispatch. Se branch o source cambiano nel frattempo, la write fallisce con `provenance-unavailable`; se cambia invece il target materializzato, usa `stale-target`. Entrambi richiedono una nuova read/decisione e non ripiegano su provenance vuota.

Lo schema non accetta `sourceFile`, `sourceEntryId` o `sourceEntryIds` dal modello. Ulteriori fonti non sono esposte nella V1. Se aggiunte in futuro, ogni ID deve esistere nello snapshot del branch attivo e la primary source automatica resta obbligatoria.

## 13.4 Idempotenza e retry

- Add duplicate: restituisce l'ID esistente e `duplicate=true` senza nuova add mutation.
- Post-append projection failure: non ritentare automaticamente.
- `indeterminate`: non ritentare automaticamente; ispezionare prima lo stato.
- Destructive action su target già non-active: `rejected` con codice safe.
- Source policy include/exclude già nello stato richiesto: outcome idempotente `ok`, senza falsa canonical mutation.

---

# 14. Privacy e prevenzione dei leak

## 14.1 Threat model

Possibili canali di leak:

- `content[].text` del tool result;
- `details`;
- error message;
- log;
- preview;
- argomenti del tool call corrente o storico, inclusi `content`, `query`, `key` e `reason`;
- exclusion reason, project/session/file path e source metadata;
- replay della history dopo cambio provider locale → remoto o noto → sconosciuto;
- UI confirmation ricopiata nel result;
- classification erroneamente dichiarata dal modello.

## 14.2 Egress guard sempre attiva

Il tool introduce una policy di egress propria che si applica anche quando:

```text
privacy.enabled = false
```

Motivo: l'attuale sanitizer generale può lasciare invariato il testo quando privacy è disabilitata, mentre il contratto del tool richiede comunque result bounded e secret-redacted.

Pipeline minima per testo o preview:

```text
raw local source
  ↓
lettura completa entro ceiling locale bounded
  ↓
provider destination resolution
  ↓
classification policy
  ↓
secret redaction sull'intera sorgente bounded
  ↓
soppressione se non consentita
  ↓
truncation del solo output sanitizzato
  ↓
metadata allowlist + final recursive leak scan
  ↓
tool result
```

La final scan deve coprire sia `content` sia `details` e fallire chiusa se incontra campi inattesi.

Policy provider-aware esatta, indipendente da `privacy.enabled`:

- risolvere sempre `providerPrivacyPolicy(config.privacy, provider)`; provider assente/sconosciuto usa destination remote e `remoteDefaultAllowed`;
- `local-only` non è mai consentito a una destination remote, anche se una regola config errata lo elencasse;
- `internal` e `sensitive` seguono l'allowlist provider; `normal` segue anch'esso l'allowlist senza assunzioni implicite;
- secret detection e redaction delle preview operano per destination local e remote;
- marker strutturali e secret detection alzano la classificazione effettiva proposta (`secret` almeno `sensitive`); dopo conferma, l'add/supersede persiste questa classificazione più restrittiva, ma conserva il raw canonical content locale, non il testo redatto per l'egress;
- se la classificazione risultante non è permessa, la write è `rejected/provider-policy-denied` senza append;
- un `reason` con marker classificato o secret-like viene sempre rifiutato con `secret-in-reason`, perché le status/source-policy mutation non hanno un campo classification autonomo; l'utente può ometterlo e riprovare localmente;
- `query` non viene persistita e può essere usata per il matching locale, ma non viene mai ecoata.

Questa elevazione automatica è solo verso maggiore protezione e viene mostrata nella UI; non è una prova che il provider corrente non abbia già visto l'argomento.

## 14.3 Argomenti storici e provider switching

Pi JSONL resta canonico e immutato. Ogni volta che un tool call/result `context_persistence` storico viene ricostruito per una richiesta provider-bound — anche verso lo stesso provider — DS4 sanitizza soltanto la copia outbound. Il provider switching è il caso più rischioso, non l'unico caso coperto.

Policy deterministica:

- conservare ordine, `toolCallId`/linkage della coppia tool call/result, `action` e soli metadata opachi ammessi dal transport;
- usare il sentinel letterale bounded `[omitted-by-ds4-egress-policy]`;
- sostituire integralmente i valori storici di `content`, `query`, `key`, `reason` e campi inattesi con quel sentinel, senza frammenti originali;
- ridurre anche result/error storici alla allowlist V1, senza fidarsi del fatto che siano stati prodotti da una versione precedente del tool;
- rimuovere path, source-session metadata, exclusion reason ed errori completi;
- applicare la classificazione effettiva del target per supersede/status, non una classificazione più debole fornita dal modello;
- applicare secret detection anche quando `privacy.enabled=false`;
- trattare provider sconosciuto come remoto;
- in caso di payload malformato, shape inattesa o classificazione non risolvibile, preservare la coppia minima valida per il transport e sopprimere tutti gli argomenti e result non metadata; se il transport non accetta neppure tale coppia, fallire la request con un errore locale safe anziché inviare il raw.

Il controllo avviene sia nel context transformation path sia in `before_provider_request`, così copre replay gestito, provider switching e richieste native. La copia sanificata deve esistere **prima** di privacy eligibility, Local-KV eligibility o prefix extraction; nessun path KV può osservare o riusare il payload storico raw. Il processo non persiste copie sanificate aggiuntive, mapping handle o contenuto e non modifica JSONL, SQLite, manifest, ranking artifacts o Local KV; i tool result storici già presenti nel Pi JSONL restano byte-identici.

Il provider che ha generato il tool call corrente potrebbe averne già visto gli argomenti: la sanitizzazione storica impedisce replay successivi, ma non autorizza affermazioni retroattive di località.

## 14.4 Allowlist result

Campi ammessi:

```text
schema
action
outcome
persistenceClass
safe errorCode
id o sourceRef
kind
scope
status
classification
applicableToActiveBranch
targetRevision
createdAt/updatedAt
matchKind
score numerico bounded
count
truncated
incomplete
duplicate
preview sanitizzata, solo in `content[].text`
previewStatus
```

`details` non contiene mai preview, neppure sanitizzate: conserva soltanto metadata operativi. Questo evita copie persistenti o renderer-specifiche di testo derivato dallo stato locale.

Campi vietati:

```text
raw content
raw claim
raw key
raw query
raw reason
sourceFile
sessionFile
projectPath
raw sourceEntryIds
raw mutation payload
stack trace
provider payload
```

## 14.5 Mutation responses

Dopo una canonical mutation usare il template V1:

```text
Committed pin <ID>.
```

Mai:

```text
Committed pin <ID>: <full content>
```

Per source policy usare invece `Updated derived local policy for <sourceRef>.`, senza suggerire un commit canonico. La stessa regola metadata-only vale per duplicate, conflict, supersede, invalidation ed expiration.

## 14.6 `classification` non è una prova di sicurezza

La classificazione fornita nel tool call è un attributo della mutation proposta, non una prova che il contenuto fosse sicuro da inviare al provider.

Se il modello corrente è remoto:

- gli argomenti del tool sono già transitati dal provider;
- `classification=local-only` non rende retroattivamente locale il contenuto;
- una write non consentita dalla policy provider deve essere rifiutata;
- il result deve consigliare `/context` o un provider locale senza ecoare il contenuto.

Non dichiarare mai che un segreto è rimasto locale solo perché il modello ha impostato `local-only`.

Per supersede e status, la policy usa la classificazione effettiva ereditata dal target. Una richiesta del modello non può abbassarla; per add/supersede, marker e secret detection possono elevarla automaticamente prima della conferma. I reason secret-like sono rifiutati anziché persistiti senza classificazione.

## 14.7 Defense in depth

Il context transformation path e `before_provider_request` sono barriere complementari. Il tool deve essere sicuro autonomamente e non affidarsi al filtro finale per correggere result già troppo grandi o raw.

## 14.8 UI locale

La conferma locale può mostrare il contenuto necessario a una decisione informata. Quel testo:

- non viene copiato nel tool result;
- non viene inserito nei log;
- non viene memorizzato nello stato volatile del tool oltre la durata dell'execute;
- viene bounded nella UI per evitare output incontrollato.

---

# 15. Consenso e autorizzazione locale

## 15.1 Principio

`promptGuidelines` e description sono advisory. Non possono dimostrare che il modello abbia interpretato correttamente l'intento dell'utente.

Per rendere enforceable la regola “explicit user intent, not autonomous memory harvesting”, la V1 richiede conferma locale per **tutte** le write LLM-callable:

```text
canonical writes
+
derived source policy writes
```

## 15.2 Conferma Pi

Quando `ctx.hasUI` è true:

```ts
await ctx.ui.confirm(title, message)
```

Il dialog deve mostrare:

- title fisso `DS4 Context Persistence` e action;
- classe di persistenza e scope;
- target ID/ref e revisione abbreviata per update;
- per add/supersede: content completo già validato, fino al limite config/hard di 20.000 code unit, più key/classificazione effettiva se presenti;
- per unpin/status: preview locale del target fino a 500 Unicode scalar e reason completo fino a 500 code unit;
- per source policy: solo sourceRef, status e contatori safe, mai path/session ID/error/reason storico;
- avviso che canonical append non equivale a delete fisica;
- per source policy, avviso che lo stato è locale/disposable.

La UI non usa la preview provider-safe: è una superficie locale distinta. Anche qui una projection legacy oltre ceiling mostra solo metadata e richiede all'utente di usare `/context` per l'ispezione locale completa.

## 15.3 Modalità senza UI

Quando `ctx.hasUI` è false:

- le read restano disponibili;
- tutte le write ritornano `outcome=unavailable` e `errorCode=confirmation-required`;
- non viene eseguita alcuna mutation;
- il result suggerisce `/context` o una sessione UI-capable.

Non accettare un booleano `confirmed=true` fornito dal modello: non è consenso attendibile.

## 15.4 Cancel

Se l'utente rifiuta o chiude il dialog:

```text
outcome = cancelled
```

Nessun append, nessun update SQLite, nessun warning rumoroso.

## 15.5 Futuro direct mode

Un'eventuale modalità senza conferma deve essere:

- esplicitamente opt-in;
- documentata come riduzione della safety;
- introdotta solo con nuova configurazione 0.3+;
- coperta da threat model e test non-UI.

Non fa parte della V1.

---

# 16. Ambiguità, exact target e concorrenza

## 16.1 Scope

Default add:

```text
session
```

Regole:

- branch consentito solo per Pin;
- project richiede progetto trusted;
- Memory branch viene rifiutata;
- nessuna conversione silenziosa branch → project;
- supersede conserva lo scope del target.

## 16.2 Pin vs Memory

```text
constraint/istruzione che deve restare prominente?
  ├── sì → Pin
  └── no → fatto/decisione durevole → Memory
```

Se la richiesta è ambigua, l'agente deve chiarire prima della write.

## 16.3 Nessuna destructive fuzzy action

`find` non muta mai. Non esiste la regola “un match chiaramente dominante può essere rimosso automaticamente”.

Ogni destructive action richiede:

```text
exact id/ref
targetRevision
separate tool call
local confirmation
```

Se ci sono più match, il modello non sceglie in autonomia in base a un margine arbitrario. Chiede all'utente o usa la UI locale per una scelta esplicita.

## 16.4 Target revision

Ogni read genera una revisione opaca process-local:

```text
targetRevision = "rev_" + base64url(
  HMAC-SHA256(processSecret, stableJson(revisionInput))
).slice(0, 22)
```

`processSecret` contiene almeno 256 bit casuali, nasce all'avvio e non viene persistito o loggato. Nei test è iniettabile con fixture deterministica. `revisionInput` include versione interna, kind/ID, scope, lifecycle status, `updatedAt`, classificazione effettiva e active session/project/branch revision. Per i Pin include anche applicabilità; per le source include session identity interna, `indexedAt`, status, contatori e malformed-line count. Non include content, claim, key, reason, path, error text o preview.

La write risolve il target soltanto tra gli item visibili nello stesso active runtime context; non usa un repository global lookup non scoped. Ricalcola la revisione prima della conferma e immediatamente prima del dispatch. Restart, cambio session/project/branch, modifica target o config classification rendono deliberatamente stale la revisione.

Se non coincide:

```text
outcome = rejected
errorCode = stale-target
```

Il modello deve ripetere la read. La revisione:

- non sostituisce autorizzazione, trust check o conferma;
- non è persistita come stato DS4 in SQLite, manifest, ranking artifacts o Local KV; il token opaco può restare nel tool result Pi JSONL ma scade al restart perché il secret non è persistito;
- non contiene raw content e il secret impedisce di usare l'hash come oracle diretto sui metadata interni;
- riduce race e update su target cambiati.

## 16.5 Cross-process changes

SQLite è condiviso tra sessioni/processi. Il target può cambiare tra read e write. La revision check è un optimistic guard, mentre repository e `SqliteWriteCoordinator` restano responsabili della serializzazione effettiva.

Il runtime deve comunque rivalidare visibility, status, scope e trust dentro il percorso di dominio. La seconda revision check e il dispatch devono restare nello stesso tratto serializzato; se non possono essere atomici rispetto a un writer cross-process, il repository/domain check deve rilevare il conflitto senza sovrascrivere stato.

---

# 17. Stati operativi, errori e abort

## 17.1 Matrice operativa

| Stato | Read | Canonical write | Source policy write |
|---|---|---|---|
| DS4 enabled, memory ready | sì | sì con conferma | se cross-session ready |
| `memory.enabled=false` | `unavailable` | `unavailable` | `unavailable` |
| runtime non aperto/no session identity | `unavailable` | `unavailable` | `unavailable` |
| SQLite/memory subsystem degradato | `unavailable`, safe code | fail-closed | fail-closed |
| progetto untrusted | solo stato session visibile; project source `unavailable` | project actions rifiutate | rifiutate |
| `memory.crossSession=false` | `memory_sources` → `unavailable/cross-session-disabled` | n/a | rifiutate |
| no UI | sì | rifiutate | rifiutate |
| provider sconosciuto | policy remote | solo se egress/input policy consente | con conferma, metadata-only |

Il context engine generale può continuare il proprio fallback fail-open. Il tool di persistenza non deve fingere successo quando non può garantire la mutation. Le read unavailable restituiscono zero contenuto di stato e non una lista vuota con `outcome=ok`, così “nessun dato” resta distinguibile da “subsystem non consultabile”.

## 17.2 Abort

Controllare `signal.aborted`:

1. all'ingresso;
2. dopo validazione/state check;
3. prima della conferma UI;
4. immediatamente dopo la conferma e prima del runtime dispatch.

Una volta iniziato un append sincrono, l'abort è best-effort. Non descrivere una mutation già appesa come annullata.

## 17.3 Outcome e retry safety

### `rejected`

Errore prima dell'append. Nessuna mutation canonica. Il caller può correggere parametri o stato.

### `committed`

Append e materializzazione confermati.

### `committed_projection_pending`

`pi.appendEntry()` è riuscito ma sync/reconcile successivo è fallito. La mutation canonica esiste; non ritentare automaticamente. Mostrare warning actionable metadata-only.

### `indeterminate`

Non è possibile stabilire se l'append sia stato completato. Non ritentare automaticamente. Richiedere una read/rebuild diagnostica.

### `cancelled`

Utente o abort prima del dispatch. Nessuna write.

## 17.4 Boundary Pi e `isError`

Validation, policy denial, user cancel, stato unavailable e failure tipizzate sono normali result `AgentToolResult` con envelope V1; non si ottengono lanciando eccezioni contenenti messaggi runtime. Il boundary `execute` cattura ogni errore, determina prima `commitState` e lo converte in `rejected`, `unavailable`, `committed_projection_pending` o `indeterminate`.

Solo un difetto non classificabile del boundary può essere rilanciato a Pi, che lo marca `isError=true`; in tal caso il messaggio deve essere il letterale safe `context_persistence failed safely`. Il raw error object non viene loggato: la diagnostica locale `error` conserva soltanto action, commit state e classe/codice allowlisted. Errori di schema rifiutati da Pi prima di `execute` restano fuori dal result contract, ma non devono includere valori degli argomenti. Nessuna failure post-append nota deve uscire come throw generico, perché perderebbe l'informazione di partial commit.

## 17.5 Error codes safe

Esempi:

```text
memory-unavailable
confirmation-required
project-untrusted
cross-session-disabled
invalid-scope
invalid-classification
provenance-unavailable
content-too-long
claim-too-long
result-budget-exceeded
stale-target
target-not-active
duplicate-conflict
source-not-found
provider-policy-denied
secret-in-reason
committed-projection-pending
append-indeterminate
aborted
```

I messaggi non includono raw content, query, reason, key, path o stack trace.

## 17.6 Nessun rollback post-append

Dopo append riuscito:

- non riscrivere JSONL;
- non cancellare entry;
- non tentare compensazioni dirette SQLite;
- non promettere rollback;
- lasciare a replay/reconcile il recupero della projection.

---

# 18. Logging e diagnostica

## 18.1 Livelli

Routine summaries devono restare nascoste al livello default `info`:

```text
context_persistence.called       debug
context_persistence.succeeded    debug
context_persistence.cancelled    debug
pin.created                      debug
pin.deleted                      debug
memory.created                   debug
memory.superseded                debug
memory.status_changed            debug
```

Gli eventi runtime Pin/Memory esistenti sono condivisi da command e tool: in `0.3` vanno portati da `info` a `debug` nel punto comune, senza aggiungere un secondo summary `info` nel tool. Questo mantiene lo stesso livello su tutti i call path e non cambia payload o semantica delle mutation.

Eventi actionable:

```text
post-append projection failure   warn
indeterminate append             warn
privacy egress block anomalo     warn
runtime invariant violation      error
```

Validation error atteso, duplicate e user cancel non devono produrre warning rumorosi.

## 18.2 Metadata ammessi

```text
action
outcome
persistenceClass
scope
opaque itemId per canonical item; nessun sourceRef
classification
resultCount
duplicate
safe errorCode
duration bucket se già supportato
```

## 18.3 Dati vietati

```text
content
claim
query
key
reason
preview
sourceFile
sessionFile
projectPath
mutation payload
stack trace a livello info/warn
```

## 18.4 Diagnostica `/context`

Pin e Memory creati dal tool devono comparire automaticamente nelle diagnostiche esistenti come quelli creati da command.

Non aggiungere raw payload al Context Manifest. Per il tool sono sufficienti contatori metadata-only, se davvero necessari.

Source exclusion deve essere descritta come local derived policy; una diagnostica non deve farla apparire canonica.

---

# 19. Configurazione e limiti

## 19.1 V1

Non modificare `ds4-context-config-v1` nella linea `0.2`. Il lavoro avviene in `0.3`.

Per la prima versione:

- conferma write obbligatoria, senza nuova opzione;
- limiti content/result derivati dalla configurazione runtime esistente;
- cross-session invariato e opt-in;
- attivazione/disattivazione del tool documentata tramite i meccanismi Pi per active tools;
- nessuna abilitazione automatica di feature sensibili o transport-specific.

## 19.2 Limiti source of truth

```text
Pin content:     memory.maxPinChars
Memory claim:   memory.maxClaimChars
Read result:    memory.maxResults
Pin token cap:  context.maxPinnedTokens
```

Lo schema TypeBox usa soltanto hard ceiling di trasporto. Il messaggio di errore deve riferire il nome della configurazione e il limite numerico, senza ecoare il valore rifiutato.

## 19.3 Eventuale config futura

Solo dopo uso reale e ADR:

```json
{
  "agentTools": {
    "persistence": {
      "enabled": true,
      "confirmation": "all"
    }
  }
}
```

Possibili valori futuri:

```text
all
destructive
none               // opt-in esplicito e rischioso
```

Non congelare questa shape nel contratto V1 senza necessità.

---

# 20. File da creare e modificare

## 20.1 Nuovi file

```text
src/extension/context-persistence-contract.ts
src/extension/context-persistence-tool.ts
tests/integration/context-persistence-tool.test.ts
```

Opzionali, se la complessità lo giustifica:

```text
src/extension/context-persistence-result.ts
tests/unit/context-persistence-tool.test.ts
scripts/measure-tool-schema-cost.mjs
```

## 20.2 File da modificare

```text
src/extension/index.ts                   registration sequenziale e neutralità project-file
src/extension/runtime.ts                 helper provenance/egress/outcome e livelli debug dei lifecycle routine
src/pi-adapter/message-converter.ts      solo se serve distinguere in modo tipizzato i tool call storici
packages/core/src/memory/memory-manager.ts primitive additive di page/visible read, se necessarie
packages/core/src/persistence/repositories/memory-repository.ts query keyset bounded, se necessarie
README.md
docs/MEMORY_AND_PINS.md
docs/ARCHITECTURE.md
docs/CONTEXT_PERSISTENCE_TOOL.md         NEW
docs/releases/0.3.0-alpha.1.md           NEW al momento della release
package.json                             version/scripts quando appropriato
```

## 20.3 File che non devono cambiare salvo necessità dimostrata

```text
packages/core/src/memory/memory-types.ts
packages/core/src/persistence/migrations.ts
packages/reference-adapter/*
planner/ranking/local-kv contracts
```

Se emerge una necessità reale di projection:

- aggiungere migration `16`;
- non modificare `1`–`15`;
- aggiornare golden e rebuild test;
- motivare la modifica in ADR.

---

# 21. Piano di implementazione per milestone

## M0 — Contract, threat model e misure

Definire/congelare:

```text
tool/result contract identifiers
tool name
actions
parameter matrix
executionMode sequenziale
result envelope e DTO action-specific
metadata allowlist
exact-target revision
provenance primaria automatica
confirmation policy
post-append outcomes
canonical vs derived policy semantics
project-file neutrality
```

Attività obbligatorie:

- misurare token/byte della tool definition;
- misurare tool unico e qualità di routing;
- definire fixture provider, incluso switching local → remote e remote → unknown;
- verificare i metodi Pi `promptSnippet`, `promptGuidelines`, `execute`, `signal`, `ctx.hasUI`, `ctx.ui.confirm` e `details` contro Pi `0.84.3`;
- definire test leak sentinels per input corrente, argomenti storici, output, details, errori e log;
- congelare normalizzazione, ordering, `count`/`truncated`/`incomplete` e assenza di `totalCount`.

Exit criteria:

- schema budget rispettato; altrimenti M0 bloccato;
- `executionMode="sequential"` verificato;
- contratti tool/result e golden DTO congelati;
- primary provenance automatica e nessun campo provenance model-supplied;
- nessuna fuzzy write;
- conferma locale enforceable;
- historical-argument egress fail-closed;
- outcome post-append non ambiguo.

## M1 — Read-only skeleton

Implementare:

```text
pins_list
pins_find
memory_list
memory_find
memory_sources
```

Includere:

- deterministic normalization e ordering;
- `count`/`truncated` via `limit + 1`, `incomplete` su scan cap e nessun `totalCount`;
- runtime page API ordinate in read transaction/keyset, exact-ID fast path, page size 128 e scan cap 4.096;
- egress guard sempre attiva;
- mapping `sourceRef` volatile con token opaco nel normale tool result;
- revision metadata process-local con token opaco nel normale tool result;
- stato disabled/degraded;
- nessun project file-index refresh.

Exit criteria: nessuna read modifica stato canonico o derivato.

## M2 — Authorization e result safety

Prima delle write implementare:

- `ctx.hasUI` gate;
- `ctx.ui.confirm()`;
- abort check pre/post confirmation;
- metadata allowlist ricorsiva;
- leak sentinel scan;
- sanitizer degli argomenti storici nel context path e in `before_provider_request`;
- classificazione target ereditata e nessun downgrade;
- safe error codes e boundary Pi/`isError` senza raw exception;
- typed commit outcomes;
- demotion a `debug` dei lifecycle summary routine condivisi, senza sopprimere warning/error actionable.

Exit criteria: una write non può raggiungere il runtime senza conferma locale.

## M3 — Pin mutations

Implementare:

```text
pin_add
pin_supersede
pin_unpin
```

Usare soltanto runtime e appender canonico.

Test chiave:

- session/branch/project;
- project untrusted;
- duplicate;
- exact supersede;
- stale revision;
- max char/token cap;
- post-append failure;
- no-UI denial.

## M4 — Memory mutations

Implementare:

```text
memory_add
memory_supersede
memory_invalidate
memory_expire
```

Test chiave:

- session/project;
- branch reject;
- key explicit/derived senza key echo;
- duplicate/conflict;
- exact supersede/status;
- classification/provider gate, marker/secret auto-elevation;
- configured limits.

## M5 — Derived cross-session source policy

Implementare:

```text
memory_source_exclude
memory_source_include
```

Vincoli:

- `memory.crossSession=true`;
- progetto trusted;
- sourceRef da `memory_sources`;
- revision check;
- local confirmation;
- result `persistenceClass=derived-local-policy`;
- nessuna append Pi JSONL;
- database deletion resetta deliberatamente la policy.

## M6 — Failure and recovery hardening

Simulare:

- append throw pre-commit;
- append outcome unknown;
- reconcile failure post-append;
- SQLite busy/locked;
- runtime closed;
- session identity assente;
- abort ai vari boundary;
- duplicate retry dopo commit pending.

Exit criteria: nessun result induce retry distruttivo o afferma rollback inesistente.

## M7 — Conversational behavior

Testare descrizione/guideline su scenari:

Positivi:

```text
"ricordati..."
"metti un pin..."
"aggiorna la memoria..."
"togli il pin..."
```

Negativi:

```text
"PerEndpoint sembra una buona idea."
"Forse dovremmo supportare Node 22."
```

Il tool non deve essere chiamato per ordinary conversation. Qualunque errore del modello resta mitigato dal confirmation gate.

## M8 — Integration e regression

Eseguire:

```bash
npm run build:core
npm run build:adapters
npm run typecheck
npm test
npm run check
npm run quality:compare
npm run latency:check
npm run pack:check
npm pack --dry-run
npm pack --dry-run --workspace ds4-context-core
npm pack --dry-run --workspace ds4-context-reference-adapter
```

Conservare anche il gate di latency feature-disabled `<=1.10x` rispetto all'esatto `ds4-context-core@0.1.2`, pur essendo il costo principale del tool un overhead di schema/input token separato.

## M9 — Documentazione e prerelease

Aggiornare docs, ADR/release notes, smoke test TUI/RPC, poi pubblicare manualmente `0.3.0-alpha.1` solo se tutti i gate sono verdi.

---

# 22. Test plan completo

## 22.1 Registration e schema budget

Verificare:

- `context_artifact_search` invariato;
- nuovo tool registrato una sola volta;
- active-tool behavior Pi;
- schema valido sui provider supportati;
- `StringEnum` e assenza di union literal incompatibili;
- `executionMode="sequential"` dichiarato e ordering sibling verificato;
- identificatori `ds4-context-persistence-tool-v1` e `ds4-context-persistence-result-v1`;
- budget token/byte;
- nessun runtime Pi aggiunto a `ds4-context-core`.

## 22.2 Schema validation

Casi:

```text
unknown action
missing required field
irrelevant field for action
additional property
invalid scope
invalid classification
oversized content/query/reason
invalid maxResults
missing targetRevision
```

## 22.3 Runtime state matrix

Coprire tutte le righe della matrice 17.1, inclusi:

- memory disabled;
- runtime non aperto;
- no session identity/file;
- degraded SQLite;
- project untrusted;
- cross-session disabled;
- no UI;
- unknown provider.

## 22.4 Read bounds e ordering

Verificare:

- default `activeOnly=true`;
- `maxResults` capped da config;
- `count === items.length`;
- `truncated=true` calcolato con `limit + 1` sui match valutati;
- `incomplete=true` al candidate scan cap 4.096 o per body legacy oversized, con summary safe;
- page size 128, keyset/read snapshot coerente, abort tra pagine ed exact-ID fast path;
- nessun `totalCount` nel contratto V1;
- ordering stabile a parità di timestamp/score e source ordering indipendente dai ref casuali;
- Pin branch lifecycle-active distinto da applicabilità al branch corrente;
- normalizzazione NFKC e case folding `en-US` indipendenti dalla locale host;
- nessuna dipendenza dall'ordine repository;
- sorgente >20.000 code unit mai parzialmente scansionata per body/preview;
- sanitizzazione dell'intera sorgente bounded prima della preview max 160 Unicode scalar;
- budget finali 96 KiB content e 64 KiB details, con fail-closed.

## 22.5 Pin add

Coprire:

- session;
- branch e branch leaf;
- project trusted;
- project untrusted;
- duplicate senza seconda add mutation;
- configured char cap;
- classification default, marker/secret auto-elevation e provider denial;
- total pin token cap;
- user cancel;
- no UI.

## 22.6 Pin supersede/unpin

Coprire:

- exact ID + revision;
- missing/stale revision, incluso restart o cambio active context;
- target non visibile nel runtime context;
- target non-active;
- scope invariato;
- classificazione omessa conservata, classificazione più restrittiva accettata e downgrade rifiutato;
- branch Pin active ma non applicabile distinto da active e applicabile;
- lifecycle append-only;
- nessuna delete fisica;
- due match fuzzy non generano write.

## 22.7 Memory add

Coprire:

- session/project;
- branch rejection;
- key explicit/derived;
- duplicate;
- conflict;
- configured claim cap;
- classification default effettiva;
- user cancel;
- no UI.

## 22.8 Memory supersede/status

Coprire:

- exact target;
- stale revision;
- supersede conserva scope/key;
- classificazione omessa ereditata;
- classificazione più restrittiva/auto-elevata accettata e downgrade rifiutato;
- reason secret-like rifiutato;
- invalid;
- expired;
- reason non appare in result/log;
- target già non-active.

## 22.9 Provenance

Verificare che:

- il tool schema non accetti `sourceFile`, `sourceEntryId` o `sourceEntryIds`;
- add/supersede colleghino automaticamente l'ultimo messaggio utente precedente;
- la primary source appartenga allo snapshot del branch attivo;
- cambio branch/race prima del dispatch produca `provenance-unavailable` o `stale-target`;
- assenza di primary source rifiuti la mutation content-bearing senza fallback `[]`;
- provenance strutturale runtime sia presente;
- branch leaf sia verificata dal runtime;
- nessuna provenance sia inventata dal modello.

## 22.10 Privacy mutation output

Usare sentinelle in:

```text
content
claim
key
reason
source path
```

Verificare assenza da:

```text
content[].text
details
logs
safe errors
post-append warning
```

### 22.10.1 Argomenti storici e provider switching

Creare history con sentinelle in `content`, `query`, `key`, `reason`, exclusion reason, path e source metadata. Eseguire replay:

```text
local → remote
local → unknown
remote A → remote B
privacy enabled → disabled
payload valido → payload malformato
```

Verificare:

- Pi JSONL byte-identico prima/dopo;
- payload outbound con action/struttura preservati ma valori proibiti sostituiti integralmente;
- nessun frammento raw dopo truncation;
- context path e `before_provider_request` entrambi coperti;
- linkage tool call/result conservato e fallback malformato fail-closed;
- classificazione del target usata per supersede/status;
- sanitizzazione completata prima di privacy/KV eligibility e prefix extraction;
- nessun contenuto aggiunto a JSONL, SQLite, manifest, ranking artifacts o Local KV.

## 22.11 Privacy find/list

Matrice:

```text
privacy enabled/disabled
local/remote/unknown provider
normal/internal/sensitive/local-only
secret-like/non-secret content
```

Verificare:

- egress guard e provider allowlist attive anche con privacy disabled;
- secret redaction attiva anche verso provider local;
- marker/secret auto-elevano la classificazione canonica dopo conferma;
- reason secret-like viene rifiutato senza append;
- local-only non esposto a remote;
- unknown trattato remote;
- details non contengono copia raw;
- blocked preview conserva solo metadata safe.

## 22.12 Classification misuse

Con provider remoto, inviare write `classification=local-only` e verificare:

- provider-policy denial;
- nessuna falsa promessa di località;
- nessun append;
- suggerimento safe a `/context` o provider locale.

## 22.13 Confirmation

Coprire:

- conferma positiva;
- rifiuto;
- dialog closed;
- abort prima del dialog;
- abort mentre dialog aperto;
- abort dopo conferma ma prima dispatch;
- `ctx.hasUI=false`;
- model-supplied `confirmed` rifiutato come additional property.

## 22.14 Post-append outcomes

Iniettare failure:

- prima di append;
- durante append con esito noto failure;
- durante append con esito indeterminato;
- dopo append durante sync;
- dopo append durante reconcile.

Verificare outcome, no automatic retry, conversione strutturata senza throw generico e literal safe per l'unico fallback `isError=true`. Verificare inoltre che successi/cancel e gli eventi runtime `pin.*`/`memory.*` routine restino a `debug`, mentre projection pending, append indeterminato e invariant violation restano rispettivamente `warn`/`error`.

## 22.15 Cross-session sources

Con `memory.crossSession=true`:

- list usa `sourceRef`, non session path;
- ref sconosciuto/scaduto/evicted viene rifiutato;
- map volatile rispetta TTL 15 minuti, cap 1024, riuso e collision handling;
- active source non escludibile;
- exact revision e active-context binding;
- exclude/include idempotenti;
- confirmation;
- nessuna Pi custom entry aggiunta.

## 22.16 Canonical rebuild

Dopo Pin/Memory creati via tool:

1. chiudere runtime;
2. eliminare il database;
3. riaprire;
4. ricostruire da Pi JSONL.

Pin/Memory devono riapparire con lifecycle corretto.

## 22.17 Derived-policy rebuild

Dopo source exclusion:

1. verificare source excluded;
2. eliminare il database;
3. rebuild da JSONL;
4. verificare che l'esclusione locale non sopravviva;
5. verificare che nessuna source JSONL sia stata modificata.

Questo comportamento è intenzionale finché non esiste un contratto canonico dedicato.

## 22.18 Slash command parity

Per capability comuni, `/context` e tool producono lo stesso stato materializzato. Non è richiesta parità di:

- schema parametri;
- UI string;
- output raw;
- provenance opzionale model-supplied, che il tool non espone.

## 22.19 Session branching e planner

Verificare:

- branch Pin applicabile solo sulla branch corretta;
- latest preceding user provenance segue il branch attivo;
- project/session scope invariati;
- Pin entra come mandatory con priorità esistente (`950`);
- Memory usa ranking policy esistente;
- nessun bypass di privacy, budget o hard input limits;
- ogni action di `context_persistence` lascia invariati file-index generation, scan count e project knowledge refresh state.

## 22.20 Shared SQLite concurrency

Eseguire write tool concorrenti da più sessioni/processi sul database condiviso. Verificare:

- WAL e coordinator invariati;
- bounded retry busy/locked;
- duplicate/conflict deterministici;
- stale revision su target concorrente;
- nessun JSONL riscritto.

## 22.21 Long-session, packaging e compatibility

- long-session esistente;
- package root include i nuovi file;
- golden `0.2.0` resta immutato;
- migration `1`–`15` checksum invariati;
- `context_artifact_search` regression;
- reference adapter invariato;
- `npm run check` e `npm run pack:check` verdi.

## 22.22 Manual smoke

TUI:

- read;
- add con conferma;
- destructive con read/revision/conferma;
- cancel;
- privacy local/remote.

RPC:

- con UI bridge e `ctx.hasUI=true`, confirm positivo/negativo verificato;
- con `ctx.hasUI=false`, write `unavailable/confirmation-required` e nessun append;
- Pi `0.84.3` può dichiarare `ctx.hasUI=true` in RPC anche quando nessun client risponde alla richiesta UI: in quel caso la confirm resta pendente nel transport Pi e DS4 non presume né consenso né rifiuto; nessun append avviene prima della risposta;
- con `--no-session`, write `unavailable/runtime-unavailable` prima della confirm e nessun append;
- result schema;
- no leaked details.

Print/JSON:

- read disponibile;
- write `unavailable/confirmation-required` per assenza UI.

---

# 23. Scenari end-to-end

## Scenario A — Pin naturale

Utente:

```text
Da ora in questo progetto mantieni compatibilità SQL Server 2012. Metti questa regola tra i pin.
```

Agente:

```text
context_persistence(pin_add, scope=project)
```

UI locale:

```text
Confirm canonical project Pin creation?
[bounded local preview]
```

Result al modello:

```text
Created project pin <ID>.
```

Nessun content raw nel result.

## Scenario B — Durable Memory

Utente:

```text
Ricordati per il progetto che Package export mode ha PerEndpoint come default.
```

Dopo conferma:

```text
memory_add
scope=project
```

La mutation è canonica nella sessione Pi corrente. Altre sessioni possono recuperarla solo se `memory.crossSession=true` e la project identity trusted coincide esattamente.

## Scenario C — Modifica decisione

```text
memory_find("package export mode")
  ↓
exact ID + targetRevision
  ↓
memory_supersede(...)
  ↓
local confirmation
```

Se la memoria cambia tra find e supersede, la write fallisce con `stale-target` e richiede una nuova read.

## Scenario D — Rimozione Pin ambigua

`pins_find("Node 22")` restituisce due target.

L'agente non rimuove il match col punteggio maggiore. Chiede all'utente quale elemento intende; poi usa exact ID/revision e conferma locale.

## Scenario E — Nessuna persistenza automatica

Utente:

```text
Forse SQLite sarebbe una scelta migliore.
```

Nessuna write. Se il modello la tenta comunque, il confirmation gate impedisce la mutation senza consenso locale.

## Scenario F — Dato local-only con provider remoto

L'utente chiede di persistere un segreto come `local-only` mentre usa un provider remoto.

Il tool non afferma che il dato sia rimasto locale e rifiuta la write secondo provider policy. Suggerisce di usare `/context` oppure un provider locale.

## Scenario G — Source exclusion

L'utente elenca le source, seleziona una `sourceRef`, conferma l'esclusione e riceve:

```text
Updated local derived project-memory source policy.
```

Dopo cancellazione del database, la policy non viene ricostruita. Le sessioni Pi JSONL restano immutate.

## Scenario H — Projection failure post-append

L'append canonico riesce ma la projection fallisce.

Result:

```text
Canonical mutation committed; local projection refresh is pending. Do not retry automatically.
```

Warning actionable, metadata-only. Il rebuild successivo riallinea SQLite.

---

# 24. Criteri di accettazione

Stato `0.3.0-alpha.1`: tutti i criteri sono soddisfatti; package pubblicati sotto il dist-tag `alpha`, verifica exact-version completata, tag annotato e GitHub prerelease creati.

## Functional

- [x] Read Pin/Memory bounded e deterministiche.
- [x] Add Pin session/branch/project.
- [x] Add Memory session/project.
- [x] Supersede/unpin/status solo con exact target e revision.
- [x] Source management funziona quando opt-in.
- [x] No-UI write fail-closed.
- [x] Conferma locale richiesta per ogni write.

## Architecture

- [x] `ds4-context-persistence-tool-v1` e `ds4-context-persistence-result-v1` congelati e coperti da golden.
- [x] Tool registrato con `executionMode="sequential"`.
- [x] Canonical Pin/Memory write passa da runtime e `pi.appendEntry()`.
- [x] Source policy write è dichiarata derivata, locale e disposable.
- [x] Nessun accesso diretto SQLite dal tool.
- [x] Pi JSONL resta canonico e non viene riscritto.
- [x] SQLite resta condiviso, coordinato e ricostruibile.
- [x] `context_persistence` è project-file-neutral e non causa index refresh.
- [x] `ds4-context-core` resta Pi-independent.
- [x] Migration `1`–`15` immutate.

## Safety

- [x] Nessuna automatic memory harvesting.
- [x] Scope default session.
- [x] Nessuna destructive fuzzy action.
- [x] Stale target rifiutato.
- [x] Primary provenance automatica dall'ultimo messaggio utente nel branch attivo.
- [x] Nessuna provenance model-supplied o fallback vuoto per mutation content-bearing.
- [x] Nessun raw persistent content in tool output/details/log/error.
- [x] Nessun argomento/result storico raw in richieste provider-bound, incluso dopo provider switching.
- [x] Sanitizzazione storica precedente a privacy/KV eligibility e prefix extraction.
- [x] Egress guard attiva anche con privacy disabled.
- [x] `local-only` non esposto a provider remoto.
- [x] Post-append failure non induce rollback o retry cieco.
- [x] Lifecycle summary routine, inclusi gli eventi runtime Pin/Memory condivisi, restano a `debug`; warning/error actionable restano visibili.

## Compatibility

- [x] `/context` invariato.
- [x] `context_artifact_search` invariato.
- [x] Golden stabile `0.2.0` invariato.
- [x] Reference adapter invariato.
- [x] Planner/ranking/KV contracts invariati.
- [x] Feature-disabled latency ratio `<=1.10` conservato.

## Efficiency

- [x] Tool-definition budget misurato.
- [x] Limite `<=1.500` token stimati e `<=1%` smallest tested context rispettato; altrimenti release bloccata.
- [x] `count`, `truncated`, `incomplete` e assenza di `totalCount` rispettano il contratto.
- [x] Result count e preview bounded dalla configurazione/contratto.
- [x] Preview sanitizzata sull'intera sorgente bounded prima della truncation.
- [x] Nessun accumulo non bounded di mapping sourceRef/process state delle revisioni.

## Quality

- [x] Typecheck.
- [x] Unit/integration/privacy/concurrency/rebuild test.
- [x] Long-session test.
- [x] TUI/RPC/print smoke.
- [x] Pack check.
- [x] Exact-version registry verification per la prerelease pubblicata.

---

# 25. Compatibilità, schema e versioning

La baseline è la release stabile:

```text
0.2.0
```

Il nuovo tool introduce superficie pubblica LLM-callable:

```text
tool name
action enum
parameters
confirmation behavior
result schema
privacy behavior
failure outcomes
```

Raccomandazione:

```text
0.3.0-alpha.1
```

La baseline di sviluppo è esclusivamente `0.2.0`, già stabile e pubblicata; la nuova superficie parte dalla linea `0.3.0`.

## 25.1 Contratti 0.2

Restano invariati:

```text
ds4-context-config-v1
SQLite schema 15
runtime-adapter-v1
runtime-history-v1
ds4-context-memory-v1
ds4-context-pin-v1
ranking-features-v1
local-kv-eligibility-v1
local-kv-runtime-port-v1
local-kv-diagnostics-v1
```

## 25.2 Nuovi contratti

```text
ds4-context-persistence-tool-v1
ds4-context-persistence-result-v1
```

`ds4-context-persistence-tool-v1` copre nome/action, schema parametri, `executionMode`, authorization e semantics di dispatch. `ds4-context-persistence-result-v1` copre envelope, outcome e DTO metadata-only. I contratti sono correlati ma versionati indipendentemente.

Entrambi devono essere coperti da golden test prima della prima prerelease. Dopo pubblicazione, una modifica incompatibile richiede un nuovo identificatore del contratto interessato; non riusare `-v1` con semantica differente.

## 25.3 Package versioning

Il release tooling corrente verifica e pubblica in modo coordinato:

```text
ds4-context-core
ds4-context-reference-adapter
ds4-context-engine
```

Per mantenere exact internal dependencies e `registry:check`, la prerelease deve usare `0.3.0-alpha.1` per tutti e tre i package, anche se core e reference adapter ricevono soltanto il bump coordinato e test di compatibilità. `ds4-context-engine` e `ds4-context-reference-adapter` devono dipendere esattamente da `ds4-context-core@0.3.0-alpha.1`.

Un rilascio indipendente del solo package root richiederebbe prima una decisione esplicita e una revisione separata di release tooling, dependency policy e registry verifier; non va improvvisato durante M9.

## 25.4 SQLite

La V1 non richiede una migration per il solo tool. Se l'implementazione dimostra il contrario:

```text
append migration 16
never edit migrations 1-15
```

La canonicalizzazione futura della source exclusion non deve essere infilata implicitamente in una migration projection-only: richiede prima una decisione sul canonical record.

---

# 26. Documentazione da aggiornare

## README

Aggiungere “LLM-callable tools” con:

```text
context_artifact_search
context_persistence
```

Spiegare confirmation requirement e disponibilità no-UI.

## MEMORY_AND_PINS.md

Chiarire:

```text
manual-first = explicit user request + local confirmation for LLM tool writes
```

Specificare che `/context` resta la superficie locale diretta e che DS4 non estrae automaticamente Memory dalla conversazione.

## Nuovo documento

```text
docs/CONTEXT_PERSISTENCE_TOOL.md
```

Contenuti minimi:

- capability e action;
- Pin vs Memory;
- scope;
- read-before-destructive-write;
- targetRevision;
- confirmation;
- provider/privacy behavior;
- no-UI behavior;
- canonical vs derived source policy;
- post-append outcomes;
- troubleshooting;
- relazione con `/context`.

## ARCHITECTURE.md / ADR

Registrare:

1. tool → runtime diretto, non command relay;
2. confirmation locale come authorization boundary V1;
3. tool egress guard indipendente da `privacy.enabled`;
4. source exclusion ancora derived local policy;
5. provenance model-supplied esclusa dalla V1.

## STORAGE.md e PRIVACY.md

Aggiornare soltanto se necessario per chiarire:

- reset delle source exclusions dopo database deletion;
- tool result come provider egress surface;
- metadata allowlist;
- nessuna persistenza della mapping/process state dei sourceRef; il token opaco resta un normale tool-result metadata nel Pi JSONL.

---

# 27. Rollout e release

## Step 1 — Contract-only review

Revisionare schema, threat model, token budget e ADR prima delle write.

## Step 2 — Read-only implementation

Abilitare list/find/sources, verificare privacy e deterministic bounds.

## Step 3 — Write implementation in ordine

```text
confirmation/outcome safety
  ↓
Pin
  ↓
Memory
  ↓
derived source policy
```

## Step 4 — Provider matrix

Provare:

```text
remote provider
local provider
unknown provider
privacy enabled
privacy disabled
```

## Step 5 — Runtime matrix

Provare TUI, RPC, print/JSON, long-session, database rebuild e shared-SQLite concurrency.

## Step 6 — Validation

```bash
npm run check
npm run quality:compare
npm run latency:check
npm run pack:check
npm pack --dry-run
```

## Step 7 — Manual prerelease

Pubblicazione coordinata ed esclusivamente manuale da workstation autenticata:

```text
ds4-context-core@0.3.0-alpha.1
ds4-context-reference-adapter@0.3.0-alpha.1
ds4-context-engine@0.3.0-alpha.1
```

Le dipendenze interne restano exact. GitHub Actions resta validation-only: workflow/reusable workflow dichiarano almeno `contents: read`, `id-token: none` e `packages: none`, non contengono `npm publish`, provenance publish, registry write o token npm. La pubblicazione resta indisponibile dalla CI e avviene solo da workstation autenticata.

## Step 8 — Exact verification

Verificare i package con versione esatta, non con dist-tag mutabili:

```bash
npm run registry:check -- 0.3.0-alpha.1
```

Creare tag/release solo dopo registry check e package smoke verdi.

---

# 28. Evoluzioni future

## 28.1 Tool read/write separati

Adottare se token budget, routing o least-privilege lo richiedono. La decisione può avvenire già in M0, non solo dopo la V1.

## 28.2 Confirmation modes

Possibile config futura:

```text
all
destructive
none
```

`none` deve essere opt-in esplicito e accompagnato da warning di sicurezza.

## 28.3 Canonical source exclusion

Possibile futuro custom mutation dedicato, previa decisione su:

- canonical owner;
- scope project/user;
- replay cross-session;
- conflict resolution;
- privacy;
- migration/rebuild;
- reference adapter parity.

Fino ad allora resta local policy.

## 28.4 Provenance aggiuntiva

La primary provenance automatica V1 resta risolta dallo snapshot verificato del branch tramite `ExtensionContext.sessionManager`; non dipende da un campo model-supplied. Ulteriori source entry potranno essere aggiunte solo se Pi espone un contratto stabile e ogni entry viene validata contro lo stesso snapshot del branch attivo.

## 28.5 Suggestion mode

DS4 può suggerire una possibile Memory/Pin, ma non salvarla senza conferma. È una feature separata con proprio threat model.

## 28.6 Automatic candidate extraction

Non appartiene alla V1. Qualunque pipeline futura deve terminare in proposal + conferma, mai in append automatico.

## 28.7 Search locale evoluta

FTS o semantic local embedding possono essere valutati solo con dataset e metriche. L'exact-target contract resta invariato.

## 28.8 Local selection UI

Per match multipli, una UI locale potrebbe permettere all'utente di scegliere l'elemento senza inviare preview raw al provider. I selection handle resterebbero volatili e non persistiti.

---

# 29. Checklist implementativa

Stato `0.3.0-alpha.1`: implementazione, documentazione, test, pubblicazione manuale, verifica registry esatta, tag e GitHub prerelease completati.

## Design

- [x] Baseline stabile `0.2.0` confermata.
- [x] Nome/action e contratti tool/result congelati.
- [x] `executionMode="sequential"` approvato.
- [x] Tool unico V1 confermato dalle misure; gate bloccante se fallisce.
- [x] DTO, `count`/`truncated`/`incomplete` e assenza di `totalCount` approvati.
- [x] Canonical vs derived semantics approvate.
- [x] Metadata allowlist approvata.
- [x] Confirmation policy approvata.
- [x] Primary provenance automatica e no model-supplied provenance approvate.
- [x] Historical-argument/provider-switching policy approvata.
- [x] Project-file neutrality approvata.
- [x] Post-append outcome model approvato.

## Code

- [x] Contract/schema TypeBox.
- [x] Action-specific validator.
- [x] Deterministic NFKC normalization e read ordering.
- [x] Config-bounded maxResults, pagine 128, scan cap 4.096 e `limit + 1` truncation.
- [x] Always-on egress guard.
- [x] Historical tool-call/result sanitizer in context/provider paths, prima di privacy/KV eligibility e prefix extraction.
- [x] Recursive result leak scan.
- [x] Primary provenance resolver sul branch attivo.
- [x] Classification inheritance/no-downgrade.
- [x] Project-file index refresh bypass.
- [x] Mapping sourceRef e process secret/revision state volatili e bounded.
- [x] `ctx.hasUI` gate.
- [x] `ctx.ui.confirm()`.
- [x] Abort checks.
- [x] Pin actions via runtime.
- [x] Memory actions via runtime.
- [x] Source policy via runtime.
- [x] Typed post-append outcomes.
- [x] Debug-only routine logging.
- [x] Actionable warnings preserved.

## Tests

- [x] Registration/schema budget/execution mode.
- [x] Tool/result golden contracts.
- [x] Action validation/additional properties.
- [x] Runtime state matrix.
- [x] Read bounds/order/normalization/truncation.
- [x] Pin session/branch/project.
- [x] Memory session/project/branch reject.
- [x] Duplicate/conflict.
- [x] Exact target/stale revision.
- [x] Confirmation/cancel/no UI.
- [x] Privacy matrix enabled/disabled/local/remote/unknown.
- [x] Historical call/result, same-provider replay, provider switching e KV ordering.
- [x] local-only misuse e classification downgrade reject.
- [x] No output/details/log/error leak.
- [x] Primary provenance/race/branch validation.
- [x] Project-file neutrality/no index refresh.
- [x] Post-append outcomes.
- [x] Cross-session sourceRef.
- [x] Canonical rebuild.
- [x] Derived-policy reset on rebuild.
- [x] Shared SQLite concurrency.
- [x] Command materialized-state parity.
- [x] Planner/branch behavior.
- [x] Artifact tool regression.
- [x] Golden/migration immutability.
- [x] Long-session/package checks.

## Docs

- [x] README.
- [x] MEMORY_AND_PINS.
- [x] CONTEXT_PERSISTENCE_TOOL.
- [x] DOGFOODING_0.3.0_ALPHA runbook.
- [x] ARCHITECTURE/ADR.
- [x] STORAGE/PRIVACY chiarimenti.
- [x] Release notes.

## Release

- [x] Tutti e tre i package a `0.3.0-alpha.1` con dipendenze interne exact.
- [x] `npm run check`.
- [x] `npm run latency:check` contro l'esatto `ds4-context-core@0.1.2`.
- [x] Tool schema token budget.
- [x] `npm run pack:check`.
- [x] TUI/RPC/print smoke.
- [x] Manual npm publish da workstation autenticata.
- [x] CI validation-only: `id-token: none`, `packages: none`, nessun publish/token npm.
- [x] Exact registry check, senza dist-tag mutabili.
- [x] Tag e prerelease GitHub.
- [x] Nessuna automazione publish in CI.

---

# 30. Fonti tecniche verificate

## DS4 Context Engine

```text
README.md
docs/ARCHITECTURE.md
docs/MEMORY_AND_PINS.md
docs/PRIVACY.md
docs/STORAGE.md
docs/RUNTIME_ADAPTER_KIT.md
docs/LOCAL_KV_REUSE.md
docs/releases/0.2.0.md
src/extension/index.ts
src/extension/commands.ts
src/extension/runtime.ts
src/pi-adapter/memory-adapter.ts
src/pi-adapter/project-memory-sync.ts
packages/core/src/config/config.ts
packages/core/src/config/config-loader.ts
packages/core/src/memory/memory-manager.ts
packages/core/src/memory/memory-types.ts
packages/core/src/privacy/privacy-policy.ts
packages/core/src/persistence/migrations.ts
packages/core/src/persistence/write-coordinator.ts
tests/integration/memory-extension.test.ts
tests/integration/cross-session-memory.test.ts
tests/integration/privacy-extension.test.ts
tests/integration/sqlite-concurrency.test.ts
tests/integration/upgrade-rebuild.test.ts
tests/golden/compatibility-0.2.0.test.ts
```

## Pi `0.84.3`

```text
docs/extensions.md
docs/tui.md
docs/session-format.md
examples/extensions/dynamic-tools.ts
examples/extensions/reload-runtime.ts
examples/sdk/06-extensions.ts
dist/core/extensions/types.d.ts
```

API verificate rilevanti:

```text
pi.registerTool()
defineTool()
promptSnippet
promptGuidelines
execute(toolCallId, params, signal, onUpdate, ctx)
ExtensionContext.hasUI
ExtensionContext.ui.confirm()
ExtensionContext.isProjectTrusted()
ExtensionContext.sessionManager
Tool result content/details
```

---

# Conclusione

La feature è tecnicamente fattibile e riusa quasi tutta la business logic esistente. Il lavoro principale non è implementare nuove primitive di persistenza, ma costruire un adapter LLM-callable che non trasformi una superficie locale in un nuovo canale di leak o mutation non autorizzate.

Il contratto finale deve preservare simultaneamente:

```text
Pi JSONL canonical per Pin/Memory
append-only mutations
SQLite shared, coordinated e rebuildable
source exclusion esplicitamente local/disposable
exact-target destructive writes
local confirmation for every tool write
always-on privacy-safe result egress
no model-supplied provenance
no blind retry after canonical append
0.2 stable contracts untouched
manual-only package publication
```

Con questi gate, `context_persistence` può rendere Memory e Persistent Pins più naturali da usare senza sacrificare le garanzie non distruttive della release stabile `0.2.0`.
