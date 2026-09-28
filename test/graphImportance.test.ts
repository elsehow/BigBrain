import { expect, test } from "bun:test";
import { briefingConnections, graphImportance, importantConnections, personalizedPageRank } from "../lib/graphImportance";
import { connectionRankingFixture } from "./support/connectionRankingFixture";

test("memory support outranks general hubs, with connectivity only breaking support ties and live work first", () => {
  const graph = { nodes: [
    { id: "hub", group: "entity", memorySupport: 0 },
    { id: "focused", group: "entity", memorySupport: 1 },
    { id: "broad", group: "entity", memorySupport: 0.1 },
    { id: "equal", group: "entity", memorySupport: 1 },
    { id: "memory", group: "memory", memorySupport: 0 },
    { id: "live", group: "source", live: "working", memorySupport: 0 },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `leaf-${i}`, group: "entity", memorySupport: 0 })),
  ], edges: [
    ...Array.from({ length: 30 }, (_, i) => ({ source: "hub", target: `leaf-${i}` })),
    { source: "focused", target: "memory" }, { source: "focused", target: "equal" },
    { source: "broad", target: "memory" },
  ] };
  const { scores } = graphImportance(graph);
  expect(scores[5]).toBeGreaterThan(scores[4]!);
  expect(scores[4]).toBeGreaterThan(scores[1]!);
  expect(scores[1]).toBeGreaterThan(scores[3]!);
  expect(scores[3]).toBeGreaterThan(scores[2]!);
  expect(scores[2]).toBeGreaterThan(scores[0]!);
  const reversed = graphImportance({ nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() });
  expect([...reversed.scores].reverse()).toEqual([...scores]);
  // Briefing PageRank does not inherit the overview's new memory ranking.
  const unweighted = { ...graph, nodes: graph.nodes.map(n => ({ ...n, memorySupport: undefined })) };
  expect(briefingConnections(graph, ["memory"]).map(l => l.node.id)).toEqual(briefingConnections(unweighted, ["memory"]).map(l => l.node.id));
});

const nodes = [
  { id: "centre", path: "centre.md", sourcePaths: ["original.md"], memberPaths: ["thread-member.md"], group: "source" },
  { id: "leaf-b", path: "b.md", group: "source" },
  { id: "memory", path: "memory.md", group: "memory" },
  { id: "hub", path: "hub.md", group: "entity" },
  { id: "live", path: "session.md", group: "source", live: "waiting" },
  { id: "leaf-a", path: "a.md", group: "source" },
  { id: "distant", path: "distant.md", group: "entity" },
];
const edges = [
  ...["leaf-b", "memory", "hub", "live", "leaf-a"].map(target => ({ source: "centre", target })),
  { source: "hub", target: "distant" }, { source: "hub", target: "memory" },
  { source: "hub", target: "centre" }, // duplicate pair
  { source: "centre", target: "centre" }, { source: "centre", target: "missing" },
];

test("navigation salience resolves source and member aliases", () => {
  const ranked = importantConnections({ nodes, edges }, "original.md");
  expect(importantConnections({ nodes, edges }, "thread-member.md")).toEqual(ranked);
  expect(ranked.map(n => n.id)).toEqual(["live", "memory", "hub", "leaf-a", "leaf-b"]);
});

test("briefing candidates rank by shared coverage then PageRank, independently of note type", () => {
  const graph = { nodes: ["a", "b", "c", "all", "pair-entity", "pair-source", "unique", "session"].map(id => ({
    id, path: `${id}.md`, group: ["all", "pair-source", "session"].includes(id) ? "source" : "entity", live: id === "session" ? "waiting" : undefined,
  })), edges: [
    ...["a", "b", "c"].map(source => ({ source, target: "all" })),
    ...["a", "b"].flatMap(source => ["pair-entity", "pair-source"].map(target => ({ source, target }))),
    { source: "a", target: "unique" }, { source: "a", target: "session" }, { source: "a", target: "b" },
    { source: "a", target: "pair-entity" }, // duplicate edges do not add coverage
  ] };
  const result = briefingConnections(graph, ["c", "a.md", "b", "a"]);
  expect(result.map(l => l.node.id)).toEqual(["all", "pair-entity", "pair-source", "session", "unique"]);
  expect(result.map(l => l.selected)).toEqual([["a", "b", "c"], ["a", "b"], ["a", "b"], ["a"], ["a"]]);
  expect(briefingConnections({ nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() }, ["b", "c", "a"])).toEqual(result);
  expect(briefingConnections(graph, ["a", "b", "c"], ["all.md", "b.md"]).map(l => l.node.id)).toEqual(["pair-entity", "pair-source", "session", "unique"]);
  const retyped = { ...graph, nodes: graph.nodes.map((node, i) => ({ ...node, group: ["memory", "source", "entity"][i % 3]!, path: `entities/${node.id}.md` })) };
  expect(briefingConnections(retyped, ["a", "b", "c"]).map(l => l.node.id)).toEqual(result.map(l => l.node.id));
});
test("shared links are ordered among themselves by selection-relative PageRank", () => {
  const graph = { nodes: ["a", "b", "z-local", "a-hub", "local-note", ...Array.from({ length: 30 }, (_, i) => `far-${i}`)]
    .map(id => ({ id, group: id === "z-local" ? "source" : "entity" })), edges: [
    ...["a", "b"].flatMap(source => ["z-local", "a-hub"].map(target => ({ source, target }))),
    { source: "a", target: "local-note" }, { source: "z-local", target: "local-note" },
    ...Array.from({ length: 30 }, (_, i) => ({ source: "a-hub", target: `far-${i}` })),
  ] };
  const result = briefingConnections(graph, ["a", "b"]);
  expect(result.map(l => l.node.id)).toEqual(["z-local", "a-hub", "local-note"]);
  expect(result.slice(0, 2).map(l => l.selected)).toEqual([["a", "b"], ["a", "b"]]);
});

