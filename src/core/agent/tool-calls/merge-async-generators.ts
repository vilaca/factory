/**
 * Interleave events from N async generators in the order they become ready,
 * then return an array of each generator's return value in input order.
 *
 * Used by the Delegate parallel-batch path in runToolCalls: each delegate
 * gets its own AgentEvent stream, and the host needs to see prompts/results
 * as they happen rather than waiting for all to finish. Return values are
 * collected in input order (not completion order) so the caller can pair
 * each per-call tracking record back to its original ToolCallMessage.
 *
 * Cancellation: if the consumer breaks out of the iteration early, every
 * source generator's `return()` is invoked to release its resources. The
 * inner per-generator Promises swallow errors raised inside that cleanup —
 * the consumer's break/throw is what should propagate, not a generator's
 * shutdown hiccup.
 */
export async function* mergeAsyncGenerators<TYield, TReturn>(
  generators: AsyncGenerator<TYield, TReturn>[],
): AsyncGenerator<TYield, TReturn[]> {
  if (generators.length === 0) return [];

  const returns: TReturn[] = new Array(generators.length);
  // For each live generator, hold a Promise resolving to its next step plus
  // the index — racing all of them with Promise.race gives us "whichever
  // generator produces the next value next".
  type Step = { index: number; result: IteratorResult<TYield, TReturn> };
  const pending: (Promise<Step> | null)[] = generators.map((g, index) =>
    g.next().then(result => ({ index, result })),
  );
  let remaining = generators.length;

  try {
    while (remaining > 0) {
      const live = pending.filter((p): p is Promise<Step> => p !== null);
      const step = await Promise.race(live);
      const { index, result } = step;
      if (result.done) {
        returns[index] = result.value;
        pending[index] = null;
        remaining--;
        continue;
      }
      // Queue the next step for this generator before yielding, so a slow
      // consumer doesn't serialize the producers.
      pending[index] = generators[index]!.next().then(r => ({ index, result: r }));
      yield result.value;
    }
    return returns;
  } finally {
    // If the consumer broke out (return/throw upstream), drain in-flight
    // promises and ask every still-live generator to release. We don't
    // await the in-flight `.next()` promises — they may never settle if
    // the underlying generator was already cancelled by `return()`. Just
    // call `return()` and move on.
    await Promise.allSettled(
      generators.map(g => {
        try {
          const r = g.return?.(undefined as unknown as TReturn);
          return r instanceof Promise ? r : Promise.resolve(r);
        } catch {
          return Promise.resolve();
        }
      }),
    );
  }
}
