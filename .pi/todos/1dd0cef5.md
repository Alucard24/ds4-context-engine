{
  "id": "1dd0cef5",
  "title": "Correggere compaction aggregate unsupported-exact-value",
  "tags": [
    "ds4",
    "compaction",
    "bug"
  ],
  "status": "completed",
  "created_at": "2026-08-25T10:05:18.501Z"
}

Diagnosi finale: il primo fix sulla provenance aggregate era corretto ma incompleto. Una riproduzione RPC isolata sulla sessione reale pre-compaction ha mostrato che il fallimento avviene nello stadio aggregate e che il modello può (a) sintetizzare descrizioni raggruppate nelle sezioni Files Read/Modified, oppure (b) backtickare valori parafrasati/non presenti verbatim nell'evidenza.

Correzione:
- prompt aggregate espone solo contenuto ordinato dei child, non ID/hash/kind/graphLevel DS4;
- Files Read/Modified vengono sostituite deterministicamente prima della validazione con l'inventario file-operation Pi già sanitizzato, un path esatto per bullet; sezioni mancanti/duplicate continuano a fallire;
- path Markdown-unsafe falliscono in sicurezza;
- valori exact sono validati anche contro gli inventari file;
- un bullet contenente exact value non supportato viene rimosso interamente e registrato come warning `unsupported-exact-bullets-pruned`; prose non-bullet, più di 8 bullet o oltre 25% del contenuto semantico continuano a fallire verso Pi default;
- errori non riparabili indicano ora lo stadio segment/aggregate;
- `compaction.validate=true`, grounding strict e fallback Pi restano invariati.

Verifica:
- `npm run check`: 44 file / 160 test;
- `git diff --check`: OK;
- `npm pack --dry-run`: 68 file;
- RPC E2E isolato Pi 0.84.3/openai-codex/gpt-5.6-sol sulla sessione reale pre-compaction: DS4 `fromHook=true`, graph prepared+committed, validation `warning`, issue `unsupported-exact-bullets-pruned`, marker exact intenzionalmente non supportato assente dal summary;
- precedente replay E2E senza marker: validation `valid` e graph DS4 committed;
- stato `/tmp` rimosso; configurazione e database globali non modificati.
