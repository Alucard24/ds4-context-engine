{
  "id": "95ccbda8",
  "title": "Implementare M1 Session Index incrementale",
  "tags": [
    "ds4",
    "pi-extension",
    "m1"
  ],
  "status": "completed",
  "created_at": "2026-08-24T13:44:38.152Z",
  "assigned_to_session": "01a033ed-9416-706b-a65d-28ba0c981763"
}

M1 Session Index completato.

Implementato:
- reader JSONL byte-safe con header v3, righe malformate, tail senza newline e checkpoint append-only
- fingerprint checkpoint limitato agli ultimi 64 KiB
- CanonicalMessage/CanonicalBlock adapter con opaque preservation
- esclusione di thinking, immagini, opaque payload e custom state dall'indice lessicale
- SHA-256 record, parentId/branch metadata, token estimate
- entry_key scoped per sessione per evitare collisioni degli ID Pi a 8 caratteri
- migrazioni SQLite 2-3, session_index_state e repository transazionale
- full reconciliation non distruttiva + incremental suffix indexing + no-op detection
- exact search e FTS5 repository
- sync su session_start/context/agent_settled/compaction/tree/shutdown
- /context rebuild-index e diagnostica stato indice
- fixture Pi JSONL v3 con tool groups e branch alternativo

Verifica:
- npm run check: 9 file / 19 test passati
- npm pack --dry-run riuscito
- smoke test reale Pi 0.84.3: initial index e forced rebuild riusciti; SQLite schema v3 health OK
- JSONL canonico non modificato dall'estensione; dati smoke rimossi dal DB derivato globale.
