import { expect, test } from 'bun:test';
import { selectionSubgraph } from '../web/ui/src/lib/selectionSubgraph';
import type { GraphData } from '../web/ui/src/lib/types';
const graph: GraphData = {
  hash: 'synthetic-chain',
  nodes: ['a', 'b', 'c', 'd', 'e', 'island'].map(id => ({ id, path: `sources/${id}.md`, title: id, group: 'source', degree: 99 })),
  edges: [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e']].map(([source, target]) => ({ source: source!, target: target! })),
};
test('subset discards full-vault layout and recomputes degree; later selections expand from original topology', () => {
  const full = { ...graph, layoutBase: graph };
  const first = selectionSubgraph(full, { selected: ['sources/a.md'], excluded: [] }, null);
  expect(first.nodes.map(n => n.id)).toEqual(['a', 'b', 'c']);
  expect(first.nodes.map(n => n.degree)).toEqual([1, 2, 1]);
  expect(first.edges).toHaveLength(2);
  expect(first.layoutBase).toBeUndefined();
  expect(selectionSubgraph(full, { selected: ['a', 'c'], excluded: [] }, null).nodes.map(n => n.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  expect(selectionSubgraph(full, { selected: [], excluded: [] }, null)).toBe(full);
  expect(graph.nodes[0]!.degree).toBe(99);
});
test('excluded bridges, isolated nodes, unknown roots and route aliases', () => {
  expect(selectionSubgraph(graph, { selected: ['a'], excluded: ['sources/b.md'] }, null).nodes.map(n => n.id)).toEqual(['a']);
  expect(selectionSubgraph(graph, { selected: ['island'], excluded: [] }, null).edges).toEqual([]);
  expect(selectionSubgraph(graph, { selected: ['missing'], excluded: [] }, null).nodes).toEqual([]);
  expect(selectionSubgraph(graph, { selected: [], excluded: [] }, 'sources/e.md').nodes.map(n => n.id)).toEqual(['c', 'd', 'e']);
});
