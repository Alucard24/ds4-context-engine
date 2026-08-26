import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  RANKING_FEEDBACK_CUSTOM_ENTRY_TYPE,
  parseRankingFeedback,
  rankingTrainingSample,
  type RankingFeedbackEntry,
  type RankingTrainingSample,
} from "ds4-context-core/ranking/learned-ranker";

const MAX_RANKING_LABEL_WARNINGS = 100;

export interface RankingLabelProjection {
  entries: RankingFeedbackEntry[];
  samples: RankingTrainingSample[];
  malformedEntries: number;
  duplicateEntries: number;
  warnings: string[];
}

export function projectRankingLabels(
  entries: readonly SessionEntry[],
  maxSamples: number,
): RankingLabelProjection {
  if (!Number.isSafeInteger(maxSamples) || maxSamples < 1) {
    throw new Error("Ranking label projection limit must be a positive integer");
  }
  const accepted: RankingFeedbackEntry[] = [];
  let acceptedCursor = 0;
  const seen = new Set<string>();
  const warnings: string[] = [];
  let malformedEntries = 0;
  let duplicateEntries = 0;

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== RANKING_FEEDBACK_CUSTOM_ENTRY_TYPE) continue;
    const parsed = parseRankingFeedback(entry.data);
    if (!parsed) {
      malformedEntries++;
      if (warnings.length < MAX_RANKING_LABEL_WARNINGS) {
        warnings.push(`Ignored malformed ranking feedback custom entry ${entry.id}`);
      }
      continue;
    }
    if (seen.has(parsed.feedbackId)) {
      duplicateEntries++;
      if (warnings.length < MAX_RANKING_LABEL_WARNINGS) {
        warnings.push(`Ignored duplicate ranking feedback ${parsed.feedbackId} at ${entry.id}`);
      }
      continue;
    }
    if (accepted.length < maxSamples) {
      seen.add(parsed.feedbackId);
      accepted.push(parsed);
    } else {
      const replaced = accepted[acceptedCursor];
      if (replaced) seen.delete(replaced.feedbackId);
      seen.add(parsed.feedbackId);
      accepted[acceptedCursor] = parsed;
      acceptedCursor = (acceptedCursor + 1) % maxSamples;
    }
  }

  const bounded = accepted
    .sort((left, right) => left.createdAt - right.createdAt || left.feedbackId.localeCompare(right.feedbackId));
  return {
    entries: bounded,
    samples: bounded.map(rankingTrainingSample),
    malformedEntries,
    duplicateEntries,
    warnings,
  };
}
