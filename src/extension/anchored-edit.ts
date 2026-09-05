/** Portable text semantics; no filesystem access or inference-time forcing. */
export const UPTO_MARKER = "[upto]";

export interface AnchoredEditSpan {
  /** Offsets in LF-normalized, BOM-free original content (UTF-16 code units). */
  start: number;
  end: number;
  oldText: string;
  startLine: number;
  endLine: number;
}

export function normalizeEditText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Count overlapping occurrences as ambiguous too. Tail uniqueness is suffix-only. */
function uniqueAnchor(content: string, anchor: string, from: number, label: string): number {
  if (!anchor.trim()) throw new Error(`${label} anchor must contain non-whitespace text`);
  const position = content.indexOf(anchor, from);
  if (position < 0) throw new Error(`${label} anchor not found${from > 0 ? " after head" : ""}`);
  if (content.indexOf(anchor, position + 1) >= 0) {
    throw new Error(`${label} anchor is not unique${from > 0 ? " after head" : ""}`);
  }
  return position;
}

/**
 * Resolve one DS4-style range. Both anchors are included in the replacement.
 * As in DS4, newlines immediately after the marker are separators, not part of
 * the tail needle. No trimming of anchor spaces, fuzzy matching or automatic
 * forcer's size/line thresholds. The caller supplies the original normalized file.
 */
export function resolveAnchoredEdit(content: string, oldText: string): AnchoredEditSpan {
  const old = normalizeEditText(oldText);
  const marker = old.indexOf(UPTO_MARKER);
  if (marker < 0) throw new Error("Anchored oldText must contain one [upto] marker");
  if (old.indexOf(UPTO_MARKER, marker + UPTO_MARKER.length) >= 0) {
    throw new Error("Anchored oldText contains more than one [upto] marker; use literal: true for literal text");
  }
  const head = old.slice(0, marker);
  const tail = old.slice(marker + UPTO_MARKER.length).replace(/^\n+/, "");
  const start = uniqueAnchor(content, head, 0, "Head");
  const tailStart = uniqueAnchor(content, tail, start + head.length, "Tail");
  const end = tailStart + tail.length;
  return {
    start,
    end,
    oldText: content.slice(start, end),
    startLine: content.slice(0, start).split("\n").length,
    endLine: content.slice(0, end - 1).split("\n").length,
  };
}
