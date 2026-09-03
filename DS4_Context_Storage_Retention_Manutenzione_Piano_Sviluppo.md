# DS4 Context Engine — Piano completo per retention, crescita bounded e manutenzione SQLite

> **Obiettivo:** arrestare la crescita non limitata di `context.db`, ridurre durata e contesa delle scritture, fornire diagnostica storage metadata-only e consentire una compattazione fisica offline sicura, mantenendo Pi JSONL canonico e append-only.
>
> **Baseline verificata:** repository `main` a `eb47d4608459bb75619159acd5ea89b5f4265b3d`, pacchetti `0.3.0-alpha.5`, Pi `0.84.3`, Node.js `>=22.19.0`, schema SQLite `15`.
>
> **Target consigliato per il primo rollout:** prossima prerelease coordinata della linea `0.3.0`, senza modifica dello schema SQLite.
>
> **Stato del documento:** piano di implementazione; non autorizza commit, version bump, pubblicazione o manutenzione del database live.

---

## Indice

1. [Executive summary](#1-executive-summary)
2. [Evidenza e diagnosi corrente](#2-evidenza-e-diagnosi-corrente)
3. [Decisioni architetturali](#3-decisioni-architetturali)
4. [Invarianti non negoziabili](#4-invarianti-non-negoziabili)
5. [Scope](#5-scope)
6. [Non-obiettivi](#6-non-obiettivi)
7. [Architettura target](#7-architettura-target)
8. [Retention online dei Context Manifest](#8-retention-online-dei-context-manifest)
9. [Proiezione persistita bounded del manifest](#9-proiezione-persistita-bounded-del-manifest)
10. [Persistenza della provider usage senza riscrittura del payload](#10-persistenza-della-provider-usage-senza-riscrittura-del-payload)
11. [Retention indipendente della calibrazione](#11-retention-indipendente-della-calibrazione)
12. [Diagnostica storage](#12-diagnostica-storage)
13. [Protocollo di esclusione per manutenzione](#13-protocollo-di-esclusione-per-manutenzione)
14. [Utility di manutenzione offline](#14-utility-di-manutenzione-offline)
15. [Aging degli altri dati derivati](#15-aging-degli-altri-dati-derivati)
16. [Concorrenza, lock e transazioni](#16-concorrenza-lock-e-transazioni)
17. [Privacy, provenance e logging](#17-privacy-provenance-e-logging)
18. [Error handling e fallback](#18-error-handling-e-fallback)
19. [Configurazione e contratti](#19-configurazione-e-contratti)
20. [File da creare o modificare](#20-file-da-creare-o-modificare)
21. [Milestone implementative](#21-milestone-implementative)
22. [Test plan](#22-test-plan)
23. [Gate prestazionali e di storage](#23-gate-prestazionali-e-di-storage)
24. [Procedura di rollout](#24-procedura-di-rollout)
25. [Rollback e recovery](#25-rollback-e-recovery)
26. [Rischi e mitigazioni](#26-rischi-e-mitigazioni)
27. [Criteri di accettazione](#27-criteri-di-accettazione)
28. [Checklist finale](#28-checklist-finale)

---

# 1. Executive summary

La causa principale della crescita osservata non è la cronologia Pi canonica, ma la proiezione diagnostica `context_manifests` nel database SQLite condiviso.

La soluzione raccomandata è composta da cinque livelli complementari:

1. **Retention online incrementale** degli ultimi `128` manifest globali.
2. **Proiezione persistita bounded** dei manifest grandi, riducendo soltanto l'inventario `excluded` e conservando completo tutto ciò che è stato realmente incluso nel prompt.
3. **Provider usage in colonne scalari**, senza riscrivere ogni volta l'intero JSON del manifest.
4. **Diagnostica `/context storage`** read-only e metadata-only.
5. **Utility offline copy-compact-validate-swap**, che recupera lo spazio fisico senza modificare Pi JSONL e senza operare sul database mentre Pi lo usa.

L'intervento mantiene un unico database condiviso. Non introduce un database per sessione, non disabilita la validazione della compaction e non archivia indefinitamente copie di dati derivati.

Il primo rollout resta su schema SQLite `15`. La compressione BLOB dei manifest viene rimandata: è tecnicamente promettente, ma non necessaria per risolvere il problema corrente e aumenterebbe superficie di migrazione, downgrade e recovery.

---

# 2. Evidenza e diagnosi corrente

## 2.1 Stato osservato

Sul database:

```text
~/.pi/agent/ds4-context/context.db
```

sono stati osservati:

```text
SQLite pages:                 523,353
Page size:                    4,096 byte
Free pages:                   203
Indexed sessions:            39
Context manifests:            3,358
Serialized manifest bytes:   1,796,259,648
Largest manifest_json:         981,476 byte
```

`context_manifests` occupa circa `1.8 GB` ed è il contributore dominante alla dimensione del database.

Due sessioni storiche contengono rispettivamente `2,209` e `1,075` manifest. Il problema è quindi accumulativo e cross-session, non limitato alla sessione Pi attiva.

## 2.2 Anatomia di un manifest recente

Una misura read-only su un manifest recente ha prodotto:

```text
manifest_json totale:       878,579 byte
included:                    24,560 byte / 88 elementi
excluded:                   841,095 byte / 5,915 elementi
```

L'array `excluded` rappresenta circa il `95.7%` del payload. Questo rende possibile una riduzione sostanziale senza perdere l'inventario completo del contesto realmente inviato al modello.

## 2.3 Lock osservato

È stato segnalato un errore SQLite lock dopo l'installazione e apertura di `0.3.0-alpha.5`. L'evidenza disponibile non dimostra una singola causa originaria.

Sono però verificati fattori che possono aumentare la probabilità o durata della contesa:

- database WAL condiviso fra processi Pi;
- scrittura di manifest prossimi a `1 MB`;
- successiva riscrittura del medesimo JSON per aggiungere la provider usage;
- migliaia di righe storiche da eliminare gradualmente;
- database prossimo al proprio high-water fisico.

Il piano tratta questi fattori senza affermare che uno di essi sia stato provato come causa esclusiva.

## 2.4 Compressione valutata ma non scelta per il primo rollout

Una misura locale read-only su un manifest da circa `876 KB` ha rilevato:

```text
deflate raw:                  circa 63 KB
rapporto:                     circa 7.2%
compressione media:           circa 4.2 ms
decompressione media:         circa 1.2 ms
```

La compressione è quindi un'ottimizzazione futura plausibile. Non viene inclusa nel primo rollout perché richiederebbe un nuovo formato persistito o schema SQLite, gestione downgrade e limiti sicuri di decompressione. La proiezione bounded dell'inventario `excluded` ottiene gran parte del beneficio mantenendo schema `15` e leggibilità JSON.

---

# 3. Decisioni architetturali

## D1 — Database unico condiviso

Conservare:

```text
~/.pi/agent/ds4-context/context.db
```

come unica proiezione SQLite condivisa fra sessioni Pi.

Non introdurre database per sessione o per progetto.

## D2 — Pi JSONL resta canonico

Conversazioni, Pin, Memory, ranking feedback e compaction entry restano canonici nei Pi JSONL append-only.

SQLite continua a essere:

```text
derivato + ricostruibile + sostituibile
```

## D3 — Retention globale dei manifest

Conservare gli ultimi `128` manifest globali, ordinati per:

```text
created_at DESC, rowid DESC
```

La retention globale limita realmente il contributo totale dei manifest. Una retention per sessione moltiplicherebbe il limite per il numero di sessioni indicizzate.

## D4 — Calibrazione indipendente

Conservare fino a `200` campioni per profilo esatto:

```text
provider + model + estimator_version
```

La cancellazione del manifest non deve eliminare un campione recente ancora utile.

## D5 — Nessuna purge lunga all'avvio

La normale apertura del runtime non deve eseguire una pulizia completa delle migliaia di righe pregresse.

La convergenza online avviene in piccoli batch durante scritture correlate. Il recupero fisico immediato è affidato a manutenzione offline esplicita.

## D6 — Manifest runtime completo, proiezione persistita eventualmente bounded

Il manifest mantenuto in memoria per la chiamata corrente resta completo.

Se il payload persistito supera la soglia preferita, soltanto il dettaglio di `excluded` viene ridotto. `included` e le provenance degli elementi selezionati restano complete.

## D7 — Mai degradare il model request per diagnostica storage

Un errore di persistenza o retention del manifest:

- non modifica il prompt;
- non annulla la chiamata provider;
- non disabilita Pi fallback;
- non installa summary non validate;
- produce soltanto diagnostica categoriale locale.

## D8 — Manutenzione solo offline

La riduzione fisica del database non viene eseguita:

- all'avvio;
- durante una model call;
- tramite tool LLM-callable;
- mentre una sessione Pi dichiara il database aperto.

## D9 — Nessun archivio illimitato

La manutenzione mantiene al massimo un backup pre-compaction con nome fisso. Se il backup esiste già, l'utility rifiuta di sovrascriverlo.

---

# 4. Invarianti non negoziabili

## 4.1 Persistenza canonica

- Pi JSONL rimane append-only.
- Nessuna manutenzione riscrive o elimina Pi JSONL.
- Nessuna manutenzione modifica file del progetto.
- Pin e Memory canonici continuano a passare da `Ds4ContextRuntime` e `pi.appendEntry()`.
- Le source policy locali restano derivate in SQLite e devono essere preservate dalla compattazione copy-based.

## 4.2 Sicurezza delle write LLM-callable

La manutenzione storage non viene esposta attraverso `context_persistence` o altri tool LLM-callable.

Le regole esistenti restano invariate:

- conferma UI locale fresca per ogni write LLM-callable;
- fail closed senza UI o persistenza canonica;
- exact ID/source reference e `targetRevision` per mutation distruttive;
- nessun booleano di conferma fornito dal modello.

## 4.3 Privacy

- Nessun prompt o contenuto completo nei manifest.
- Nessun valore exact rifiutato nei log.
- Nessun SQL, bound value o raw SQLite message nei lock diagnostic.
- `/context storage` espone solo metadata locali.
- Nessuna telemetria esterna.

## 4.4 Compaction

- `compaction.validate` resta attiva.
- Matching tool call/result resta atomico.
- Summary non valide continuano a delegare a Pi.
- Retry provider consentito soltanto per categoria `transport`.
- La modifica storage non cambia `firstKeptEntryId`, provenance o formato canonico delle Pi compaction entry.

## 4.5 Concorrenza

- Tutte le write SQLite online passano da `SqliteWriteCoordinator`.
- Ogni batch è bounded per righe e byte.
- SQLite resta arbitro cross-process.
- Timeout e retry restano finiti.

---

# 5. Scope

Il piano include:

- stabilizzazione delle modifiche già presenti nel working tree per retry compaction, retention e lock diagnostics;
- limite globale ai manifest persistiti;
- limite in byte al payload persistito;
- rollup deterministico dell'array `excluded`;
- provider usage in colonne scalari senza riscrittura del JSON;
- retention per-profile della calibrazione;
- diagnostica storage locale;
- protocollo locale per impedire manutenzione concorrente;
- utility offline di inspect, compact e recover;
- test unitari, integrazione, concorrenza, upgrade/rebuild e fault injection;
- documentazione, rollout, rollback e release gate;
- fase successiva per aging degli altri dati derivati.

---

# 6. Non-obiettivi

Non fanno parte del primo rollout:

- separazione del database per sessione;
- modifica del formato canonico Pi JSONL;
- cancellazione della cronologia Pi;
- `VACUUM` automatico online;
- backfill lungo all'avvio;
- compressione BLOB/gzip dei manifest;
- modifica delle migration `1–15`;
- nuova estrazione automatica di Pin o Memory;
- indebolimento della privacy o del summary validator;
- cancellazione automatica di artifact ancora referenziati;
- eviction automatica di session index prima di una strategia verificata di reidratazione on-demand;
- pubblicazione npm o creazione release automatica.

---

# 7. Architettura target

```text
before model call
      │
      ▼
ContextManifest completo in memoria
      │
      ├── prompt/planning invariati
      │
      └── buildPersistedManifestProjection()
              │
              ├── <= 256 KiB: proiezione completa
              │
              ├── > 256 KiB: excluded rollup + sample
              │
              └── > 1 MiB dopo rollup: skip persistence
                      │
                      ▼
          ContextManifestRepository.save()
                      │
                      ├── INSERT/UPSERT
                      ├── prune <= 32 righe e <= 8 MiB
                      └── COMMIT via SqliteWriteCoordinator

message_end
      │
      ▼
UPDATE sole colonne usage
      │
      ├── INSERT token_calibration
      ├── prune <= 32 calibration stale
      └── nessuna riscrittura manifest_json

/context storage
      │
      └── PRAGMA e aggregate metadata-only, read-only

offline maintenance CLI
      │
      ├── maintenance lock
      ├── active-client refusal
      ├── checkpoint e close
      ├── working copy
      ├── retention + bounded rewrite sulla copia
      ├── VACUUM INTO candidate
      ├── quick_check + foreign_key_check
      └── recoverable swap con backup
```

---

# 8. Retention online dei Context Manifest

## 8.1 Limiti

```text
MAX_RETAINED_CONTEXT_MANIFESTS = 128
RETENTION_PRUNE_BATCH_ROWS      = 32
RETENTION_PRUNE_BATCH_BYTES     = 8 MiB
```

Il batch termina quando raggiunge il primo dei due limiti:

- `32` righe;
- `8 MiB` di `manifest_json` selezionato.

Se la singola riga più vecchia supera `8 MiB`, eliminarne comunque una per garantire progresso.

## 8.2 Motivo del doppio limite

Il solo limite di `32` righe è insufficiente quando ogni riga misura quasi `1 MB`: una singola transazione potrebbe eliminare decine di megabyte e trattenere il writer lock più a lungo del necessario.

Il limite in byte rende prevedibile il lavoro di ogni transazione.

## 8.3 Ordinamento

Selezionare i candidati con:

```sql
ORDER BY created_at ASC, rowid ASC
```

Il `rowid` è il tie-break deterministico per timestamp uguali.

## 8.4 Atomicità con calibrazione

Nella stessa transazione:

1. selezionare gli ID stale;
2. impostare `token_calibration.manifest_id = NULL` per quei manifest;
3. eliminare i manifest;
4. commit.

In caso di errore, rollback completo.

## 8.5 Convergenza

Con `3,358` righe storiche e target `128`, la pulizia online richiede più scritture correlate. Questo è intenzionale: il runtime resta responsivo e non esegue un lungo blocco iniziale.

La manutenzione offline fornisce la convergenza immediata quando desiderata.

## 8.6 Pending manifest

I manifest non ancora correlati a una provider usage non ricevono protezione illimitata. Restano soggetti al limite globale.

Se un manifest viene rimosso prima di `message_end` a causa di eccezionale concorrenza cross-process:

- la usage viene mantenuta come calibrazione volatile in memoria quando possibile;
- nessuna seconda correlazione viene tentata;
- il model result non viene modificato.

---

# 9. Proiezione persistita bounded del manifest

## 9.1 Limiti

```text
PREFERRED_PERSISTED_MANIFEST_BYTES = 256 KiB
HARD_PERSISTED_MANIFEST_BYTES      =   1 MiB
MAX_RETAINED_EXCLUDED_DETAILS      = 256
```

I limiti sono calcolati sui byte UTF-8, non sulle code unit JavaScript.

## 9.2 Regola di persistenza

1. Serializzare il manifest completo.
2. Se `<= 256 KiB`, salvarlo completo.
3. Se `> 256 KiB`, creare una proiezione bounded di `excluded`.
4. Serializzare nuovamente.
5. Se `<= 1 MiB`, salvarla.
6. Se `> 1 MiB`, non persistere il manifest e restituire `skipped-oversize`.

Non troncare mai silenziosamente.

## 9.3 Elementi sempre completi

La proiezione persistita conserva integralmente:

- header e identificatori del manifest;
- provider/model e budget;
- `included`;
- `summaryIds`;
- `retrievedEventIds`;
- `projectSnippets`;
- project revision bounded già prodotta dal runtime;
- `pins`;
- `memories`;
- `artifacts`;
- privacy metadata;
- model-awareness metadata;
- ranking diagnostics;
- native-continuation metadata;
- composition e planning;
- policy/planner version;
- `promptHash`;
- timestamp.

Se questi campi, senza inventario `excluded` completo, superano il limite hard, la persistenza viene saltata anziché perdere provenance inclusa.

## 9.4 Sampling deterministico di `excluded`

Conservare al massimo `256` elementi:

```text
primi 128 in ordine originale
+
ultimi 128 in ordine originale
```

Rimuovere eventuali duplicati di indice quando il totale è inferiore a `256`.

Questa strategia è:

- deterministica;
- indipendente da random seed;
- economica;
- rappresentativa sia dell'inizio sia della fine dell'inventario.

## 9.5 Rollup completo

Aggiungere metadata espliciti, per esempio:

```typescript
interface PersistedManifestInventory {
  schema: "ds4-context-manifest-inventory-v1";
  completeness: "complete" | "excluded-rollup";
  sourceBytes: number;
  included: {
    total: number;
    retained: number;
    complete: true;
  };
  excluded: {
    total: number;
    retained: number;
    omitted: number;
    tokens: number;
    digest: string;
    byKind: Partial<Record<ContextManifestItemKind, {
      items: number;
      tokens: number;
    }>>;
    byClassification: Partial<Record<PrivacyClassification | "unspecified", number>>;
    reasonDigest: string;
  };
}
```

Non creare una mappa non bounded dei reason. I reason completi restano soltanto nei dettagli campionati; la sequenza completa viene rappresentata dal totale `excluded` e da un digest incrementale length-prefixed, senza materializzare un secondo array o `Set` dei reason.

## 9.6 Digest

Calcolare SHA-256 su una serializzazione stabile di tutti gli elementi `excluded` originali.

Il digest:

- è separato da `promptHash`;
- non altera il prompt;
- non viene inviato automaticamente al provider;
- serve a verificare che due rollup derivino dallo stesso inventario;
- non sostituisce la provenance completa degli elementi inclusi.

## 9.7 Contratto di lettura

Il repository non deve restituire un array sampled come se fosse completo senza segnalarlo.

Introdurre un risultato esplicito:

```typescript
interface StoredContextManifest {
  manifest: ContextManifest;
  inventory: PersistedManifestInventory;
}
```

Per righe legacy prive di metadata:

```text
completeness = complete
sourceBytes = byteLength(manifest_json)
```

Le API di rendering devono mostrare chiaramente:

```text
Excluded details: 256 / 5,915 retained in persisted projection
```

Il manifest corrente in memoria resta completo, quindi `/context excluded` nella sessione attiva può continuare a mostrare i risultati bounded dal renderer esistente senza dipendere dalla proiezione storica.

## 9.8 Esito di save

Cambiare `save()` da `void` a un risultato categoriale:

```typescript
type ManifestSaveResult =
  | {
      status: "stored";
      completeness: "complete" | "excluded-rollup";
      sourceBytes: number;
      storedBytes: number;
      prunedManifests: number;
      prunedBytes: number;
    }
  | {
      status: "skipped-oversize";
      sourceBytes: number;
      projectedBytes: number;
    };
```

Nessun contenuto del manifest compare nel risultato diagnostico.

## 9.9 Comportamento oversize

Quando anche la proiezione supera `1 MiB`:

- non inserire la riga;
- mantenere il manifest completo soltanto in memoria;
- marcare il pending manifest come non persistito;
- usare calibrazione volatile al `message_end`;
- emettere una sola diagnostica metadata-only.

Evento suggerito:

```text
context.manifest_persistence_skipped
```

Metadata ammessi:

```text
category=oversize
sourceBytes
projectedBytes
includedCount
excludedCount
hardLimitBytes
```

---

# 10. Persistenza della provider usage senza riscrittura del payload

## 10.1 Problema corrente

Il repository oggi:

1. legge `manifest_json`;
2. lo deserializza;
3. aggiunge `actualInputTokens` e `providerUsage`;
4. riscrive l'intero JSON.

Con manifest prossimi a `1 MB`, questa operazione aumenta write amplification e durata del writer lock.

## 10.2 Colonne già disponibili

Lo schema `15` contiene già:

```text
actual_tokens
input_tokens
cache_read_tokens
cache_write_tokens
```

Queste colonne devono diventare autorevoli per la usage persistita.

## 10.3 Nuovo flusso

`recordProviderUsage()` esegue:

1. query delle sole colonne scalari necessarie:
   - provider;
   - model;
   - estimated_tokens;
   - actual_tokens;
2. se già correlato, ritorna `already-recorded`;
3. aggiorna le quattro colonne usage;
4. inserisce il campione di calibrazione;
5. applica retention calibrazione;
6. non modifica `manifest_json`.

## 10.4 Hydration in lettura

`get()` e `getLatest()`:

1. leggono JSON e colonne usage;
2. deserializzano il payload;
3. sovrappongono le colonne autorevoli:
   - `actualInputTokens`;
   - `providerUsage`;
4. restituiscono il record con completeness esplicita.

Le righe legacy che contengono usage anche nel JSON restano leggibili. Se le colonne non sono `NULL`, prevalgono sempre.

## 10.5 Estimator version

Il runtime conosce già l'estimator effettivo nel manifest in memoria. Passarlo esplicitamente a `recordProviderUsage()` per evitare di leggere/parsing il JSON durante la write.

Il repository valida il valore come identificatore bounded. In assenza del parametro per una chiamata legacy, usa il fallback esistente `chars-v1`.

## 10.6 Runtime state

Il runtime non deve sostituire il manifest completo in memoria con la proiezione bounded ritornata dal repository.

Aggiorna localmente soltanto:

```text
actualInputTokens
providerUsage
```

e mantiene invariati gli array completi del manifest corrente.

---

# 11. Retention indipendente della calibrazione

## 11.1 Limite

```text
MAX_RETAINED_CALIBRATION_SAMPLES_PER_PROFILE = 200
CALIBRATION_PRUNE_BATCH_ROWS                 = 32
```

## 11.2 Profilo esatto

La partizione è:

```text
provider + model + estimator_version
```

Non aggregare provider o modelli differenti.

## 11.3 Ordinamento

```sql
ORDER BY created_at DESC, calibration_id DESC
```

## 11.4 Manifest cancellato

Prima di eliminare un manifest:

```sql
UPDATE token_calibration
SET manifest_id = NULL
WHERE manifest_id IN (...)
```

La calibrazione conserva tutti i propri valori scalari e resta utilizzabile.

## 11.5 Garanzie

- campioni duplicati non vengono aggiunti;
- usage zero, missing, aborted o non correlata non produce campioni;
- valori non safe integer vengono rifiutati;
- la retention di un profilo non elimina campioni di altri profili.

---

# 12. Diagnostica storage

## 12.1 Nuovo comando

Aggiungere:

```text
/context storage
```

Il comando è read-only, locale e non viene esposto come tool LLM-callable.

## 12.2 DTO runtime

Introdurre un DTO bounded:

```typescript
interface StorageDiagnostics {
  status: "ok" | "warning" | "unavailable";
  schemaVersion?: number;
  journalMode?: string;
  pageSize?: number;
  pageCount?: number;
  freePages?: number;
  allocatedBytes?: number;
  reusableBytes?: number;
  walBytes?: number;
  shmBytes?: number;
  manifests: {
    rows: number;
    serializedBytes: number;
    retainedLimit: number;
    preferredBytes: number;
    hardBytes: number;
    rolledUpRows: number;
  };
  calibration: {
    rows: number;
    profiles: number;
    retainedPerProfile: number;
  };
  sessions: number;
  activeProject?: {
    files: number;
    snippets: number;
    staleSnippets: number;
    indexedTokens: number;
  };
  artifacts: ArtifactStats;
  retention: {
    manifestExcess: number;
    calibrationExcess: number;
    converged: boolean;
  };
  maintenance: {
    recommended: boolean;
    reasons: string[];
  };
}
```

## 12.3 Query bounded

Il comando non deve eseguire `dbstat` o scansioni di contenuto su ogni chiamata.

Sono ammessi:

- `PRAGMA page_size`;
- `PRAGMA page_count`;
- `PRAGMA freelist_count`;
- `PRAGMA journal_mode`;
- `COUNT(*)` su tabelle indicizzate/bounded;
- `SUM(length(manifest_json))` su `context_manifests`, che dopo retention è bounded a `128` righe;
- conteggi calibrazione e profili;
- `stat` filesystem per DB/WAL/SHM;
- statistiche già disponibili per artifact e progetto attivo.

Se il database non è ancora convergente, la query sui manifest attraversa comunque soltanto la tabella diagnostica; deve essere misurata e avere timeout/fallback categoriale.

## 12.4 Warning iniziali

Segnalare maintenance consigliata quando almeno una condizione è vera:

```text
allocatedBytes >= 1 GiB
reusableBytes / allocatedBytes >= 25%
manifest rows > 128
manifest serialized bytes > 128 MiB
```

Il warning di dimensione non mette automaticamente il runtime in fase `degraded`; indica un problema operativo, non una violazione del prompt.

## 12.5 Output UI

Esempio:

```text
DS4 Storage

Schema / journal:          15 / wal
Database / WAL:            2.00 GiB / 12.4 MiB
Reusable pages:            203 (812 KiB)
Manifests:                 3,358 / target 128
Manifest payload:          1.67 GiB
Rolled-up manifests:       0
Calibration samples:       3,358 / 4 profiles
Retention converged:       no
Offline maintenance:       recommended
Reason:                    manifest-retention-excess
```

Non mostrare SQL, contenuto manifest o testo provider.

## 12.6 Integrazione con health

`/context health` aggiunge:

```text
Storage status: ok|warning|unavailable
Maintenance recommended: yes|no
```

Un warning storage non rende `health.ok=false` se quick check, foreign key e schema sono validi. Deve però rendere visibile lo stato `WARN` complessivo.

---

# 13. Protocollo di esclusione per manutenzione

## 13.1 Necessità

Rinominare o sostituire un file SQLite mentre un processo mantiene una connessione aperta può creare split-brain: il processo esistente continua a scrivere il vecchio inode mentre nuovi processi aprono il nuovo file.

La sola assenza di una transazione attiva non basta.

## 13.2 File di protocollo

Accanto al database usare:

```text
context.db.clients/
  <client-id>.json
context.db.maintenance.lock
context.db.maintenance-state.json
```

La directory eredita protezione locale `0700`; i file usano `0600` dove supportato.

Non contengono prompt o contenuto utente.

## 13.3 Client lease runtime

Ogni processo Pi che vuole aprire il database:

1. controlla che `maintenance.lock` non esista;
2. crea con `O_EXCL` un client lease casuale contenente:
   - protocol version;
   - client ID;
   - PID;
   - creation time;
   - database path fingerprint;
3. ricontrolla `maintenance.lock`;
4. se il lock è apparso, rimuove il lease e non apre SQLite;
5. apre il database;
6. rimuove il lease a `session_shutdown` dopo `database.close()`.

Se il processo termina in modo anomalo, il lease può restare stale.

## 13.4 Maintenance lock

L'utility offline:

1. crea `maintenance.lock` con `O_EXCL`;
2. esegue fsync del file e della directory;
3. scansiona i client lease;
4. verifica i PID attivi;
5. se almeno un client è vivo, rimuove il proprio lock e rifiuta l'operazione;
6. rimuove lease stale soltanto dopo verifica che il PID non esista;
7. mantiene il lock fino a conclusione o rollback.

Un PID riutilizzato può causare un falso blocco, non un falso via libera: è il comportamento sicuro.

## 13.5 Compatibilità con versioni precedenti

Le versioni precedenti non creano client lease. Per questo il primo utilizzo dell'utility deve richiedere conferma locale esplicita che tutte le istanze Pi siano chiuse.

Su Linux il runbook può suggerire una verifica esterna read-only con:

```text
fuser -v context.db context.db-wal context.db-shm
```

L'utility non termina processi automaticamente.

## 13.6 Runtime durante maintenance

Se Pi viene aperto mentre il maintenance lock è presente:

- DS4 non apre SQLite;
- entra nel fallback/degraded già previsto;
- Pi continua senza DS4 managed persistence;
- viene mostrato un warning metadata-only `database-maintenance-active`;
- nessun tentativo rimuove il lock altrui.

---

# 14. Utility di manutenzione offline

## 14.1 Interfaccia proposta

Pubblicare una CLI locale:

```text
ds4-context-storage inspect --database <exact-path>
ds4-context-storage compact --database <exact-path>
ds4-context-storage recover --database <exact-path>
```

Il path è obbligatorio per `compact` e `recover`. Non inferire silenziosamente un database differente.

## 14.2 Conferma

`compact` mostra:

- exact path;
- schema;
- dimensione DB/WAL;
- manifest da eliminare;
- calibrazioni da eliminare;
- spazio libero richiesto;
- path del backup;
- dichiarazione che Pi deve essere chiuso.

Richiede una conferma TTY locale. La V1 non espone `--yes` non interattivo.

## 14.3 Preflight

Prima di scrivere:

1. risolvere e normalizzare il path;
2. rifiutare directory, device, socket o path non regolare;
3. rifiutare stage/backup già esistenti;
4. acquisire maintenance lock;
5. rifiutare client attivi;
6. aprire il database e verificare:
   - `PRAGMA quick_check = ok`;
   - `PRAGMA foreign_keys = 1`;
   - `PRAGMA user_version = 15` o versione esplicitamente supportata;
   - migration checksums noti;
7. chiudere la connessione di verifica senza eseguire checkpoint o altre write sulla sorgente;
8. verificare spazio libero;
9. creare un backup SQLite consistente e standalone tramite `node:sqlite.backup()` da una connessione sorgente read-only;
10. aprire e validare il backup prima di proseguire.

`backup()` include lo stato committed visibile attraverso WAL senza richiedere una modifica preliminare del database sorgente. Il destination path deve essere assente; l'utility rifiuta di sovrascrivere un backup esistente.

## 14.4 Spazio libero

La strategia copy-based richiede spazio per:

```text
working copy + compact candidate + safety margin
```

La CLI calcola una stima conservativa e rifiuta se non c'è spazio sufficiente. Non inizia confidando che il file finale sarà molto più piccolo.

Safety margin iniziale:

```text
max(256 MiB, 10% della dimensione sorgente)
```

Lo spazio richiesto comprende sia il backup standalone sia working copy e candidate. La CLI usa la dimensione sorgente come bound conservativo e non assume in anticipo il rapporto di compattazione.

## 14.5 Working copy

Creare nella stessa directory, con nomi fissi e `O_EXCL`:

```text
context.db.maintenance-work
context.db.compact-ready
context.db.precompact.bak
```

La working copy viene creata dal backup standalone verificato, con copy esclusiva e senza riaprire la sorgente in write mode.

Il database sorgente e i suoi sidecar restano byte-for-byte invariati durante backup, prune e vacuum; vengono rinominati soltanto nella fase di swap già autorizzata.

## 14.6 Trasformazioni sulla copia

Sulla working copy:

1. applicare retention manifest fino a `128` senza limite online di batch;
2. scollegare prima la calibrazione dai manifest da eliminare;
3. applicare retention `200` per profilo;
4. riscrivere i manifest retained usando la proiezione bounded;
5. eliminare orphan artifact metadata già non referenziato soltanto se il file object è anch'esso classificato orphan;
6. non eliminare sessioni, Pin, Memory, project index o summary nel primo rollout;
7. eseguire `PRAGMA optimize` se bounded e supportato;
8. chiudere la working copy.

Tutte le write sulla copia usano API core e `SqliteWriteCoordinator`; la CLI non contiene query di mutation duplicate.

## 14.7 Vacuum candidate

Dalla working copy eseguire:

```sql
VACUUM INTO ?
```

Usare un bound parameter per il destination path se supportato dalla versione SQLite inclusa in Node. Se la build richiede una diversa forma sintattica, usare esclusivamente una routine interna di quoting SQLite testata con path avversariali; nessun testo provider o frammento SQL arbitrario può raggiungere la query.

## 14.8 Verifica candidate

Aprire `context.db.compact-ready` e verificare:

- `quick_check`;
- `foreign_key_check` senza righe;
- schema e migration checksums;
- conteggio manifest `<=128`;
- calibrazione `<=200` per ogni profilo;
- nessun manifest oltre `1 MiB`;
- source exclusions presenti con gli stessi conteggi e chiavi della sorgente;
- conteggi di sessioni, entries, Pin, Memory, summary, project state e artifact reference invariati, eccetto le categorie esplicitamente prunate;
- permessi `0600` dove supportato.

Confrontare conteggi e digest metadata, mai contenuto in output.

## 14.9 Swap recuperabile

Scrivere `maintenance-state.json` prima dello swap:

```text
phase=candidate-validated
source=context.db
candidate=context.db.compact-ready
backup=context.db.precompact.bak
retired=context.db.swap-old
```

Poi:

1. rinominare `context.db` in `context.db.swap-old`;
2. rinominare eventuali `context.db-wal` e `context.db-shm` nei corrispondenti sidecar `swap-old`;
3. aggiornare e fsync lo state a `source-retired`;
4. rinominare candidate in `context.db`;
5. fsync del nuovo file e directory;
6. aprire e ripetere quick check minimo;
7. aggiornare state a `completed`;
8. rimuovere working copy, `swap-old` e relativi sidecar;
9. rimuovere maintenance lock;
10. conservare il backup standalone.

Spostare i sidecar prima di installare il candidate impedisce che un WAL appartenente alla sorgente venga applicato al nuovo file. Se il rename del candidate o il check finale fallisce, ripristinare immediatamente `swap-old` e i suoi sidecar. Il backup standalone resta una seconda via di recovery.

## 14.10 Backup

La CLI non sovrascrive:

```text
context.db.precompact.bak
```

L'utente lo elimina manualmente soltanto dopo un periodo di dogfooding riuscito. In questo modo non si crea una nuova crescita da archivi storici multipli.

## 14.11 Recover

`recover` legge esclusivamente lo state file e propone una delle azioni deterministiche:

- ripristinare backup;
- completare installazione candidate già validata;
- rimuovere soltanto stage non installati;
- rifiutare se lo stato è ambiguo.

Non indovina mai quale file sia corretto. Ogni candidate viene ricontrollato prima dell'uso.

## 14.12 Output

La CLI stampa soltanto:

- fasi;
- dimensioni;
- conteggi;
- schema;
- check status;
- exact local paths scelti dall'utente;
- istruzioni di recovery.

Non stampa righe manifest, claims, Pin, snippet, tool result o SQL.

---

# 15. Aging degli altri dati derivati

## 15.1 Principio

La retention dei manifest risolve il contributore dominante. L'aging generale viene introdotto soltanto dopo diagnostica e misura, tabella per tabella.

Non applicare un `DELETE` LRU generico all'intero database.

## 15.2 Classificazione

| Categoria | Esempi | Prima policy |
| --- | --- | --- |
| diagnostica derivata | manifest, quality sample | retention hard |
| calibrazione piccola | token calibration | retention per profilo |
| indice ricostruibile | entries, FTS, project snippets | aging solo con reidratazione |
| proiezione canonica | Pin, Memory, mutations | non eliminare alla cieca |
| cache content-addressed | artifact object, embedding | prune solo se orphan/stale verificato |
| lease | resource/client lease | cleanup stale verificato |

## 15.3 Session index

Non eliminare automaticamente righe `sessions` nel primo rollout. La foreign-key cascade coinvolge:

- entries e FTS;
- summary sources;
- memory/pin projection;
- mutation projection;
- project-memory source metadata;
- manifest.

Prima di abilitare eviction servono:

1. catalogo leggero dei JSONL canonici;
2. reidratazione on-demand bounded;
3. protezione sessione attiva;
4. ricostruzione verificata di Pin e Memory;
5. test cross-session retrieval dopo eviction/reload.

Target da validare in dogfooding, non ancora default:

```text
max indexed sessions: 250
max searchable session text: 256 MiB
```

Se uno dei limiti viene superato, l'eviction deve essere LRU per sessione inattiva e mai cancellare il JSONL.

## 15.4 Project index

Un project index è ricostruibile dai file live, ma `indexed_at` rappresenta oggi l'ultimo indice, non necessariamente l'ultimo accesso.

Prima dell'aging:

- introdurre `last_accessed_at` o equivalente derivato;
- proteggere il progetto corrente;
- acquisire il project lease;
- cancellare un progetto intero atomicamente tramite `clearProject()`;
- verificare reindex automatico alla riapertura.

Target da misurare:

```text
max inactive project indexes: 8
project-index warning budget: 512 MiB logical estimate
```

## 15.5 Artifact

Nel primo rollout:

- conservare artifact referenziati;
- eliminare soltanto object senza reference verificata;
- mantenere la cancellazione filesystem dopo la decisione DB e con recovery idempotente;
- non usare l'età come unico criterio per cancellare un artifact referenziato.

Una quota globale futura richiede prima la prova che il full tool result sia ricostruibile dalla sorgente canonica in tutti i percorsi.

## 15.6 Embedding

Continuare a rimuovere embedding quando la loro sorgente canonica derivata non esiste più. Aggiungere diagnostica per:

- source missing;
- stale profile;
- provider/model/version non più attivi.

Il prune resta bounded e non invoca provider remoti.

## 15.7 Summary

Non eliminare summary committed raggiungibili da Pi compaction entry.

È possibile valutare separatamente:

- batch `prepared` scaduti;
- nodi `failed` oltre una retention diagnostica;
- nodi non raggiungibili e ricostruibili.

Ogni prune deve preservare il graph closure e passare test di rebuild.

## 15.8 High-water globale

Aggiungere inizialmente soltanto warning:

```text
logical/allocated database warning: 1 GiB
```

Non effettuare auto-eviction globale finché session, project e artifact non dispongono ciascuno di una policy sicura e testata.

---

# 16. Concorrenza, lock e transazioni

## 16.1 Write coordinator

Mantenere:

```text
busy timeout:          5,000 ms
write retry window:   30,000 ms
```

Le retry ripetono l'intera transazione in un nuovo `BEGIN IMMEDIATE`.

## 16.2 Operazioni nominate

Nomi proposti:

```text
context-manifest-save
context-manifest-provider-usage
context-manifest-maintenance-prune
context-calibration-maintenance-prune
storage-checkpoint
storage-candidate-rewrite
```

Devono passare il sanitizer degli operation name.

## 16.3 Idempotenza

Le callback retryable devono essere idempotenti rispetto al rollback:

- nessuna write filesystem dentro una transaction retryable online;
- upsert deterministici;
- prune basato su ID selezionati nella stessa transazione;
- calibration inserita una sola volta per manifest correlato;
- nessun side effect esterno prima del commit.

## 16.4 Lock timeout diagnostic

Conservare evento:

```text
database.write_lock_timeout
```

Campi ammessi:

```text
operation
category=lock-timeout
attempts
elapsedMs
busyTimeoutMs
retryTimeoutMs
sqliteCode
```

Nessun raw error message SQLite.

## 16.5 Retention failure

Se il manifest è stato inserito ma il prune fallisce nella stessa transaction, l'intera operazione effettua rollback. Il runtime mantiene il manifest in memoria e continua con Pi.

Non separare insert e prune in due transazioni che possano lasciare il limite violato dopo un successo parziale, salvo una futura ADR esplicita.

---

# 17. Privacy, provenance e logging

## 17.1 Contenuto del manifest

La proiezione bounded non aggiunge contenuto nuovo. Continua a escludere:

- prompt text;
- messaggi;
- Pin content;
- Memory claim;
- snippet content;
- artifact content;
- tool arguments/result;
- API key/header;
- provider state handles;
- exact values rifiutati dal summary validator.

## 17.2 Provenance inclusa

Tutto ciò che è stato incluso nel prompt conserva provenance completa nel manifest persistito.

Il rollup riguarda soltanto elementi non inviati al modello.

## 17.3 Completezza dichiarata

Ogni renderer o API che legge una proiezione deve propagare:

```text
complete
excluded-rollup
```

Mai presentare il sample come inventario completo.

## 17.4 Log

Eventi aggiuntivi:

```text
context.manifest_persisted
context.manifest_persistence_skipped
database.retention_progress
database.storage_high_water
database.maintenance_active
```

`context.manifest_persisted` resta `debug`; retention progress viene rate-limited per non produrre un log per ogni riga eliminata.

## 17.5 Path

L'exact database path può essere mostrato nella UI locale `/context storage` e nella CLI esplicitamente invocata dall'utente.

Nei log strutturati preferire un path fingerprint o il basename, salvo il comportamento già documentato di `database.opened`.

---

# 18. Error handling e fallback

## 18.1 Matrice

| Failure | Comportamento |
| --- | --- |
| serializzazione manifest | skip persistenza, context invariato |
| projection oversize | skip persistenza, calibrazione volatile |
| SQLite lock online | bounded retry, poi fallback diagnostico |
| retention prune failure | rollback save, context invariato |
| usage row mancante | calibrazione volatile, nessuna seconda correlazione |
| storage stats failure | `/context storage` unavailable, runtime invariato |
| maintenance active | DS4 database unavailable, Pi continua |
| active client durante compact | compact rifiutata prima di copiare |
| quick check sorgente fallito | compact rifiutata, nessuna modifica |
| disk space insufficiente | compact rifiutata, nessuna modifica |
| prune working copy fallito | sorgente invariata |
| vacuum candidate fallito | sorgente invariata |
| candidate validation fallita | sorgente invariata |
| swap secondo rename fallito | rollback backup immediato |
| recovery ambiguo | fail closed, richiede intervento umano |

## 18.2 Nessuna interferenza col provider fallback

Gli errori storage non cambiano le categorie provider:

```text
input-limit
usage-limit
rate-limit
authentication
transport
aborted
```

Il retry di compaction resta limitato a `transport`, massimo tre tentativi con delay abort-aware e routing session ID nuovo per tentativo.

## 18.3 Error text bounded

Gli errori UI e CLI devono essere bounded e categoriali. Non includere il contenuto della causa SQLite attraverso `error.message` non sanitizzato.

---

# 19. Configurazione e contratti

## 19.1 Primo rollout

Non aggiungere nuove chiavi a `ds4-context-config-v1`.

Usare costanti esportate e testate:

```text
128 manifest
200 calibration/profile
32 righe prune
8 MiB prune
256 KiB preferred manifest
1 MiB hard manifest
256 excluded detail retained
1 GiB storage warning
```

Motivazioni:

- evitare combinazioni non testate;
- mantenere il contratto config invariato;
- garantire un bound noto;
- semplificare dogfooding e rollback.

## 19.2 Config esistente

`diagnostics.storeContextManifest` continua a controllare se persistere manifest.

Se `false`:

- nessun manifest viene scritto;
- la calibrazione può restare volatile secondo il comportamento runtime esistente;
- `/context storage` continua a funzionare.

## 19.3 Schema SQLite

Il primo rollout resta su:

```text
CURRENT_SCHEMA_VERSION = 15
```

Non modificare migration `1–15`.

La bounded projection vive dentro `manifest_json` e mantiene leggibilità backward della riga come JSON. Le nuove informazioni di inventory sono additive.

## 19.4 Contratto manifest

Formalizzare l'addizione del metadata di persistenza senza cambiare il significato del manifest runtime.

Opzione raccomandata:

```text
ContextManifest.schemaVersion = 1 invariato
optional persistedInventory metadata
```

ma il repository deve restituire un wrapper di completezza esplicito. Se i test di compatibilità dimostrano che il wrapper rompe consumer pubblici, introdurre un nuovo metodo `getStored()` mantenendo `get()` soltanto per record completi.

Questa scelta è un gate M2, non deve essere risolta implicitamente durante il coding.

## 19.5 Compressione futura

Una futura adozione di payload compresso richiede:

- nuova migration append-only;
- codec versionato;
- hash payload;
- raw/stored byte limits;
- decompression bomb protection;
- test downgrade/rebuild;
- ADR separata.

Non inserire base64 compresso in `manifest_json` sotto schema `15`.

---

# 20. File da creare o modificare

## 20.1 Core

```text
packages/core/src/manifest/context-manifest.ts
```

- DTO inventory/projection metadata;
- completeness type.

```text
packages/core/src/manifest/context-manifest-storage.ts        NEW
```

- byte measurement UTF-8;
- deterministic rollup;
- digest;
- serializer/parser bounded;
- save outcome types.

```text
packages/core/src/persistence/repositories/context-manifest-repository.ts
```

- retention row+byte bounded;
- save result;
- scalar usage update;
- hydration;
- maintenance APIs bounded/esatte.

```text
packages/core/src/persistence/sqlite.ts
```

- storage stats;
- checkpoint API per maintenance;
- repository wiring;
- nessuna esposizione del raw `DatabaseSync`.

```text
packages/core/src/persistence/storage-diagnostics.ts          NEW
```

- DTO e raccolta metadata;
- threshold evaluation.

```text
packages/core/src/persistence/database-client-lease.ts        NEW
```

- client lease;
- maintenance lock;
- stale lease verification;
- secure file modes.

```text
packages/core/src/persistence/storage-maintenance.ts          NEW
```

- preflight;
- working copy rewrite;
- candidate validation;
- swap/recover state machine.

```text
packages/core/src/index.ts
```

- export pubblici necessari, senza API Pi-specifiche.

## 20.2 Pi adapter/extension

```text
src/extension/runtime.ts
```

- save result tracking;
- manifest completo in memoria;
- volatile calibration on skip;
- storage diagnostics;
- client lease lifecycle.

```text
src/extension/commands.ts
```

- `/context storage`;
- integrazione `/context health`;
- rendering completeness.

```text
src/extension/index.ts
```

- shutdown ordering: close database, poi release client lease.

## 20.3 CLI

```text
scripts/ds4-context-storage.mjs                               NEW
```

- parsing args;
- prompt TTY;
- chiamate alle API core;
- nessuna mutation SQL inline.

```text
package.json
package-lock.json
```

- eventuale `bin` e inclusione package;
- preservare integralmente la modifica locale preesistente `allowScripts`;
- non includere cambi estranei nello stesso commit.

```text
scripts/verify-packages.mjs
```

- verificare inclusione CLI;
- vietare DB, WAL, SHM, lease, work, candidate e backup nei tarball.

## 20.4 Test

```text
tests/unit/context-manifest-storage.test.ts                   NEW
tests/unit/database-client-lease.test.ts                      NEW
tests/unit/storage-diagnostics.test.ts                        NEW
tests/unit/storage-maintenance.test.ts                        NEW
tests/integration/context-manifest-repository.test.ts
tests/integration/sqlite-concurrency.test.ts
tests/integration/sqlite.test.ts
tests/integration/upgrade-rebuild.test.ts
tests/integration/storage-maintenance.test.ts                 NEW
tests/fixtures/sqlite-concurrency-worker.mjs
```

## 20.5 Documentazione

```text
docs/CONTEXT_MANIFEST.md
docs/STORAGE.md
docs/ARCHITECTURE.md
docs/DOGFOODING_0.3.0_BETA.md
docs/STORAGE_MAINTENANCE.md                                  NEW
README.md
docs/releases/<next-prerelease>.md                           NEW al release prep
```

---

# 21. Milestone implementative

## M0 — Freeze e revisione del working tree corrente

Obiettivi:

- separare modifiche pertinenti da stato locale estraneo;
- riesaminare retry compaction, retention e lock diagnostics già implementati;
- non toccare database live o JSONL canonici.

Attività:

- review completa del diff;
- verificare cumulative usage e routing session ID per retry;
- verificare abort durante delay;
- verificare lock diagnostic metadata-only;
- verificare global retention e detach calibrazione;
- confermare `git diff --check`.

Gate:

- nessun file in `.serena/` incluso;
- modifica `package.json` preesistente preservata e attribuita separatamente;
- nessun generated build output versionato.

## M1 — Retention dual-bound

Attività:

- aggiungere limite byte `8 MiB` al batch manifest;
- mantenere massimo `32` righe;
- riportare conteggio e byte eliminati;
- testare backlog realistico con righe di dimensione diversa;
- preservare transazione unica con detach calibrazione.

Gate:

- progresso minimo una riga;
- nessuna transazione seleziona oltre il byte budget, eccetto singola riga oversize;
- concorrenza tre processi verde.

## M2 — Bounded manifest projection

Attività:

- introdurre serializer separato;
- definire wrapper/metadata completeness;
- preservare `included` completo;
- rollup deterministic `excluded`;
- hard skip oltre `1 MiB`;
- save outcome categoriale;
- compatibilità righe legacy.

Gate:

- nessun record persisted oltre hard limit;
- digest stabile;
- runtime manifest corrente invariato;
- golden manifest aggiornato intenzionalmente;
- nessun contenuto nuovo nel payload.

## M3 — Scalar provider usage

Attività:

- non riscrivere `manifest_json` al `message_end`;
- aggiornare colonne scalar;
- hydration in lettura;
- estimator version passato dal runtime;
- calibrazione volatile se manifest skipped/missing.

Gate:

- byte di `manifest_json` identici prima/dopo usage;
- provider usage visibile dopo reopen;
- un solo campione per manifest;
- duplicate message end no-op.

## M4 — Storage diagnostics

Attività:

- implementare DTO core;
- aggiungere `/context storage`;
- integrare health warning;
- limitare query e output;
- testare DB assente/corrotto/locked.

Gate:

- comando read-only verificato con `data_version`/conteggi invariati;
- nessun contenuto sensibile nell'output;
- tempo bounded su fixture con backlog.

## M5 — Maintenance exclusion protocol

Attività:

- client lease runtime;
- maintenance lock two-phase;
- stale lease cleanup fail-safe;
- shutdown ordering;
- startup fallback durante maintenance.

Gate:

- nessuna race nota tra startup e maintenance;
- client vivo blocca compact;
- PID ambiguo blocca compact;
- crash lascia stato recuperabile.

## M6 — Offline inspect/compact/recover

Attività:

- CLI;
- TTY confirmation;
- disk preflight;
- backup SQLite standalone;
- working copy;
- prune/rewrite;
- vacuum candidate;
- validation;
- recoverable swap;
- fixed backup policy.

Gate:

- fault injection prima dello swap lascia source byte-for-byte invariata; dopo lo swap lascia uno stato recuperabile;
- candidate passa quick/FK/schema checks;
- source exclusions preservate;
- nessun active client;
- tarball include soltanto CLI e codice previsto.

## M7 — Dogfooding e release candidate

Attività:

- full suite;
- package smoke clean consumer;
- pack check;
- schema/token gate tool persistence invariato;
- latency disabled gate;
- test su copia anonimizzata/locale del database grande;
- documentare prima/dopo.

Gate:

- nessuna manutenzione sul live durante sviluppo;
- release evidence completa;
- pubblicazione soltanto manuale e autorizzata.

Evidenza locale M7 del 2026-09-03, senza maintenance sul database live:

- sorgente aperta esclusivamente `readOnly` con `node:sqlite.backup()` verso una directory privata in `/tmp`;
- target di `compactStorage()` verificato esplicitamente come copia temporanea distinta dal path live;
- prima: schema `15`, `quick_check=ok`, `3.691` manifest, `2.101.666.663` byte manifest, database copia `2.489.868.288` byte;
- dopo: `128` manifest, `15.626.529` byte manifest, `414` campioni su `3` profili con retention converged, database `389.746.688` byte;
- prune: `3.563` manifest e `3.228` campioni; `128` manifest riscritti come `excluded-rollup`, nessun irreducibile oversize;
- candidate finale `quick_check=ok`, zero violazioni FK, backup presente durante la validazione;
- copia, backup e stage rimossi al termine; nessun file maintenance creato accanto al database live o nel repository;
- il gate latency sub-millisecond ha mostrato rumore con campioni da una singola chiamata (`0,873×` e `1,124×`); il benchmark è stato stabilizzato senza cambiare la soglia `1,10×`, ammortizzando `50` chiamate per campione. Tre run consecutivi finali: `1,019×`, `1,017×`, `1,008×`.

La prova non autorizza né sostituisce la futura maintenance live: chiusura di tutte le istanze Pi, conferma TTY e autorizzazione separata restano obbligatorie.

## M8 — Aging generale successivo

Attività separate:

- misurare session/project/artifact dopo retention;
- ADR per reidratazione session index;
- project LRU con last-access;
- orphan artifact GC;
- summary failed/prepared retention;
- high-water warning e maintenance scheduling.

Questa milestone non blocca il fix urgente dei manifest.

---

# 22. Test plan

## 22.1 Unit — manifest storage

Testare:

- UTF-8 byte count con ASCII e Unicode;
- payload sotto preferred invariato;
- payload sopra preferred produce rollup;
- primi/ultimi sample deterministici;
- array sotto `256` senza duplicati;
- conteggio/tokens by kind esatti;
- classification undefined aggregata come `unspecified`;
- digest stabile a input uguale;
- digest cambia a elemento diverso;
- `included` byte-for-byte semanticamente invariato;
- campi selected/provenance invariati;
- projection oltre hard ritorna skip;
- nessuna mutation dell'oggetto input;
- serializzazione non include raw content proibito.

## 22.2 Unit — repository

Testare:

- save completo;
- save rollup;
- save skip;
- get legacy;
- get projected con completeness;
- latest ordering e tie-break;
- upsert stesso ID;
- provider usage solo colonne;
- hydration dopo close/reopen;
- duplicate usage;
- invalid token counts;
- manifest missing;
- calibration estimator profile;
- retention globale;
- retention per profilo;
- detach prima di delete;
- row+byte prune;
- singola riga oltre byte budget.

## 22.3 Unit — write coordinator

Mantenere e ampliare:

- non-busy error non retry;
- busy/locked retry;
- timeout esaurito;
- rollback failure sanitizzato;
- operation name invalid sanitizzato;
- elapsed boundary;
- nessun raw message nel logger o errore terminale.

## 22.4 Unit — storage diagnostics

Testare:

- page math;
- DB/WAL/SHM assenti;
- manifest excess;
- physical high-water;
- reusable ratio;
- warning reason dedup;
- output bounded;
- no row content.

## 22.5 Unit — client lease

Testare con filesystem temporaneo e process probe iniettato:

- create/release;
- existing maintenance lock;
- lock appare tra primo check e lease;
- client alive;
- client dead;
- PID probe denied/ambiguous;
- stale malformed lease;
- lock `O_EXCL` concorrente;
- permessi;
- path fingerprint mismatch;
- release idempotente.

## 22.6 Unit — maintenance state machine

Con adapter filesystem/SQLite iniettabili, simulare failure:

- prima del checkpoint;
- dopo checkpoint;
- durante copy;
- durante prune;
- durante vacuum;
- durante candidate validation;
- dopo source rename;
- prima candidate rename;
- dopo candidate rename;
- durante final quick check;
- durante cleanup.

Per ogni failure verificare source, backup, candidate, state e istruzione recover.

## 22.7 Integration — repository e SQLite

Fixture schema `15`:

- righe manifest legacy grandi;
- upgrade applicativo senza migration;
- rewrite retained bounded;
- calibrazione indipendente;
- `quick_check` e `foreign_key_check`.

## 22.8 Integration — concorrenza

Tre processi simultanei:

- apertura/migration schema `15`;
- session entry write;
- manifest save;
- usage update;
- retention;
- calibration prune;
- storage read diagnostics.

Verificare:

```text
quick_check = ok
schema_migrations = 15
manifest count <= 128 + concorrenza transitoria non committed
calibration <= 200/profile
nessuna lost session entry
```

Dopo termine di tutti i processi il count deve essere `<=128`.

## 22.9 Integration — maintenance

Usare soltanto directory temporanee.

Scenari:

- compact DB piccolo;
- compact backlog manifest;
- source exclusions presenti;
- calibration detached;
- backup preesistente;
- disk space insufficiente simulato;
- active client;
- maintenance lock concorrente;
- stale lease;
- corrupted source;
- corrupted candidate;
- recovery da ogni fase persistita;
- reopen tramite `ContextDatabase` dopo swap.

## 22.10 Integration — runtime

Verificare:

- latest manifest in memoria completo anche quando persistito come rollup;
- `/context excluded` corrente non usa sample storico;
- `/context storage` read-only;
- message end su persisted, skipped e pruned manifest;
- phase fallback se maintenance active;
- shutdown close-before-release;
- context_persistence project-file-neutral invariato.

## 22.11 Compaction regression

Aggiungere i test mancanti indicati dalla revisione corrente:

- transport exception lanciata al primo tentativo e successo al secondo;
- tre transport failure e fallback finale;
- abort prima del retry;
- abort durante delay;
- routing session ID diverso per ogni tentativo;
- cumulative usage corretta;
- nessun retry per usage/rate/auth/input-limit/validation;
- `unsupported-exact-value` continua a validare e riparare con gli stessi limiti;
- rejected exact values assenti dai diagnostic.

## 22.12 Full gate

Eseguire:

```text
npm run typecheck
npm test
npm run check
npm run quality:compare
npm run schema:context-persistence
npm run latency:check
npm run pack:check
git diff --check
```

La ripetizione `check` è intenzionale soltanto sul tree finale; durante sviluppo usare test focalizzati.

---

# 23. Gate prestazionali e di storage

## 23.1 Manifest size

Su fixture equivalente alla sessione osservata:

```text
source manifest:               circa 879 KB
persisted target after rollup: <= 128 KB consigliato
hard maximum:                   1 MiB
```

Il gate obbligatorio è il limite hard; il target `128 KB` è prestazionale.

## 23.2 Write amplification

Dopo M3:

- `recordProviderUsage()` non modifica `manifest_json`;
- la write usage modifica soltanto colonne scalar e calibration;
- test SQL/byte verifica payload identico.

## 23.3 Lock duration

Su fixture locale grande:

- una retention online non seleziona oltre `8 MiB` di payload stale;
- lock timeout resta bounded a configurazione;
- nessun startup purge.

Non usare un limite wall-clock rigido su CI condivisa come unico gate. Registrare distribuzione e fallire su regressioni strutturali o ratio concordato.

## 23.4 Database post-maintenance

Sulla copia del database osservato, attendersi:

```text
manifest rows:              <= 128
manifest payload:           sensibilmente sotto 128 MiB
quick_check:                ok
foreign_key_check:          0 righe
schema:                     15
```

La stima iniziale del file finale è circa `450–500 MB`, ma non è criterio di correttezza: il valore reale dipende da indici, page layout e altri dati derivati.

## 23.5 Feature-disabled latency

Con DS4 disabilitato, mantenere il gate già adottato:

```text
regression ratio <= 1.10x
```

Il client lease check deve essere saltato o minimo quando l'estensione è completamente disabilitata, secondo il contratto runtime esistente.

## 23.6 Packaging

Tarball vietati:

```text
*.db
*.db-wal
*.db-shm
*.bak
*.compact-ready
*.maintenance-work
*.maintenance.lock
*.maintenance-state.json
*.clients/*
.pi session/config locali
.serena/
```

---

# 24. Procedura di rollout

## 24.1 Prima release — contenimento

La prossima prerelease coordinata include:

- compaction transport retry e diagnostica;
- lock timeout sanitizzato;
- retention `128`/`200`;
- dual-bound prune;
- bounded manifest projection;
- scalar usage update;
- `/context storage`;
- maintenance protocol e CLI, se tutti i gate M5/M6 passano.

Se la CLI non supera fault-injection/recovery gate, pubblicare prima il contenimento online e rinviare la sostituzione fisica; non indebolire i controlli per rispettare una data.

## 24.2 Installazione

Dopo pubblicazione manuale e verifica dell'exact version:

1. installare la prerelease esatta;
2. riavviare Pi;
3. eseguire `/context health`;
4. eseguire `/context storage`;
5. osservare alcune model call;
6. verificare che il manifest count converga e che non compaiano lock timeout.

## 24.3 Manutenzione del database attuale

Soltanto dopo dogfooding online riuscito:

1. chiudere tutte le sessioni Pi;
2. verificare processi database holder;
3. eseguire `inspect`;
4. conservare l'output metadata del preflight;
5. eseguire `compact` con conferma locale;
6. riaprire Pi;
7. eseguire `/context health` e `/context storage`;
8. verificare Pin/Memory/source policy locali;
9. conservare il backup fino al termine del periodo di osservazione;
10. eliminarlo manualmente quando non serve più.

## 24.4 Release discipline

- versioni coordinate fra root, core e reference adapter;
- publish npm manuale da workstation autenticata;
- verifica registry con exact version, non dist-tag mutabile;
- tag annotato soltanto sul commit verificato;
- GitHub prerelease dopo registry verification;
- bookkeeping post-release separato;
- nessuna inclusione accidentale di `package.json` estraneo o `.serena/`.

---

# 25. Rollback e recovery

## 25.1 Rollback applicativo prima della maintenance

Poiché schema resta `15`, la prerelease precedente può riaprire il database.

Le nuove righe con inventory metadata restano JSON valide. Il vecchio runtime può ignorare campi additivi; il piano deve verificare con un test clean-consumer/downgrade read.

Se il vecchio reader interpreta erroneamente un `excluded` sampled come completo, il rollout deve scegliere il wrapper compatibile definito in M2 o non dichiarare downgrade supportato.

## 25.2 Rollback dopo maintenance

Con Pi chiuso:

1. acquisire maintenance lock;
2. validare `context.db.precompact.bak`;
3. rinominare il database corrente come candidate diagnostico, senza sovrascrivere file;
4. ripristinare backup;
5. quick check;
6. riaprire Pi.

## 25.3 Rebuild estremo

Poiché SQLite è derivato, ultima risorsa:

- spostare il database corrotto senza cancellarlo;
- lasciare che DS4 ricostruisca da Pi JSONL e file progetto;
- ricordare che `project_memory_source_exclusions` è policy locale disposable e non viene ricostruita dai JSONL.

Per questo il rebuild non è la procedura primaria di compattazione.

## 25.4 Canonical safety

Nessun rollback storage richiede modifica dei Pi JSONL.

---

# 26. Rischi e mitigazioni

| Rischio | Mitigazione |
| --- | --- |
| sample `excluded` scambiato per inventario completo | completeness obbligatoria e wrapper tipizzato |
| perdita provenance inclusa | `included` e selected refs mai ridotti; oversize => skip |
| batch prune troppo grande | doppio limite 32 righe / 8 MiB |
| usage riscrive payload grande | colonne scalar autorevoli |
| calibration persa con manifest | detach nella stessa transazione |
| file non si riduce dopo DELETE | manutenzione offline `VACUUM INTO` |
| backup omette WAL committed | `node:sqlite.backup()` consistente da sorgente read-only |
| WAL vecchio applicato al candidate | sidecar ritirati prima di installare il candidate |
| Pi attivo durante swap | client lease + maintenance lock + conferma legacy |
| crash fra rename | state machine persistita + backup + recover |
| disk full | preflight conservativo e source invariata |
| candidate corrotto | quick/FK/schema/count validation prima dello swap |
| backup cresce indefinitamente | un solo path fisso, no overwrite |
| raw SQLite leak | diagnostica categoriale metadata-only |
| downgrade interpreta nuovo JSON | compatibility gate M2 |
| retention riduce osservabilità storica | JSONL canonico resta; ultimi 128 + rollup/digest |
| automatic session eviction perde retrieval | rinviata fino a reidratazione on-demand |
| artifact referenced cancellato | solo orphan verificati nel primo rollout |
| compression format fragile | compressione rinviata e ADR separata |
| test modifica DB live | tutti i test usano temp dir; path live vietato nei test helper |

---

# 27. Criteri di accettazione

Il lavoro è accettato quando:

## Retention

- [x] `context_manifests <= 128` dopo convergenza.
- [x] Calibration `<=200` per profilo esatto.
- [x] Calibration recente sopravvive alla cancellazione del manifest.
- [x] Ogni prune online è `<=32` righe e `<=8 MiB`, salvo una singola riga oversize.
- [x] Nessuna purge completa avviene all'avvio.

## Bounded manifest

- [x] Manifest completo sotto `256 KiB` resta completo.
- [x] Manifest grande riduce soltanto `excluded`.
- [x] `included` e provenance selected restano complete.
- [x] Sample `excluded <=256` ed è deterministico.
- [x] Conteggi, token e digest rappresentano l'inventario completo.
- [x] Nessuna riga nuova supera `1 MiB`.
- [x] Oversize residuo viene skipped senza influire sulla model call.

## Usage

- [x] `manifest_json` non cambia al record provider usage.
- [x] Colonne usage sono autorevoli.
- [x] Lettura dopo restart ricostruisce `providerUsage`.
- [x] Duplicate/error/aborted/missing usage non crea sample impropri.

## Diagnostica

- [x] `/context storage` è read-only.
- [x] Mostra dimensioni, pagine, manifest, calibration e maintenance recommendation.
- [x] Non mostra contenuto, SQL o raw SQLite errors.
- [x] `/context health` distingue warning storage da corruption.

## Maintenance

- [x] Active client blocca compact.
- [x] Source corrotta blocca compact.
- [x] Disk insufficiente blocca compact.
- [x] Tutte le trasformazioni avvengono su working copy.
- [x] Candidate passa quick/FK/schema/count checks.
- [x] Source exclusions e dati non target conservano conteggi/digest.
- [x] Swap è recuperabile da ogni fase.
- [x] Backup non viene sovrascritto.
- [x] Pi JSONL e file progetto restano invariati.

## Concorrenza e fallback

- [x] Tre processi simultanei passano il test.
- [x] Lock timeout resta bounded e sanitizzato.
- [x] Storage failure non altera prompt o compaction validation.
- [x] Pi fallback resta disponibile.

## Qualità e release

- [x] Typecheck verde.
- [x] Test focalizzati verdi.
- [x] Full `npm run check` verde sul tree finale.
- [x] Quality/schema/latency/pack gate verdi.
- [x] `git diff --check` verde.
- [x] Nessun DB/JSONL/config locale nel tarball.
- [x] Nessuna modifica live effettuata durante sviluppo o test.

---

# 28. Checklist finale

## Design

- [x] Decisione retention globale congelata.
- [x] Limiti byte/righe congelati.
- [x] Contratto completeness M2 congelato.
- [x] ADR compression deferred registrata.
- [x] State machine maintenance revisionata.

## Implementazione

- [x] M0 review patch corrente.
- [x] M1 dual-bound prune.
- [x] M2 bounded projection.
- [x] M3 scalar usage.
- [x] M4 storage diagnostics.
- [x] M5 lease/maintenance lock.
- [x] M6 CLI inspect/compact/recover.

## Verifica

- [x] Unit storage projection.
- [x] Unit coordinator.
- [x] Unit lease/state machine.
- [x] Integration repository.
- [x] Integration concurrency.
- [x] Integration maintenance/fault injection.
- [x] Runtime and compaction regression.
- [x] Full gate.
- [x] Clean package consumer.
- [x] Dry-run tarball inspection.

## Rollout

La maintenance live autorizzata con `0.3.0-beta.1` ha verificato il percorso offline completo: nessun holder durante l'operazione, `quick_check=ok`, zero violazioni FK, database ridotto da 2,42 GiB a 377 MiB, manifest da 1.630 a 128 e payload manifest da 1,02 GiB a 13,5 MiB. Dopo la riapertura Pi, l'ispezione read-only ha confermato schema 15, WAL, 128 manifest, nessun prune pendente e nessuna maintenance raccomandata. Il backup standalone resta intenzionalmente conservato durante l'osservazione.

- [x] Release notes della prossima versione autorizzata (`0.3.0-beta.2`).
- [x] Dogfooding runbook.
- [ ] Exact version registry verification (`0.3.0-beta.2`, tre package e CLI).
- [x] Online retention osservata.
- [x] Tutte le istanze Pi chiuse prima della maintenance.
- [x] Inspect completato.
- [x] Compact completato su database live soltanto con autorizzazione separata.
- [x] Health/storage post-swap verificati.
- [ ] Backup conservato temporaneamente e poi rimosso manualmente.

---

## Conclusione

La soluzione raccomandata non tratta il database da `2+ GB` come dato canonico da archiviare, ma come una proiezione derivata da rendere bounded, osservabile e manutenibile.

Il percorso più sicuro è:

```text
fermare la crescita
→ ridurre write amplification
→ rendere visibile lo stato
→ compattare offline su copia verificata
→ introdurre aging generale solo dopo reidratazione testata
```

Questo risolve il problema dominante senza separare il database per sessione, senza indebolire validazione/privacy/provenance e senza rischiare modifiche concorrenti al database live o ai Pi JSONL canonici.
