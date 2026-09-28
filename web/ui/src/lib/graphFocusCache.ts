import { vaultStorageKey } from "./vaultScope";
import { compactOverview } from "./graphFocus";

// One finished display layout, in memory and across reloads of this tab.
// Key the actual solver inputs: the graph hash alone does not cover settled
// coordinates, live overview membership, or playground controls.
const KEY = "bb:overview-layout:1";
export type Positions = ReturnType<typeof compactOverview>;
export type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export const overviewKey = (nodes: Parameters<typeof compactOverview>[0], adj: Parameters<typeof compactOverview>[1], visible: Uint8Array, amount: number) =>
  JSON.stringify([vaultStorageKey("overview"), nodes.map(n => [n.id, n.x, n.y, n.r]), adj, Array.from(visible), amount]);

export function createOverviewStore(storage: () => Storage) {
  let held: { key: string; positions: Positions } | undefined;
  return {
    read(key: string, count: number): Positions | undefined {
      if (held?.key !== key) {
        try {
          const raw = storage().getItem(vaultStorageKey(KEY));
          const saved = raw ? JSON.parse(raw) : null;
          if (saved?.key === key && Array.isArray(saved.positions) && saved.positions.length === count
            && saved.positions.every((p: { x?: number; y?: number } | null) => p && Number.isFinite(p.x) && Number.isFinite(p.y))) held = saved;
        } catch { /* Storage is optional. */ }
      }
      return held?.key === key ? held.positions.map(p => ({ ...p })) : undefined;
    },
    write(key: string, positions: Positions): void {
      held = { key, positions: positions.map(p => ({ ...p })) };
      try { storage().setItem(vaultStorageKey(KEY), JSON.stringify(held)); } catch { /* Memory cache still works. */ }
    },
  };
}

export function createOverviewCache(storage: () => Storage, solve = compactOverview): typeof compactOverview {
  const cache = createOverviewStore(storage);
  return (...args) => {
    const key = overviewKey(...args);
    const hit = cache.read(key, args[0].length);
    if (hit) return hit;
    const positions = solve(...args);
    cache.write(key, positions);
    return positions.map(p => ({ ...p }));
  };
}

export const cachedCompactOverview = createOverviewCache(() => sessionStorage);
