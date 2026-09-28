import { expect, test } from 'bun:test';
import { GraphHoverHistory } from '../web/ui/src/lib/graphHoverHistory';
const ids = ['a', 'b', 'shared', 'untouched'];

test('latest neighborhood stays forward, past neighborhoods sit above untouched nodes', () => {
  const h = new GraphHoverHistory();
  h.enter(['a', 'shared'], ids, 0);
  expect([...h.sample(ids, 400).offsets]).toEqual([0, -80, 0, -80]);
  h.enter(['b', 'shared'], ids, 500);
  expect([...h.sample(ids, 900).offsets]).toEqual([-3.5, 0, 0, -80]);
  for (let i = 0; i < 10; i++) h.enter(['b'], ids, 1000 + i * 400);
  const result = h.sample(ids, 6000).offsets;
  expect(result[0]).toBe(-13);
  expect(result[0]!).toBeGreaterThan(result[3]!);
});

test('leaving holds for 2.5 seconds then returns with a cosine ease', () => {
  const h = new GraphHoverHistory();
  h.enter(['a'], ids, 0); h.leave(400);
  expect(h.sample(ids, 2899).offsets[1]).toBe(-80);
  expect(h.sample(ids, 2899).moving).toBe(false);
  expect(h.sample(ids, 2900 + 900).offsets[1]).toBeCloseTo(-40);
  expect([...h.sample(ids, 4700).offsets]).toEqual([0, 0, 0, 0]);
});

test('a new hover interrupts return continuously and reset clears all history', () => {
  const h = new GraphHoverHistory();
  h.enter(['a'], ids, 0); h.leave(400);
  const before = [...h.sample(ids, 3800).offsets];
  h.enter(['b'], ids, 3800);
  expect([...h.sample(ids, 3800).offsets]).toEqual(before);
  expect([...h.sample(ids, 4200).offsets]).toEqual([-3.5, 0, -80, -80]);
  h.clear();
  expect([...h.sample(ids, 4600).offsets]).toEqual([0, 0, 0, 0]);
});
