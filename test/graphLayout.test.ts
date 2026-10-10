import { describe, expect, test } from "bun:test";
import type { Graph } from "../lib/graph";
import { NODE_R_MAX, nodeRadius, nodeSpacing, seedPosition } from "../lib/graphGeometry";
import { computeLayout, neighbourSignatures, placeLayout } from "../lib/graphLayout";

// The force layout, moved out of the browser (web/ui/src/lib/layout.worker.ts,
// deleted 2026-08-17). What matters is not the exact coordinates — a force
// layout has no canonical answer — but the properties a renderer depends on:
// every node placed, finite, linked nodes near, unlinked clusters apart, and
// continuity across a structure change.

const graph = (ids: string[], edges: [string, string][] = [], hash = "h"): Graph => ({
  nodes: ids.map((id) => ({ id, title: id, group: "entity", degree: edges.filter((e) => e.includes(id)).length })),
  edges: edges.map(([source, target]) => ({ source, target })),
  hash,
});

const dist = (p: [number, number], q: [number, number]): number => Math.hypot(p[0] - q[0], p[1] - q[1]);

describe("computeLayout", () => {
  test("places every node at a finite coordinate", () => {
    const out = computeLayout(graph(["a", "b", "c"], [["a", "b"]]));
    expect(Object.keys(out).sort()).toEqual(["a", "b", "c"]);
    for (const [x, y] of Object.values(out)) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  test("an empty graph is not an error", () => {
    expect(computeLayout(graph([]))).toEqual({});
  });

  test("linked nodes end up closer than unlinked ones", () => {
    // Two pairs, each internally linked, nothing between them: the link force
    // pulls each pair together while charge pushes the pairs apart.
    const out = computeLayout(graph(["a", "b", "x", "y"], [["a", "b"], ["x", "y"]]));
    const linked = dist(out["a"]!, out["b"]!);
    const across = dist(out["a"]!, out["x"]!);
    expect(linked).toBeLessThan(across);
  });

  test("no two nodes land on the same point", () => {
    // Collide is what keeps discs apart; coincident nodes would render as one.
    const out = computeLayout(graph(["a", "b", "c", "d", "e", "f"], [["a", "b"], ["a", "c"], ["a", "d"], ["a", "e"], ["a", "f"]]));
    const seen = new Set(Object.values(out).map(([x, y]) => `${x},${y}`));
    expect(seen.size).toBe(Object.keys(out).length);
  });

  test("seeding from a previous layout keeps survivors in place", () => {
    const before = computeLayout(graph(["a", "b", "c"], [["a", "b"], ["b", "c"]]));
    const after = computeLayout(graph(["a", "b", "c", "d"], [["a", "b"], ["b", "c"], ["c", "d"]]), before);
    // Seeded, `a` drifts. Cold, it would be re-thrown across the canvas.
    expect(dist(after["a"]!, before["a"]!)).toBeLessThan(100);
  });

  test("an edge naming a node that is not in the graph is dropped, not followed", () => {
    // a builder may cut orphans AFTER building edges; this module must not
    // depend on that ordering holding, or forceLink walks an undefined node
    // and every coordinate becomes NaN.
    const g = graph(["a", "b"], [["a", "b"]]);
    g.edges.push({ source: "a", target: "ghost" });
    const out = computeLayout(g);
    expect(Object.keys(out).sort()).toEqual(["a", "b"]);
    for (const [x, y] of Object.values(out)) expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
  });

  test("positions are rounded to 2dp — a third of the payload, below what a canvas shows", () => {
    const out = computeLayout(graph(["a", "b"], [["a", "b"]]));
    for (const [x, y] of Object.values(out)) {
      expect(Math.round(x * 100) / 100).toBe(x);
      expect(Math.round(y * 100) / 100).toBe(y);
    }
  });
});

describe("graphGeometry", () => {
  // The layout and the renderer are now on opposite sides of the wire and
  // must agree on how big a node is; these pin the shared formula.
  test("radius grows with degree and is capped", () => {
    expect(nodeRadius(0)).toBe(1.5);
    expect(nodeRadius(1)).toBeCloseTo(2.05, 5);
    expect(nodeRadius(9)).toBeCloseTo(3.15, 5);
    expect(nodeRadius(100_000)).toBe(NODE_R_MAX);
    expect(nodeRadius(4)).toBeLessThan(nodeRadius(16));
  });

  test("the layout spaces a leaf as the bigger discs did", () => {
    // 4 + √1 × 1.4 + the force's 2 = 7.4 was a leaf's collision radius when
    // the discs were discs; the pinprick keeps the room.
    expect(nodeSpacing(1)).toBeGreaterThanOrEqual(7.4);
    expect(nodeSpacing(1)).toBeGreaterThan(nodeRadius(1));
  });

  test("the seed spreads nodes instead of stacking them on the origin", () => {
    const seeds = Array.from({ length: 50 }, (_, i) => seedPosition(i));
    expect(new Set(seeds.map(([x, y]) => `${x},${y}`)).size).toBe(50);
    // Monotonically outward: the spiral's radius is 12*sqrt(i+0.5).
    expect(Math.hypot(...seeds[49]!)).toBeGreaterThan(Math.hypot(...seeds[0]!));
  });
});

describe("placeLayout", () => {
  // Twenty fabricated hubs of ten leaves each: a settled vault in miniature.
  const ids: string[] = [], edges: [string, string][] = [];
  for (let h = 0; h < 20; h++) {
    ids.push(`hub${h}`);
    for (let l = 0; l < 10; l++) { ids.push(`leaf${h}-${l}`); edges.push([`hub${h}`, `leaf${h}-${l}`]); }
  }
  const base = graph(ids, edges);
  const settled = computeLayout(base);
  const before = neighbourSignatures(base);
  const nearest = (out: Record<string, [number, number]>, id: string) =>
    Math.min(...Object.entries(out).filter(([o]) => o !== id).map(([, p]) => dist(p, out[id]!)));

  test("a new node lands by what it connects to, and nothing else moves", () => {
    const next = graph([...ids, "new"], [...edges, ["new", "leaf3-4"]]);
    const placed = placeLayout(next, settled, before)!;
    // it and the leaf it joined moved; every other node stands exactly where it was
    expect(placed.moved).toBe(2);
    for (const id of ids) if (id !== "leaf3-4") expect(placed.positions[id]).toEqual(settled[id]!);
    expect(dist(placed.positions["new"]!, placed.positions["leaf3-4"]!)).toBeLessThan(80);
    expect(nearest(placed.positions, "new")).toBeGreaterThan(nodeSpacing(1));
  });

  test("a node that was alone joins what it now connects to", () => {
    const lonely = graph([...ids, "drop"], edges);
    const withDrop = placeLayout(lonely, settled, before)!;
    const filed = graph([...ids, "drop"], [...edges, ["drop", "hub7"]]);
    const placed = placeLayout(filed, withDrop.positions, neighbourSignatures(lonely))!;
    expect(dist(placed.positions["drop"]!, placed.positions["hub7"]!)).toBeLessThan(120);
  });

  test("a lone new node lands among the lone nodes a settle spread, not outside them", () => {
    const loners = Array.from({ length: 12 }, (_, i) => `alone${i}`);
    const field = graph([...ids, ...loners], edges);
    const spread = computeLayout(field);
    const placed = placeLayout(graph([...ids, ...loners, "arrival"], edges), spread, neighbourSignatures(field))!;
    const radii = loners.map((id) => Math.hypot(...spread[id]!));
    const r = Math.hypot(...placed.positions["arrival"]!);
    expect(r).toBeGreaterThan(Math.min(...radii) - 60);
    expect(r).toBeLessThan(Math.max(...radii) + 60);
  });

  test("a change that moves no connection places nothing", () => {
    const reweighed: Graph = { ...base, edges: base.edges.map((e, i) => (i ? e : { ...e, weight: 2 })), hash: "h2" };
    expect(placeLayout(reweighed, settled, before)).toEqual({ positions: settled, moved: 0 });
  });

  test("a graph mostly new is settled whole, not placed", () => {
    expect(placeLayout(base, { hub0: settled["hub0"]! }, before)).toBeUndefined();
  });
});
