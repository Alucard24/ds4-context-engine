/**
 * Ordered results from bounded, abort-cooperative work. A failure cancels peers
 * and drains every started worker before returning, so fallback cannot overlap
 * with unfinished custom requests. No new item starts after failure/abort.
 */
export async function mapCompactionSegments<T, R>(
  items: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  run: (item: T, index: number, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) {
    throw new Error("Compaction segment concurrency must be an integer between 1 and 2");
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const results: R[] = new Array(items.length);
  let next = 0;
  let failure: unknown;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await run(items[index] as T, index, controller.signal);
      } catch (error) {
        if (!failed) { failure = error; failed = true; }
        controller.abort();
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    if (failed) throw failure;
    if (controller.signal.aborted) throw new Error("Compaction summary generation aborted");
    return results;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
