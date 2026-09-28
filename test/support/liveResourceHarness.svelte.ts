import { flushSync } from "svelte";
import { liveResource } from "../../web/ui/src/lib/liveResource.svelte";
import { app } from "../../web/ui/src/lib/store.svelte";

/** Real Svelte effects, without mounting a DOM component. */
export function resourceHarness() {
  let key = $state<string | null>("a");
  let value = $state<number | undefined>();
  const seen: number[] = [], errors: boolean[] = [], resets: Array<string | null> = [];
  const requests: Array<{ key: string; resolve: (value: number) => void; reject: (error: Error) => void }> = [];
  const dispose = $effect.root(() => {
    liveResource(() => key, key => ({ cached: key === "a" ? 0 : 10,
      fresh: new Promise<number>((resolve, reject) => requests.push({ key, resolve, reject })),
    }), next => {
      // Even callback reads must not become effect dependencies.
      if (value !== next) value = next;
      seen.push(next);
    }, { onReset: key => { resets.push(key); value = undefined; }, onError: (_error, hasValue) => errors.push(hasValue) });
  });
  flushSync();
  return { seen, errors, resets, requests,
    refresh() { flushSync(() => { app.rev++; }); },
    select(next: string | null) { flushSync(() => { key = next; }); },
    async settle() { await Promise.resolve(); await Promise.resolve(); flushSync(); },
    dispose,
  };
}
