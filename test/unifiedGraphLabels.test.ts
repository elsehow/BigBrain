import { expect, test } from 'bun:test';
import { placeGraphLabels, type LabelCandidate } from '../web/ui/src/lib/graph/labels';
const viewport = { width: 600, height: 400 };
const candidate = (key: string, priority = 3): LabelCandidate => ({ key, index: 0, x: 300, y: 200, width: 180, gap: 12, priority, opacity: 1 });
test('crowded labels prioritize focus and hover, then yield without overlapping', () => {
  const boxes = placeGraphLabels([candidate('home'), candidate('selected', 0), { ...candidate('hover', 1), above: true }], viewport);
  expect(boxes.map(b => b.key)).toEqual(['selected', 'hover']);
  expect(boxes[0]!.top).toBeGreaterThan(200); expect(boxes[1]!.top + boxes[1]!.height).toBeLessThan(200);
});
test('labels fit at screen edges and offscreen or faint labels do not block others', () => {
  const boxes = placeGraphLabels([{ ...candidate('off', 0), x: -1 }, { ...candidate('faint', 0), opacity: .01 },
    { ...candidate('edge'), x: 595, y: 380 }], viewport);
  expect(boxes.length).toBe(1); expect(boxes[0]!.key).toBe('edge');
  expect(boxes[0]!.left + boxes[0]!.width).toBeLessThan(600); expect(boxes[0]!.top + boxes[0]!.height).toBeLessThan(380);
});
