import { expect, test } from 'bun:test';
import { selectionEdges } from '../web/ui/src/lib/graph/selectionEdges';
import { SELECTION_MOTION } from '../web/ui/src/lib/graph/motion';
import type { GraphData } from '../web/ui/src/lib/types';
test('dense graphs keep few, evenly styled links without drawing every hub spoke', () => {
  const graph: GraphData = { hash: 'dense-synthetic', nodes: Array.from({ length: 60 }, (_, i) => ({ id: String(i), title: `Sample ${i}`, degree: 59, group: 'entity', relevance: 1 - i / 70 })), edges: [] };
  for (let a = 0; a < 60; a++) for (let b = a + 1; b < 60; b++) graph.edges.push({ source: String(a), target: String(b), weight: a + b + 1 });
  const shown = selectionEdges(graph), counts = new Map<string, number>();
  expect(shown.size).toBe(12);
  for (const i of shown) for (const id of [graph.edges[i]!.source, graph.edges[i]!.target]) counts.set(id, (counts.get(id) ?? 0) + 1);
  expect([...counts.values()].every(n => n <= 2)).toBe(true);
  expect(counts.size).toBeLessThan(graph.nodes.length);
  expect(selectionEdges({ ...graph, edges: graph.edges.map(e => ({ ...e, weight: 1 })) })).toEqual(shown);
});
test('quick sinusoidal selection motion settles smoothly at both ends', () => {
  expect(SELECTION_MOTION.duration).toBeLessThan(650);
  expect(SELECTION_MOTION.sample(0).position).toBe(1);
  expect(SELECTION_MOTION.sample(0).positionRate).toBeCloseTo(0);
  expect(SELECTION_MOTION.sample(SELECTION_MOTION.duration).position).toBe(0);
  expect(SELECTION_MOTION.sample(SELECTION_MOTION.duration).positionRate).toBe(0);
  expect(SELECTION_MOTION.sample(SELECTION_MOTION.duration / 2).position).toBeCloseTo(.5);
});
