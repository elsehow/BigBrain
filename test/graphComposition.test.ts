import { test, expect } from 'bun:test';
import { composeNeighborhood, neighborhoodLandmarks } from '../web/ui/src/lib/graph/composition';
import type { GraphNode } from '../web/ui/src/lib/types';
const nodes: GraphNode[] = Array.from({ length: 12 }, (_, i) => ({ id: `sample-${i}`, title: `Sample ${i}`, group: 'source', degree: 3, relevance: 1 - i * .04, x: Math.floor(i / 4) * 100 + i % 4, y: i % 4 * 10 }));
test('landmarks spread across groups and do not repeat the selected root', () => {
  const chosen = neighborhoodLandmarks(nodes, new Set([0]));
  expect(chosen.has(0)).toBe(false);
  expect(chosen.size).toBeLessThanOrEqual(4);
  expect([...chosen].some(i => i >= 4 && i < 8)).toBe(true);
  expect([...chosen].some(i => i >= 8)).toBe(true);
  expect(neighborhoodLandmarks(nodes, new Set([0]))).toEqual(chosen);
});
test('composition keeps the full silhouette inside the room in wide and narrow windows', () => {
  const box = { minX: 0, maxX: 203, minY: 0, maxY: 30 };
  for (const w of [240, 1000]) {
    const fit = composeNeighborhood(box, { w, h: 700, top: 60, bottom: 100 }, nodes);
    expect(box.minX * fit.scale + fit.tx).toBeGreaterThanOrEqual(w * .05 - 1e-6);
    expect(box.maxX * fit.scale + fit.tx).toBeLessThanOrEqual(w * .95 + 1e-6);
    expect(box.minY * fit.scale + fit.ty).toBeGreaterThanOrEqual(60);
    expect(box.maxY * fit.scale + fit.ty).toBeLessThanOrEqual(600);
  }
});
