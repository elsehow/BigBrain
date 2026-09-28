import { expect, mock, test } from "bun:test";
import { createOverviewCache } from "../web/ui/src/lib/graphFocusCache";
import { compactOverview } from "../web/ui/src/lib/graphFocus";

const nodes = [{ id: "a", x: 0, y: 0, r: 3 }, { id: "b", x: 10, y: 10, r: 4 }];
const adj = [[1], [0]], visible = new Uint8Array([1, 0]);

test("finished overview survives remounts and reloads without rerunning the solver", () => {
  const values = new Map<string, string>();
  const storage = () => ({ getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } });
  const solve = mock(compactOverview), cached = createOverviewCache(storage, solve);
  const expected = compactOverview(nodes, adj, visible, 1);
  const first = cached(nodes, adj, visible, 1);
  expect(first).toEqual(expected);
  first[0]!.x = 999;
  expect(cached(nodes, adj, visible, 1)).toEqual(expected);
  expect(createOverviewCache(storage, solve)(nodes, adj, visible, 1)).toEqual(expected);
  expect(solve).toHaveBeenCalledTimes(1);
});

test("every layout input invalidates the cache, which holds only the latest picture", () => {
  const values = new Map<string, string>();
  const storage = () => ({ getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } });
  const solve = mock(compactOverview), cached = createOverviewCache(storage, solve);
  const inputs: Parameters<typeof compactOverview>[] = [
    [nodes, adj, visible, 1],
    [nodes.map(n => ({ ...n, x: n.x + 1 })), adj, visible, 1],
    [nodes.map(n => ({ ...n, r: n.r + 1 })), adj, visible, 1],
    [nodes.map(n => ({ ...n, id: n.id + "-new" })), adj, visible, 1],
    [nodes, [[], []], visible, 1],
    [nodes, adj, new Uint8Array([0, 1]), 1],
    [nodes, adj, visible, 0.5],
  ];
  for (const args of inputs.slice(1)) {
    cached(...inputs[0]!);
    const before = solve.mock.calls.length;
    expect(cached(...args)).toEqual(compactOverview(...args));
    expect(solve.mock.calls.length).toBe(before + 1);
  }
  expect(values.size).toBe(1);
});

test("corrupt or unavailable storage falls back to computing and retains an in-memory hit", () => {
  for (const getItem of [() => "{broken", () => { throw new Error("disabled"); }]) {
    const solve = mock(compactOverview);
    const cached = createOverviewCache(() => ({ getItem, setItem: () => { throw new Error("quota"); } }), solve);
    expect(cached(nodes, adj, visible, 1)).toEqual(compactOverview(nodes, adj, visible, 1));
    cached(nodes, adj, visible, 1);
    expect(solve).toHaveBeenCalledTimes(1);
  }
});
