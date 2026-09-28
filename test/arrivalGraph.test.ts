import { expect, test } from "bun:test";
import { withArrivals } from "../web/ui/src/lib/arrivalGraph";
import type { GraphData, GraphNode } from "../web/ui/src/lib/types";

const arrival: GraphNode = { id: "sources/new.md", path: "sources/new.md", title: "Inside the Internet", group: "source", degree: 0, pending: true };

test("a captured source is visible before any graph response", () => {
  const result = withArrivals(null, [arrival])!;
  expect(result.nodes).toEqual([arrival]);
  expect(result.edges).toEqual([]);
});

test("a stale graph keeps its nodes and layout while the arrival appears", () => {
  const graph: GraphData = { nodes: [{ ...arrival, id: "old", path: "old" }], edges: [], hash: "before" };
  const result = withArrivals(graph, [arrival])!;
  expect(result.nodes.map(n => n.id)).toEqual(["old", arrival.id]);
  expect(result.layoutBase).toBe(graph);
  expect(result.hash).not.toBe(graph.hash);
  expect(graph.nodes).toHaveLength(1);
});

test("the real graph replaces a receipt, including a source folded into a thread", () => {
  for (const node of [arrival, { ...arrival, id: "thread", path: "thread", memberPaths: [arrival.path!] }]) {
    const graph: GraphData = { nodes: [{ ...node, pending: undefined, degree: 2 }], edges: [], hash: "after" };
    expect(withArrivals(graph, [arrival])).toBe(graph);
  }
});

test("no arrivals leaves the loading and loaded graph unchanged", () => {
  expect(withArrivals(null, [])).toBeNull();
  const graph: GraphData = { nodes: [], edges: [], hash: "empty" };
  expect(withArrivals(graph, [])).toBe(graph);
});
