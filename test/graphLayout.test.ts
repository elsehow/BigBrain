import { describe, expect, test } from "bun:test";
import type { Graph } from "../lib/graph";
import { NODE_R_MAX, nodeRadius, nodeSpacing, seedPosition } from "../lib/graphGeometry";
import { computeLayout } from "../lib/graphLayout";
import { edgeKey, seatLayout } from "../lib/views/layout";

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

// A shared server's field (lib/sharedWorkspace.ts serverField): every reader
// of the same record must draw the same picture, and it must stay put as the
// record grows. `claims` claims arrive a minute apart, each naming two
// entities and citing its own source.
function grown(claims: number): { graph: Graph; arrivals: Map<string, string> } {
  const ids = new Set<string>(), links = new Map<string, [string, string]>(), arrivals = new Map<string, string>();
  const arrive = (key: string, at: string) => { if (!arrivals.has(key)) arrivals.set(key, at); };
  for (let k = 0; k < claims; k++) {
    const at = new Date(Date.UTC(2026, 8, 1, 0, k)).toISOString(), named = [`e${(k * 3) % 40}`, `e${(k * 7 + 1) % 40}`], source = `source:s${k}`;
    for (const id of [...named, source]) { ids.add(id); arrive(id, at); }
    for (const [a, b] of [[named[0]!, source], [named[1]!, source], [named[0]!, named[1]!]] as const) { links.set(edgeKey(a, b), [a, b]); arrive(edgeKey(a, b), at); }
  }
  return { graph: graph([...ids], [...links.values()], String(claims)), arrivals };
}

describe("seatLayout (lib/views/layout.ts): your field and a server's", () => {
  test("the same record draws the same picture, in whatever order it is read", () => {
    const { graph: g, arrivals } = grown(60);
    const reversed = { ...g, nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse() };
    expect(seatLayout(reversed, arrivals)).toEqual(seatLayout(g, arrivals));
  });

  test("what arrives later moves only what it links to, and only a little", () => {
    const before = grown(60), after = grown(70);
    const was = seatLayout(before.graph, before.arrivals), now = seatLayout(after.graph, after.arrivals);
    const touched = new Set(after.graph.edges.filter((e) => !before.arrivals.has(edgeKey(e.source, e.target))).flatMap((e) => [e.source, e.target]));
    for (const id of Object.keys(was)) if (!touched.has(id)) expect(now[id]).toEqual(was[id]!);
    const extent = Math.max(...Object.values(was).map(([x, y]) => Math.sqrt(x * x + y * y)));
    const moved = [...touched].filter((id) => was[id]).map((id) => dist(was[id]!, now[id]!) / extent);
    expect(Math.max(...moved)).toBeLessThan(0.3);
  });

  test("linked nodes sit closer than unlinked ones, and no two share a point", () => {
    const { graph: g, arrivals } = grown(80);
    const at = seatLayout(g, arrivals), ids = g.nodes.map((n) => n.id);
    const linked = g.edges.map((e) => dist(at[e.source]!, at[e.target]!));
    const pairs: number[] = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j += 7) pairs.push(dist(at[ids[i]!]!, at[ids[j]!]!));
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(linked)).toBeLessThan(mean(pairs));
    expect(new Set(Object.values(at).map((p) => p.join(","))).size).toBe(ids.length);
  });

  test("a node alone takes the open spiral, and positions are two decimals", () => {
    const at = seatLayout(graph(["a", "b"], []), new Map([["a", "1"], ["b", "2"]]));
    expect(at["a"]).not.toEqual(at["b"]);
    for (const [x, y] of Object.values(at)) { expect(Math.round(x * 100) / 100).toBe(x); expect(Math.round(y * 100) / 100).toBe(y); }
  });
});
