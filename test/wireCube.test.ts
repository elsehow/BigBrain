import { expect, test } from "bun:test";
import { flatWire, HOLD_MS, TURN_MS, wirePose } from "../web/ui/src/lib/v2/wireMotion";

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

const count = (d: string, c: string) => d.split(c).length - 1;
const coords = (d: string) => d.split(/[MLZ ]/).filter(Boolean).map(Number);

test("flat, at rest, the cube shows three faces and their nine edges, a corner to the eye", () => {
  const { blocks, seam } = flatWire(0);
  expect(blocks).toHaveLength(1);
  expect(count(blocks[0]!.faces, "Z")).toBe(3);
  expect(count(blocks[0]!.edges, "M")).toBe(9);
  expect(blocks[0]!.seams).toBe("");
  expect(seam).toBe(0);
  const xs = coords(blocks[0]!.faces).filter((_, i) => i % 2 === 0);
  expect(Math.max(...xs)).toBeCloseTo(Math.SQRT2, 3);
  expect(Math.min(...xs)).toBeCloseTo(-Math.SQRT2, 3);
});

test("flat, mid-turn, two halves show, the seam between them, all inside the mark's box", () => {
  for (let move = 0; move < 6; move++) {
    const { blocks, seam } = flatWire(move * span + TURN_MS / 2);
    expect(blocks).toHaveLength(2);
    expect(seam).toBeCloseTo(1, 6);
    expect(blocks.some((b) => b.seams !== "")).toBe(true);
    for (const b of blocks) for (const v of coords(b.faces + b.edges + b.seams)) expect(Math.abs(v)).toBeLessThanOrEqual(Math.sqrt(3) + 1e-3);
  }
});
