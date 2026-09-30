import { expect, test } from 'bun:test';
import { continueNeighborhood } from '../web/ui/src/lib/graph/continuity';
import type { GraphData } from '../web/ui/src/lib/types';
test('shared nodes start where they were, selected node stays fixed, arrivals begin near neighbors', () => {
  const graph: GraphData = { nodes: Array.from({ length: 4 }, (_, i) => ({ id: `node-${i}`, title: `Sample ${i}`, group: 'source', degree: 2 })), edges: [{ source: 'node-0', target: 'node-1' }, { source: 'node-1', target: 'node-2' }, { source: 'node-2', target: 'node-3' }] };
  const previous = new Map([['node-0', { x: 100, y: 50 }], ['node-1', { x: 140, y: 50 }], ['node-2', { x: 180, y: 60 }]]);
  const before = JSON.stringify(graph);
  const layout = continueNeighborhood(graph, previous, new Set(['node-1']));
  expect(layout.from.slice(0,3)).toEqual([...previous.values()]);
  expect(layout.to[1]).toEqual(previous.get('node-1'));
  expect(Math.hypot(layout.from[3]!.x - 180, layout.from[3]!.y - 60)).toBeCloseTo(10);
  expect(layout.to.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  expect(Math.hypot(layout.to[0]!.x - 100, layout.to[0]!.y - 50)).toBeLessThan(25);
  expect(JSON.stringify(graph)).toBe(before);
});
