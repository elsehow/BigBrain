import { expect, test } from 'bun:test';
import { graphView } from '../web/ui/src/lib/graph/view';
const nodes = [
  { id: 'a', path: 'memory/a.md', title: 'A', group: 'memory', degree: 1 },
  { id: 'b', path: 'sources/b.md', memberPaths: ['old-b.md'], title: 'B', group: 'source', degree: 2 },
  { id: 'c', title: 'C', group: 'source', degree: 1 },
];
const adjacency = [[1], [0, 2], [1]];
test('render membership resolves aliases, unions neighborhoods, and lets exclusions win', () => {
  const result = graphView(nodes, adjacency, { selected: ['memory/a.md', 'c'], excluded: ['old-b.md'] }, 'memory/a.md');
  expect(result.view).toEqual({ selected: ['a', 'c'], excluded: ['b'] });
  expect([...result.visible]).toEqual([0, 2]); expect(result.anchor).toBe(0);
});
test('excluded focus cannot reappear; unknown ids remain portable without phantom nodes', () => {
  const result = graphView(nodes, adjacency, { selected: ['missing', 'c'], excluded: ['memory/a.md'] }, 'a');
  expect(result.anchor).toBe(2); expect([...result.selected]).toEqual([2]);
  expect(result.view.selected).toEqual(['c', 'missing']);
});
