/**
 * live.ts — the reconnect policy for the vault's event stream (#128).
 *
 * Plain TS, deliberately: `store.svelte.ts` is compiled by Svelte (runes), so
 * nothing there can be imported by a test. The POLICY is the part worth
 * asserting — the timers and the EventSource around it are wiring — so it
 * lives here, where `bun test` can reach it.
 */

/** First retry after a failure. */
export const RETRY_MIN_MS = 1_000;
/** The ceiling. Short on purpose: a server restart 502s every open stream,
 * so this is how long a healthy tab looks broken after one. */
export const RETRY_MAX_MS = 30_000;

/** Doubling, capped. Without the cap a server that stays down backs a tab
 * off past any useful horizon, leaving the stream as dead as it was before any
 * of this existed. */
export const nextRetryMs = (prev: number): number => Math.min(prev * 2, RETRY_MAX_MS);

/** Jitter, so a restart does not bring every open tab back in the same
 * millisecond. Injectable `rand` keeps the caller testable. */
export const retryDelayMs = (base: number, rand: () => number = Math.random): number =>
  base + rand() * 250;