test("personalization preserves probability, handles isolates, and weights unique seeds equally", () => {
  const adjacency = [[1], [0], []];
  const pair = personalizedPageRank(adjacency, [0]);
  expect(pair[0]).toBeCloseTo(10 / 17, 8);
  expect(pair[1]).toBeCloseTo(7 / 17, 8);
  expect(pair[2]).toBe(0);
  expect([...personalizedPageRank(adjacency, [2])]).toEqual([0, 0, 1]);
  const joint = personalizedPageRank(adjacency, [0, 2, 0, -1, 99]);
  expect([...joint]).toEqual([...personalizedPageRank(adjacency, [0, 2])]);
  const symmetric = personalizedPageRank(adjacency, [0, 1, 0]);
  expect(symmetric[0]).toBeCloseTo(0.5, 8);
  expect(symmetric[1]).toBeCloseTo(0.5, 8);
  expect(joint.reduce((sum, score) => sum + score, 0)).toBeCloseTo(1, 10);
  expect([...personalizedPageRank(adjacency, [])]).toEqual([0, 0, 0]);
});

test("briefings promote the selected neighborhood over a globally central outsider without returning indirect targets", () => {
  const graph = connectionRankingFixture();
  expect(importantConnections(graph, "focus")[0]!.id).toBe("hub");
  const ids = briefingConnections(graph, ["focus"]).map(link => link.node.id);
  for (const local of ["partner", "clinic", "school"]) expect(ids.indexOf(local)).toBeLessThan(ids.indexOf("hub"));
  expect(ids).not.toContain("distant-0");
  expect(ids).not.toContain("focus");
  // Being selected elsewhere changes the ranking: the same hub is now direct context.
  expect(briefingConnections(graph, ["distant-0"]).map(link => link.node.id)).toEqual(["hub"]);
  expect(briefingConnections(graph, ["entities/focus.md", "focus"])).toEqual(briefingConnections(graph, ["focus"]));
  expect(briefingConnections({ nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() }, ["focus"])).toEqual(briefingConnections(graph, ["focus"]));
  expect(briefingConnections({ ...graph, edges: [...graph.edges, ...graph.edges] }, ["focus"])).toEqual(briefingConnections(graph, ["focus"]));
});

test("briefing walks respect exclusions, preserve shared coverage, and do not inherit live-source prominence", () => {
  const graph = connectionRankingFixture();
  const removed = "local-note";
  const pruned = { nodes: graph.nodes.filter(n => n.id !== removed), edges: graph.edges.filter(e => e.source !== removed && e.target !== removed) };
  expect(briefingConnections(graph, ["focus"], [`entities/${removed}.md`])).toEqual(briefingConnections(pruned, ["focus"]));
  expect(briefingConnections(graph, ["focus"], ["focus"])).toEqual([]);
  expect(briefingConnections(graph, ["unknown"])).toEqual([]);
  const joint = briefingConnections(graph, ["school", "focus"]);
  expect(joint[0]!.selected).toEqual(["focus", "school"]);
  expect(joint.map(link => link.node.id)).not.toContain("school");
  const live = { ...graph, nodes: graph.nodes.map(n => ({ ...n, group: "source", path: `references/${n.id}.md`, live: n.id === "hub" ? "waiting" : undefined })) };
  const quiet = { ...live, nodes: live.nodes.map(n => ({ ...n, live: undefined })) };
  expect(briefingConnections(live, ["focus"]).map(link => link.node.id)).toEqual(briefingConnections(quiet, ["focus"]).map(link => link.node.id));
});
