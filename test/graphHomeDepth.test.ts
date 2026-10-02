import { expect, test } from 'bun:test';
import { anchorHomeDepth, overviewAnchors } from '../web/ui/src/lib/graphHomeDepth';

test('memories stay above direct notes, including when memories link to each other', () => {
  const groups = ['memory', 'memory', 'source', 'entity', 'source'], adjacency = [[1, 2], [0, 3], [0], [1], []];
  expect([...anchorHomeDepth(overviewAnchors(groups, adjacency), adjacency)]).toEqual([64, 64, -18, -18, -100]);
});

test('memories are the only anchors once a vault has one', () => {
  expect(overviewAnchors(['memory', 'entity', 'source', 'source'], [[2], [2], [0, 1], []])).toEqual([true, false, false, false]);
});

test('before the first memory, entities and the sources no entity cites stand in', () => {
  // A member who has only joined a shared vault: two cited sources, one uncited.
  const groups = ['entity', 'source', 'source', 'source'], adjacency = [[1, 2], [0], [0], []];
  const anchors = overviewAnchors(groups, adjacency);
  expect(anchors).toEqual([true, false, false, true]);
  expect([...anchorHomeDepth(anchors, adjacency)]).toEqual([64, -18, -18, 64]);
});

test('a vault of sources alone is all anchors, so none of it sinks out of sight', () => {
  expect(overviewAnchors(['source', 'source'], [[], []])).toEqual([true, true]);
  expect(overviewAnchors([], [])).toEqual([]);
});
