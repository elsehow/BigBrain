import { test, expect } from 'bun:test';
import { graphChoreography } from '../web/ui/src/lib/graph/choreography';
test('departure, edge and label reveals overlap in order and settle exactly', () => {
  expect(graphChoreography(0)).toEqual({ departing: 1, edges: 0, labels: 0 });
  expect(graphChoreography(150)).toEqual({ departing: 0, edges: 0, labels: 0 });
  expect(graphChoreography(300).edges).toBeGreaterThan(0);
  expect(graphChoreography(300).labels).toBe(0);
  expect(graphChoreography(500).labels).toBeGreaterThan(0);
  expect(graphChoreography(560)).toEqual({ departing: 0, edges: 1, labels: 1 });
  expect(graphChoreography(0, true)).toEqual({ departing: 0, edges: 1, labels: 1 });
});
