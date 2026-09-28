import { expect, test } from 'bun:test';
import { memoryHomeDepth } from '../web/ui/src/lib/graphHomeDepth';

test('memories stay above direct notes, including when memories link to each other', () => {
  expect([...memoryHomeDepth(['memory', 'memory', 'source', 'entity', 'source'], [[1, 2], [0, 3], [0], [1], []])]).toEqual([64, 64, -18, -18, -100]);
});
