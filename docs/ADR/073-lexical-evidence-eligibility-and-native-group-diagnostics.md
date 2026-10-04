# ADR 073: Require topical lexical evidence and report bounded native-group exclusions

Status: Accepted

## Context

A reported Italian UI request retrieved historical discussions through `posso`, `solo` and `senza`, rather than its UI topic. ADR 071's bounded distinct-match bonus also rewarded these generic terms. Filtering them is necessary, but not sufficient: a lexical-only candidate with no verified query match could still be selected through FTS order, role, recency and unused budget.

Separately, `context.excluded_oversized_turn` identified a count but not the excluded native group, its token cost or unavailable-rescue reason. `/context excluded` printed a potentially huge historical inventory, mixing Pi branch/compaction exclusions with the managed planner's native exclusions. A native context below the global target does not imply that every older atomic turn fits the bounded contiguous recent tail.

## Decision

1. Filter Italian/English grammar, conversation-management, acknowledgements and generic finish requests from natural-language keywords and inferred simple symbols. Stopword lookup folds case, accents and compatibility characters without rewriting literal evidence. Explicit backticks, paths, qualified names, flags and quoted phrases remain searchable; UI/technical terms remain topic candidates.
2. Require a verified identifier, phrase or FTS term match for lexical-only candidates. FTS order, role, recency and spare budget are ranking/budget signals, not independent evidence. Semantic candidates retain their independent eligibility. The distinct-topic bonus remains bounded and operates on the filtered query.
3. Add optional content-free native-group diagnostics to managed planning: complete group/message totals plus at most 32 details, oversized-first. Record planner-generated IDs/positions, group token estimates, message counts, kind, oversized/predecessor flags and allowlisted exclusion/rescue reasons. Do not derive group costs or counts from a partial persisted item inventory.
4. Display group diagnostics directly in `/context explain` and by default in `/context excluded`. Preserve explicit item provenance through `/context excluded all`, truthful persisted-rollup labelling, and bounded legacy fallback output. Add at most eight oversized-group details and a truncation flag to the existing warning.

## Invariants and limitations

No budget, recent-tail, immediate-predecessor rescue, tool atomicity or provider-transport policy changes. Genuinely oversized exclusions remain warnings. Canonical Pi history is untouched; manifests remain non-authoritative, rebuildable projections. New metadata contains no message bodies, canonical entry IDs, paths, tool arguments/results, provider bodies or credentials. Existing manifests without the optional group block remain usable.

This is deterministic lexical retrieval, not a claim of semantic correctness for every request or language. Generic-looking unquoted simple names may require explicit backticks; compound/qualified identifiers remain searchable. Restoring an entire older oversized turn is not guaranteed by recovering a pertinent historical excerpt. Local synthetic multi-turn integration tests exercise real DS4/Pi hooks and SQLite retrieval, but do not establish behavior on the reporting host or make additional provider calls.

## Alternatives rejected

- Continually raising tail or retrieval budgets: does not correct topical relevance and changes bounded selection policy.
- Suppressing the warning: hides a real exclusion without identifying its cause.
- Only extending a word list: leaves matchless lexical rows eligible.
- Removing the distinct-match bonus: loses useful ranking of verified topic overlap.
- Requiring multiple query matches for every candidate: incorrectly excludes relevant evidence for one of several independently requested technical topics.
- Reconstructing group statistics from retained item samples: misreports costs/counts after persisted rollup.
- Printing full historical inventory by default: makes a two-group diagnosis unusable.
