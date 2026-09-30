import { expect, test } from 'bun:test';
import { selectionSubgraph, SELECTION_DETAIL } from '../web/ui/src/lib/selectionSubgraph';
import type { GraphData } from '../web/ui/src/lib/types';
const graph: GraphData = {
  hash: 'synthetic-chain',
  nodes: ['a', 'b', 'c', 'd', 'e', 'island'].map(id => ({ id, path: `sources/${id}.md`, title: id, group: 'source', degree: 99 })),
  edges: [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e']].map(([source, target]) => ({ source: source!, target: target! })),
};
test('subset discards full-vault layout and recomputes degree; later selections expand from original topology', () => {
  const full = { ...graph, layoutBase: graph };
  const first = selectionSubgraph(full, { selected: ['sources/a.md'], excluded: [] }, null);
  expect(first.nodes.map(n => n.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  expect(first.nodes.map(n => n.degree)).toEqual([1, 2, 2, 2, 1]);
  expect(first.edges).toHaveLength(4);
  expect(first.layoutBase).toBeUndefined();
  expect(selectionSubgraph(full, { selected: ['a', 'c'], excluded: [] }, null).nodes.map(n => n.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  expect(selectionSubgraph(full, { selected: [], excluded: [] }, null)).toBe(full);
  expect(graph.nodes[0]!.degree).toBe(99);
});
test('excluded bridges, isolated nodes, unknown roots and route aliases', () => {
  expect(selectionSubgraph(graph, { selected: ['a'], excluded: ['sources/b.md'] }, null).nodes.map(n => n.id)).toEqual(['a']);
  expect(selectionSubgraph(graph, { selected: ['island'], excluded: [] }, null).edges).toEqual([]);
  expect(selectionSubgraph(graph, { selected: ['missing'], excluded: [] }, null).nodes).toEqual([]);
  expect(selectionSubgraph(graph, { selected: [], excluded: [] }, 'sources/e.md').nodes.map(n => n.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
});

test('bounded relevance view pins the seed, preserves paths, caches and does not promote memories', () => {
  const large: GraphData = {
    hash: 'synthetic-hubs',
    nodes: Array.from({ length: 300 }, (_, i) => ({ id: `node-${i}`, title: `Sample ${i}`, group: i === 299 ? 'memory' : 'entity', degree: 0 })),
    edges: Array.from({ length: 299 }, (_, i) => ({ source: `node-${Math.floor(i / 3)}`, target: `node-${i + 1}` })),
  };
  const view = { selected: ['node-0'], excluded: [] };
  const sub = selectionSubgraph(large, view, null);
  expect(sub.nodes).toHaveLength(SELECTION_DETAIL);
  expect(selectionSubgraph(large, view, null)).toBe(sub);
  const root = sub.nodes.find(n => n.id === 'node-0')!;
  expect([root.x, root.y, root.relevance]).toEqual([0, 0, 1]);
  expect(sub.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y) && n.relevance! > 0)).toBe(true);
  expect(sub.nodes.some(n => n.id === 'node-299')).toBe(false);
  const reached = new Set(['node-0']);
  for (let i = 0; i < sub.nodes.length; i++) for (const e of sub.edges) {
    if (reached.has(e.source)) reached.add(e.target);
    if (reached.has(e.target)) reached.add(e.source);
  }
  expect(reached.size).toBe(sub.nodes.length);
  const changed = selectionSubgraph(large, { selected: ['node-1'], excluded: ['node-0'] }, null);
  expect(changed).not.toBe(sub);
  expect(changed.nodes.some(n => n.id === 'node-0')).toBe(false);
  expect(changed.nodes.find(n => n.id === 'node-1')!.relevance).toBe(1);
  const combined = selectionSubgraph(large, { selected: ['node-1', 'node-299'], excluded: [] }, null);
  expect(combined.nodes.filter(n => n.relevance === 1).map(n => n.id).sort()).toEqual(['node-1', 'node-299']);
});

test('cloud doubles detail without pinning the seed or overwriting the radial comparison', () => {
  const graph: GraphData = { hash: 'cloud-synthetic', nodes: Array.from({ length: 180 }, (_, i) => ({ id: String(i), title: `Sample ${i}`, group: 'entity', degree: 0 })), edges: [] };
  for (let i = 1; i < 180; i++) {
    graph.edges.push({ source: String(i - 1), target: String(i) });
    if (i % 10) graph.edges.push({ source: String(Math.floor(i / 10) * 10), target: String(i) });
  }
  const view = { selected: ['30'], excluded: [] };
  const radial = selectionSubgraph(graph, view, null, 'radial');
  const cloud = selectionSubgraph(graph, view, null, 'cloud');
  expect(cloud.nodes).toHaveLength(120);
  expect(radial.nodes).toHaveLength(60);
  expect(cloud.selectionStyle).toBe('cloud');
  const seed = cloud.nodes.find(n => n.id === '30')!;
  expect(Math.hypot(seed.x!, seed.y!)).toBeGreaterThan(1);
  expect(cloud.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  expect(selectionSubgraph(graph, view, null, 'radial')).toBe(radial);
  expect(selectionSubgraph(graph, view, null, 'cloud')).toBe(cloud);
});
