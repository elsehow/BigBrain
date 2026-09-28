import { untrack } from "svelte";
import type { Swr } from "./api";
import { app } from "./store.svelte";
import { swrEffect } from "./swrEffect";

/** Track only the resource key and live revision. Keep the current value on
 * refresh, and ignore responses after navigation, another refresh or unmount. */
export function liveResource<T>(
  key: () => string | null,
  fetch: (key: string) => Swr<T>,
  onValue: (value: T) => void,
  options: { cache?: boolean; onReset?: (key: string | null) => void; onError?: (error: unknown, hasValue: boolean) => void } = {},
): void {
  let previous: string | null | undefined;
  let hasValue = false;
  $effect(() => {
    const current = key();
    void app.rev;
    return untrack(() => {
      if (current !== previous) {
        previous = current;
        hasValue = false;
        options.onReset?.(current);
      }
      if (current === null) return;
      return swrEffect(fetch(current), value => {
        hasValue = true;
        onValue(value);
      }, {
        skipCached: options.cache === false || hasValue,
        onError: error => options.onError?.(error, hasValue),
      });
    });
  });
}
