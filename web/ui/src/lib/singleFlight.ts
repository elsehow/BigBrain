/** Concurrent callers share one refresh; failures never poison later retries. */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => pending ??= Promise.resolve().then(run).finally(() => { pending = undefined; });
}
