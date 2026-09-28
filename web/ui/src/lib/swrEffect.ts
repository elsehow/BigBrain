import type { Swr } from "./api";

/** Apply a cached snapshot and its refresh until the caller disposes it. */
export function swrEffect<T>(
  { cached, fresh }: Swr<T>,
  onValue: (v: T) => void,
  opts: { skipCached?: boolean; onError?: (e: unknown) => void } = {}
): () => void {
  let active = true;
  if (cached !== undefined && !opts.skipCached) onValue(cached);
  fresh.then(value => { if (active) onValue(value); })
    .catch(error => { if (active) opts.onError?.(error); });
  return () => { active = false; };
}
