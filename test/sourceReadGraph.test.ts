import { test, expect } from 'bun:test';
import { withSourceReadStates } from '../web/ui/src/lib/sourceReadGraph';
import type { GraphData } from '../web/ui/src/lib/types';
const a = 'log/insertions/a.json', b = 'log/insertions/b.json';
const graph: GraphData = { hash: 'stable', nodes: [{ id: 'thread', path: a, memberPaths: [a, b], title: 'Thread', group: 'source', degree: 1, x: 10, y: 20 }], edges: [] };
const row = (path: string, unread: boolean | null) => ({ path, title: 'Message', readState: { unread, writable: true, provider: 'email', status: 'synced' as const } });
test('thread attention follows any unread member and preserves unknown coverage', () => {
  expect(withSourceReadStates(graph, [row(a, false), row(b, true)])!.nodes[0]!.readState!.unread).toBe(true);
  expect(withSourceReadStates(graph, [row(a, false), row(b, false)])!.nodes[0]!.readState!.unread).toBe(false);
  expect(withSourceReadStates(graph, [row(a, false)])!.nodes[0]!.readState!.unread).toBeNull();
  const overlaid = withSourceReadStates(graph, [row(a, true)])!;
  expect(overlaid.layoutBase).toBe(graph);
  expect(overlaid.hash).toBe(graph.hash);
  expect(overlaid.nodes[0]).toMatchObject({ x: 10, y: 20 });
  expect(graph.nodes[0]!.readState).toBeUndefined();
});
