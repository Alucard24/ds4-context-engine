# Benchmark A/B DeepSeek — cache-aware planning

Protocollo volontario, fuori CI, nessuna credenziale nel repo. Serve a decidere se
`context.cacheAware.mode` può passare da `auto` (opt-in) a **default** in una
release futura. Gate dichiarato in [ADR-062](ADR/062-cache-aware-context-planning.md).

## Obiettivo

Misurare, sulla **stessa** conversazione reale, il costo provider per turno con:

- **Sessione A (baseline)**: comportamento 0.3.6 — `context.cacheAware` assente
  (default `off`), tail automatica 64k, retrieval 16k, project 20k.
- **Sessione B (auto)**: `context.cacheAware.mode: "auto"` con i default di
  policy (gates 0.5 cache-share, ratio 20, margine 10%).
- **Sessione C (workaround estremo, opzionale)**: `modelAwareness.overrides` con
  `recentTailTokens: 500000`, `maxRetrievedHistoryTokens: 0`,
  `maxProjectTokens: 0`, `compaction.enabled: false` — cache-first puro.

Le tre sessioni devono avere la **stessa sequenza di turni** (stesso carico di
lavoro: tool call, retrieval, project touches) e lo **stesso modello/provided
ID DeepSeek**.

## Cosa registrare per ogni turno

Da `/context tokens` e `/context explain`:

- `recentTailTokens` scelti (nominal vs extended) e `cacheAware` decision/reasons;
- manifest `planning.cacheAware` (missHitRatio, cacheReadShare, sampleCount,
  reusablePrefixTokens, estimatedCost, candidate);
- `ProviderCacheMetrics` reali dopo ogni richiesta: `inputTokens`,
  `cacheReadTokens`, `cacheWriteTokens`, share read/write per provider/model.

Dal provider (costo effettivo):

- input non-cached, cache-read (hit), cache-write, output per richiesta;
- costo totale della sessione (per-turno e totale).

## Metriche

1. **Costo per turno** (media e totale sessione): A vs B vs C.
2. **Cache-read share osservata** per config: conferma che la tail estesa
   mantiene il prefisso stabile (share alta) vs sliding (share ~0 dopo 64k).
3. **Qualità** (non solo $$$): recall retrieval, `Planner exclusions`,
   current request/atomicità intatte, completamenti corretti nelle fasi tool.
   Con retrieval azzerato (C) documentare i regressi di qualità.
4. **Eventi di transizione**: quante volte il prefisso si è invalidato (turni
   con cacheRead ≈ 0), confronto sliding vs stable.

## Criterio di promozione a default

Promuovere `mode: "auto"` a default solo se, su ≥ 3 sessioni reali:

- costo medio per turno di B < A (margine ≥ il `minimumImprovementRatio`
  configurato, di default 10%);
- nessun regresso di qualità misurabile (recall retrieval uguale o migliore;
  current request/atomicità preservate);
- nessuna oscillazione plan (decisione che alterna nominal/esteso senza
  motivo: verificare `stickinessEpochs` e diagnostica).

## Esecuzione sicura

- Nessuna credenziale nel repo; il benchmark usa la sessione Pi normale con il
  provider DeepSeek già autenticato.
- Non modificare la config attiva in modo permanente: copie di configurazione
  per sessione, o valori temporanei poi ripristinati.
- Fuori CI: niente rete/credenziali nel test suite.
