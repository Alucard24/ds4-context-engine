# ADR-071 — Rank by distinct topic matches and bind tool results per call occurrence

Status: accepted.

## Context

Two independent defects were reproducible with synthetic tests against the shipping implementation.

Ranking: `describeTask` extracted every word of four or more letters that was not already a stopword. Generic Italian and English workflow words (`devi`, `procedi`, `allora`, `aggiungi`, `continua`, `considerare`, `ovvero`, `quelli`, `fix`, `please`) therefore became query terms, and a historical turn that contained only that vocabulary matched the FTS query. A single match was also enough for the candidate to enter the ranking, where FTS order, source role, recency and a short length could outweigh the one or two terms that identified the actual topic. A broad but irrelevant row could thus rank above a longer row matching two or three distinct topic terms. Match accounting additionally used `String.includes`, so a keyword counted as matched inside any larger word, and it compared raw text against unaccented query terms even though the canonical FTS index tokenizes with `unicode61 remove_diacritics 2`.

Atomic grouping: `toolRelations` stored one call index per tool-call ID and one result list per ID. When a completion reused an ID, results from every occurrence were attributed to the last call index, independent turns were merged into a single oversized group, and `validateAtomicSelection` could accept an incomplete call because a later occurrence of the same ID had produced a result. The same map also made `containsToolExchange` rescan every exchange for every group.

Neither defect is confirmed to have occurred in a reported live session; both were reproduced locally from the code and its tests.

## Decision

- Filter generic workflow words and acknowledgements from `keywords`, `symbols` and `queryTerms`, without removing explicit evidence: backticked spans, qualified identifiers, file paths, flags, error codes and quoted phrases stay searchable even when their text is otherwise a stopword. A request that yields no evidence term returns `no-query` instead of searching for earlier approvals.
- Award a bounded bonus of 40 per additional distinct matched query term, capped at 80 (the second and third matches). The bonus exceeds FTS order, role, recency and length combined, so an additional topic match cannot be outweighed by them, while literal identifier and phrase tiers remain strictly ahead of numeric score.
- Count a match with word-boundary semantics and Latin accent folding consistent with the FTS tokenizer, so prefixes inside larger words do not earn a bonus and accented evidence matches its unaccented query term. Evidence text is never modified.
- Bind each tool result to the latest preceding occurrence of its tool-call ID. Results with no preceding call become orphan results that never bind to a later reuse. Validation reports an incomplete call or a missing call for the occurrence actually selected, and `containsToolExchange` is derived from completed call indices instead of rescanning relations per group.
- Do not change the recent-tail policy, budget derivation, retrieval budgets, result limits, deduplication, branch isolation, evidence rendering, privacy handling or provider-facing defaults.

## Consequences and validation scope

A ranking bonus changes which historical evidence reaches the provider for a given request. It can promote an additional-topic candidate that a human reader would consider less relevant, and it cannot make retrieval semantic: only lexical and exact signals are counted. The stopword list is a curated heuristic; a legitimate topic term that happens to appear in it is still searched when it is backticked, qualified, a path, a flag, an error code or a quoted phrase.

Per-occurrence binding changes group boundaries only when a tool-call ID is reused within one native context. A genuine older oversized turn can still be excluded even when the whole native input alone would fit the global budget; the existing immediate-predecessor rescue remains the only verbatim exception, and it is bounded by the combined message target and the hard input limit.

Synthetic regressions cover acknowledgement queries, Italian topic extraction, identifiers that are also stopwords, two-topic versus workflow-only ranking, duplicate FTS rows with a longer lower-ranked candidate, prefix and accent match accounting, reused IDs in independent turns, ID reuse with an incomplete call, orphan results, a real exchange spanning a user boundary, a 200-exchange reused-ID sequence, a long native context with a 64k tail (no false oversized-turn warning) and an oversized immediate predecessor with input headroom. Every one of them fails on the prior implementation and passes with the change.

These tests are synthetic. They do not confirm behaviour on the reported host's live session, do not measure real retrieval quality, and do not authorize provider calls or compaction runs.
