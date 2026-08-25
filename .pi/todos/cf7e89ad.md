{
  "id": "cf7e89ad",
  "title": "Implementare M9 Memory and Pins",
  "tags": [
    "ds4",
    "pi-extension",
    "m9"
  ],
  "status": "completed",
  "created_at": "2026-08-24T19:03:02.846Z",
  "assigned_to_session": "01a033ed-9416-706b-a65d-28ba0c981763"
}

M9 Memory and Pins completato.

Implementazione:
- mutazioni canoniche append-only tramite `pi.appendEntry()` con custom entry versionate `ds4-context-memory-v1` e `ds4-context-pin-v1`; nessuna modifica/riscrittura diretta del JSONL;
- schema SQLite v9: `memory_mutations`/`pin_mutations` con FK alle entry canoniche ed entry_order causale; materializzazione transazionale di memory, pin, source, FTS e lifecycle;
- replay completo da Pi JSONL su startup/rebuild, recovery quando il session file nasce dopo `session_start`, force-index delle mutation entry mancanti, firma per evitare replay invariato;
- scope pin session/branch/project; branch pin hard-filter per creation leaf su branch attiva; project pin/memory solo stesso path realpath canonico e progetto Pi trusted;
- scope memory session/project, project memory condivisa cross-session quando le sessioni sorgente sono indicizzate;
- comandi `/context pins`, `pin`, `unpin`, `memory list|add|supersede|invalidate|expire`, parser quote/escape/`--`, source entry active-branch validation;
- creazione manual-first; duplicate suppression; key esplicita o derivata (`defaults to`, `is`, `=`, `:`); conflitto same-key/opposite-polarity rifiutato; supersession esplicita immutabile; replay concorrente conserva entrambi e invalida deterministicamente il conflitto invece di sovrascrivere;
- pin replacement/deletion e memory active/superseded/invalid/expired con reason e provenance;
- planner: pin persistenti priority 950 mandatory, memory priority 90 prima di retrieval 85/project 80; maxPinnedTokens/maxMemoryTokens/maxResults, exact/key relevance e fallback massimo 3 memory recenti quando non ci sono match;
- pin individuali rifiutati se farebbero superare il budget attivo; hard limit e atomic validation preservati;
- boundary prompt: pin user-confirmed JSON-quoted e memory quoted-data; nessuna claim/content nel Context Manifest o log;
- manifest esteso con pin/memory ID, scope, key, origin session/source entry, score/token/reason; plannerVersion `managed-memory-v1`, policyVersion 5;
- `/context status|tokens|manifest|included|excluded|health|rebuild-index` aggiornati;
- observer/ephemeral disabilitano durable mutation; automatic memory extraction resta disabilitata;
- docs MEMORY_AND_PINS, architecture, planner, manifest, storage, compaction, README e ADR aggiornati.

Verifica:
- `npm run check`: 34 file / 109 test passati;
- test: duplicate/contradiction/supersession, replay same-timestamp canonical order, pin branch isolation, session/project sharing, unpin/invalidate, missing-source transaction rollback, malformed/duplicate custom entry, dedicated budgets/fallback, golden plan, commands, metadata privacy, two compaction, DB deletion+resume rebuild, schema v8→v9 legacy preservation;
- benchmark locale 1.000 memory: mean 5.85 ms, p99 7.22 ms, max 8.49 ms (<50 ms);
- `npm pack --dry-run`: 61 file, OK;
- E2E reale Pi 0.84.3 RPC offline/faux: comandi appendono 1 pin + 1 memory; 10 compaction gerarchiche automatiche; provider finale vede entrambi; DB mantiene 1 mutation/item active ciascuno; manifest metadata-only non contiene pin/claim; schema v9/integrity OK, zero extension errors;
- E2E isolato `/tmp` rimosso; DB globale schema v9 integrity/FK OK, zero mutation e calibrazioni faux residue.

M8 committato prima dell'avvio M9 come `5158653`.
