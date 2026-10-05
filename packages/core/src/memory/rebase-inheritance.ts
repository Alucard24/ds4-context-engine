import type { MemoryItem, PinItem, SessionMutationProjection } from "./memory-types.ts";
import type { MemoryListCursor, PinListCursor, ReadPage } from "../persistence/repositories/memory-repository.ts";

/** Canonical frozen continuation state, not a new confirmation and not a mutation of its origin. */
export function inheritedMemoryState(pins: readonly PinItem[], memories: readonly MemoryItem[], projection: SessionMutationProjection) {
  const pinMap = new Map(pins.map((item) => [item.id, structuredClone(item)]));
  const memoryMap = new Map(memories.map((item) => [item.id, structuredClone(item)]));
  for (const stored of projection.pinMutations) {
    const mutation = stored.payload;
    if (mutation.operation === "status") {
      const item = pinMap.get(mutation.pinId);
      if (item) { item.status = "deleted"; item.updatedAt = mutation.createdAt; item.statusReason = mutation.reason; }
    } else if (mutation.operation === "supersede") {
      const item = pinMap.get(mutation.previousId);
      if (item) { item.status = "superseded"; item.updatedAt = mutation.createdAt; item.supersededBy = mutation.item.id; }
    }
  }
  for (const stored of projection.memoryMutations) {
    const mutation = stored.payload;
    if (mutation.operation === "status") {
      const item = memoryMap.get(mutation.memoryId);
      if (item) { item.status = mutation.status; item.updatedAt = mutation.createdAt; item.statusReason = mutation.reason; }
    } else if (mutation.operation === "supersede") {
      const item = memoryMap.get(mutation.previousId);
      if (item) { item.status = "superseded"; item.updatedAt = mutation.createdAt; item.supersededBy = mutation.item.id; }
    }
  }
  return { pins: pinMap, memories: memoryMap };
}
export function mergeInherited<T extends { id: string; status: string }>(native: T[], inherited: Iterable<T>, activeOnly: boolean): T[] {
  const items = new Map([...inherited].filter((item) => !activeOnly || item.status === "active").map((item) => [item.id, item]));
  for (const item of native) items.set(item.id, item);
  return [...items.values()];
}
function compare(a: MemoryListCursor | PinListCursor, b: MemoryListCursor | PinListCursor): number {
  return a.statusRank - b.statusRank || (("applicableRank" in a ? a.applicableRank : 0) - ("applicableRank" in b ? b.applicableRank : 0))
    || b.updatedAt - a.updatedAt || Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));
}
export function mergeInheritedPage<T extends { id: string; status: string }, C extends MemoryListCursor>(
  native: ReadPage<T, C>, inherited: Iterable<T>, activeOnly: boolean, limit: number, cursor: C | undefined, toCursor: (item: T) => C,
): ReadPage<T, C> {
  const items = mergeInherited(native.items, inherited, activeOnly)
    .filter((item) => !cursor || compare(toCursor(item), cursor) > 0)
    .sort((a, b) => compare(toCursor(a), toCursor(b)));
  const hasMore = native.hasMore || items.length > limit;
  const selected = items.slice(0, limit), last = selected.at(-1);
  return { items: selected, hasMore, ...(hasMore && last ? { nextCursor: toCursor(last) } : {}) };
}
