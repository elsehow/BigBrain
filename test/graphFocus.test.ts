import { expect, test } from "bun:test";
import { compactOverview, overviewNodes } from "../web/ui/src/lib/graphFocus";

test("overview budgets use stable importance ranking and nested sets", () => {
  const scores = new Float32Array([0.9, 1.6, 0.9, 0.3]);
  const ids = ["b", "live", "a", "leaf"];
  expect([...overviewNodes(scores, 2, ids)]).toEqual([0, 1, 1, 0]);
  expect([...overviewNodes(scores, 3, ids)]).toEqual([1, 1, 1, 0]);
  expect([...overviewNodes(scores, 100, ids)]).toEqual([1, 1, 1, 1]);
  expect([...overviewNodes(new Float32Array(), 100)]).toEqual([]);
});

test("connected overview keeps bridge notes and excludes peripheral components within its budget", () => {
  const scores = new Float32Array([1, 0.1, 0.9, 0.8, 0.2, 1.6, 1.2]);
  const adj = [[1], [0, 2], [1, 3], [2, 4], [3], [6], [5]];
  expect([...overviewNodes(scores, 3, [], adj)]).toEqual([1, 1, 1, 0, 0, 0, 0]);
  expect([...overviewNodes(scores, 4, [], adj)]).toEqual([1, 1, 1, 1, 0, 0, 0]);
  expect([...overviewNodes(scores, 100, [], adj)]).toEqual([1, 1, 1, 1, 1, 0, 0]);
  expect([...overviewNodes(scores, 3, [], adj, false)]).toEqual([1, 0, 0, 0, 0, 1, 1]);
});

test("connected overview handles empty graphs, isolates and deterministic component ties", () => {
  expect([...overviewNodes(new Float32Array(), 10, [], [])]).toEqual([]);
  expect([...overviewNodes(new Float32Array([0.4, 0.8]), 10, [], [[], []])]).toEqual([1, 1]);
  const adj = [[1], [0], [3], [2]];
  expect([...overviewNodes(new Float32Array([1, 1, 1, 1]), 10, ["z", "y", "a", "b"], adj)])
    .toEqual([0, 0, 1, 1]);
});

test("compaction is deterministic, preserves data, and hidden nodes exert no layout forces", () => {
  const nodes = [{ id: "a", x: -800, y: 0, r: 6 }, { id: "b", x: 800, y: 0, r: 6 }];
  const original = structuredClone(nodes), adj = [[1], [0]];
  const mask = new Uint8Array([1, 1]);
  const positions = compactOverview(nodes, adj, mask, 1);
  expect(Math.abs(positions[0]!.x - positions[1]!.x)).toBeLessThan(200);
  expect(positions).toEqual(compactOverview(nodes, adj, mask, 1));
  expect(nodes).toEqual(original);
  expect(compactOverview(nodes, adj, mask, 0)).toEqual(nodes.map(({ x, y }) => ({ x, y })));
  const withHidden = [...nodes, { id: "hidden", x: 8000, y: 0, r: 100 }];
  const extended = compactOverview(withHidden, [[1, 2], [0], [0]], new Uint8Array([1, 1, 0]), 1);
  expect(extended.slice(0, 2)).toEqual(positions);
  // A large background dot may leave the original 90-unit tether to avoid overlap.
  expect(Math.hypot(extended[2]!.x - extended[0]!.x, extended[2]!.y - extended[0]!.y)).toBeGreaterThanOrEqual(120);
  expect(compactOverview([], [], new Uint8Array(), 1)).toEqual([]);
});

test("revealed background siblings have collision space without moving the overview", () => {
  const nodes = [
    { id: "hub", x: 0, y: 0, r: 6 },
    ...Array.from({ length: 24 }, (_, i) => ({ id: `leaf-${i}`, x: 1000 + i, y: 0, r: 5 })),
  ];
  const adj = [nodes.slice(1).map((_, i) => i + 1), ...nodes.slice(1).map(() => [0])];
  const visible = new Uint8Array(nodes.length); visible[0] = 1;
  const positions = compactOverview(nodes, adj, visible, 1);
  expect(positions[0]).toEqual(compactOverview(nodes.slice(0, 1), [[]], new Uint8Array([1]), 1)[0]);
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    expect(Math.hypot(positions[i]!.x - positions[j]!.x, positions[i]!.y - positions[j]!.y))
      .toBeGreaterThanOrEqual(nodes[i]!.r + nodes[j]!.r + 12);
  }
  expect(compactOverview(nodes, adj, visible, 1)).toEqual(positions);
});

test('an unorganized vault shows disconnected sources up to the overview limit',()=>{
 const scores=Float32Array.from([1,1,1,1]);
 expect(Array.from(overviewNodes(scores,3,['a','b','c','d'],[[],[],[],[]],true))).toEqual([1,1,1,0]);
});
