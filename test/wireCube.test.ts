import { expect, test } from "bun:test";
import { HOLD_MS, TURN_MS, wirePose } from "../web/ui/src/lib/v2/wireCube";

const span = TURN_MS + HOLD_MS;

test("at rest, and through each hold, the cube is one block with no seam", () => {
  for (const t of [0, TURN_MS, TURN_MS + HOLD_MS / 2, span - 1, -50]) {
    expect(wirePose(t)).toMatchObject({ settled: true, angle: 0, seam: 0 });
  }
});

test("mid-turn, a half has turned partway and the seam shows fully", () => {
  const mid = wirePose(TURN_MS / 2);
  expect(mid.settled).toBe(false);
  expect(mid.angle).toBeCloseTo(Math.PI / 2, 5);
  expect(mid.seam).toBe(1);
});

test("the seam is unseen while the halves align, at a turn's start and end", () => {
  expect(wirePose(1).seam).toBeCloseTo(0, 6);
  expect(wirePose(TURN_MS - 1).seam).toBeCloseTo(0, 6);
});

test("the turn's angle only grows across a move", () => {
  let last = 0;
  for (let t = 1; t < TURN_MS; t += 20) { const a = wirePose(t).angle; expect(a).toBeGreaterThanOrEqual(last); last = a; }
  expect(last).toBeLessThanOrEqual(Math.PI);
});

test("six moves, then the walk begins again", () => {
  expect([0, 1, 2, 3, 4, 5, 6, 7].map((n) => wirePose(n * span + TURN_MS / 2).move)).toEqual([0, 1, 2, 3, 4, 5, 0, 1]);
});
