import { describe, expect, test } from "bun:test";
import {
  capTone, COLUMN, CUBE, faces, fill, FLIP, isSolved, movePose, poseAt, project, sideTone, SOLVED, STILL, TONE, TURN, VIEWBOX, WALK,
  type Face, type Point, type Pose,
} from "../web/ui/src/lib/logomark";

// The shipped still mark (web/ui/src/assets/logo.svg), face by face, as
// the "Logo cube" comp drew it at 44°: the big face, the column's top side
// (the cap), its left side (the sliver), then the body's left, right and top.
const SHIPPED: [number, number][][] = [
  [[76.8, 24.4], [54.4, 62.3], [32.8, 49.0], [55.2, 11.0]],
  [[44.8, 5.0], [55.2, 11.0], [32.8, 49.0], [22.4, 43.0]],
  [[22.4, 43.0], [32.8, 49.0], [54.4, 62.3], [44.0, 56.3]],
  [[39.2, 63.7], [60.0, 75.7], [60.0, 39.7], [39.2, 27.7]],
  [[91.2, 57.7], [60.0, 75.7], [60.0, 39.7], [91.2, 21.7]],
  [[70.4, 9.7], [91.2, 21.7], [60.0, 39.7], [39.2, 27.7]],
];

const ACTIVE = "var(--activity)";
const close = (a: Point, b: Point, tol = 0.1): boolean => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
const same = (got: readonly Point[], want: readonly Point[]): boolean =>
  got.length === want.length && want.every((w) => got.some((g) => close(g, w)));
const area = (pts: readonly Point[]): number =>
  Math.abs(pts.reduce((sum, [x, y], i) => { const [nx, ny] = pts[(i + 1) % pts.length]!; return sum + x * ny - nx * y; }, 0)) / 2;
/** is p inside (or on) the convex polygon poly */
const inside = (p: Point, poly: readonly Point[], tol = 0.15): boolean => {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (Math.abs(cross) / len <= tol) continue;
    const s = Math.sign(cross);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
};
/** the faces that tile a comp path: every vertex within it, areas summing to its own */
const tiling = (got: Face[], want: readonly Point[]): Face[] => {
  const parts = got.filter((f) => f.points.every((p) => inside(p, want)));
  const sum = parts.reduce((a, f) => a + area(f.points), 0);
  return Math.abs(sum - area(want)) < 0.02 * area(want) + 0.5 ? parts : [];
};
const solidFront = [project(36, 0, 0), project(0, 0, 0), project(0, 0, 36), project(36, 0, 36)];
const activeFaces = (pose: Pose): Face[] => faces(pose).filter((f) => f.fill === ACTIVE);
/** the same picture: face for face, fill and points (to a hair — a flip lands on -0s) */
const samePicture = (a: Face[], b: Face[]): boolean =>
  a.length === b.length && a.every((f, i) => f.fill === b[i]!.fill && same(f.points, b[i]!.points));
const activeArea = (pose: Pose): number => activeFaces(pose).reduce((a, f) => a + area(f.points), 0);

describe("logomark geometry", () => {
  test("the cube's corners land where the comp drew them", () => {
    expect(project(0, 0, 0)).toEqual([60, 39.7]);
    expect(close(project(24, 0, 0), [39.2, 27.7])).toBe(true);
    expect(close(project(0, 36, 0), [91.2, 21.7])).toBe(true);
    expect(close(project(0, 0, 36), [60, 75.7])).toBe(true);
    expect(close(project(24, 36, 0), [70.4, 9.7])).toBe(true);
  });

  test("the still pose tiles the shipped mark, path for path, to a tenth", () => {
    const got = faces(STILL);
    for (const want of SHIPPED) expect(tiling(got, want).length).toBeGreaterThan(0);
    // paint order: the column's inner face first, the body last
    expect(same(got[0]!.points, SHIPPED[0]!)).toBe(true);
    for (const f of got.slice(-5)) expect(SHIPPED.slice(3).some((w) => f.points.every((p) => inside(p, w)))).toBe(true);
  });

  test("the still mark's colours: the cap and the front-left face active, the rest in tones, the gap the right's", () => {
    const got = faces(STILL);
    for (const f of tiling(got, SHIPPED[1]!)) expect(f.fill).toBe(ACTIVE);
    for (const f of tiling(got, SHIPPED[3]!)) expect(f.fill).toBe(ACTIVE);
    // the sliver points front; with the face active it wears the right's grey, not the ink
    for (const f of tiling(got, SHIPPED[2]!)) expect(f.fill).toBe(fill(TONE.right));
    for (const f of tiling(got, SHIPPED[4]!)) expect(f.fill).toBe(fill(TONE.right));
    for (const f of tiling(got, SHIPPED[5]!)) expect(f.fill).toBe(fill(TONE.top));
    expect(got[0]!.fill).toBe(fill(TONE.right));
    expect(faces(STILL, { wings: "paper" })[0]!.fill).toBe("var(--bg)");
    const mono = faces(STILL, { active: false });
    expect(mono.some((f) => f.fill === ACTIVE)).toBe(false);
    for (const f of tiling(mono, SHIPPED[3]!)) expect(f.fill).toBe(fill(TONE.left));
    for (const f of tiling(mono, SHIPPED[2]!)) expect(f.fill).toBe(fill(TONE.left));
  });

  test("solved: the whole front-left face is active, and nothing else", () => {
    for (const pose of [SOLVED, { column: 270, top: 0 }, { column: 90, top: 180 }, { column: 270, top: 180 }]) {
      expect(isSolved(pose)).toBe(true);
      for (const f of activeFaces(pose)) expect(f.points.every((p) => inside(p, solidFront))).toBe(true);
      expect(activeArea(pose)).toBeCloseTo(area(solidFront), 0);
    }
  });

  test("a quarter turn of the top parks its third on the right face and leaves the front's top row grey", () => {
    const rightTop = [project(0, 36, 12), project(0, 0, 12), project(0, 0, 0), project(0, 36, 0)];
    const frontTop = [project(24, 0, 12), project(0, 0, 12), project(0, 0, 0), project(24, 0, 0)];
    const corner = [project(36, 0, 0), project(24, 0, 0), project(24, 0, 12), project(36, 0, 12)];
    for (const top of [90, 270]) {
      const pose = { column: 90, top };
      expect(isSolved(pose)).toBe(false);
      const got = faces(pose);
      expect(got.some((f) => f.fill === ACTIVE && same(f.points, rightTop))).toBe(true);
      // grey, in the right face's tone: the ink would match nothing on an active mark
      expect(got.find((f) => same(f.points, frontTop))!.fill).toBe(fill(TONE.right));
      // and the column's corner square went with it
      expect(got.find((f) => same(f.points, corner))!.fill).toBe(fill(TONE.right));
      expect(activeArea(pose)).toBeCloseTo(area(solidFront) * 2 / 3 + area(rightTop), 0);
    }
  });

  test("a quarter turn of the column parks a third on top; its corner square stays only while the top is solved", () => {
    const topLeft = [project(36, 0, 0), project(24, 0, 0), project(24, 24, 0), project(36, 24, 0)];
    const topCorner = [project(36, 24, 0), project(24, 24, 0), project(24, 36, 0), project(36, 36, 0)];
    for (const column of [0, 180]) {
      const got = faces({ column, top: 0 });
      expect(got.some((f) => f.fill === ACTIVE && same(f.points, topLeft))).toBe(true);
      expect(got.some((f) => f.fill === ACTIVE && same(f.points, topCorner))).toBe(true);
      const away = faces({ column, top: 90 });
      expect(away.some((f) => f.fill === ACTIVE && same(f.points, topLeft))).toBe(true);
      expect(away.find((f) => same(f.points, topCorner))!.fill).toBe(fill(TONE.top));
    }
  });

  test("mid-turn, a slab's sides are shaded by where they point", () => {
    expect(sideTone(-1, 0)).toBe(TONE.left);
    expect(sideTone(0, -1)).toBeCloseTo(TONE.top, 9);
    expect(sideTone(-1, -1)).toBeCloseTo((TONE.left + TONE.top) / 2, 5);
    expect(capTone(-1, 0)).toBe(TONE.right);
    expect(capTone(0, -1)).toBeCloseTo(TONE.left, 9);
    expect(capTone(-1, -1)).toBeCloseTo((TONE.right + TONE.left) / 2, 5);
    expect(sideTone(-1, 0, TONE.right)).toBe(TONE.right);
    expect(capTone(0, -1, TONE.right)).toBeCloseTo(TONE.right, 9);
    // on an active mark every grey is one of the two the body shows
    const greys = new Set(faces({ column: 180, top: 90 }).map((f) => f.fill).filter((f) => f !== ACTIVE));
    expect([...greys].sort()).toEqual([fill(TONE.top), fill(TONE.right)].sort());
    // the top mid-turn: the plane it lifted off is painted first, in the top's tone
    const got = faces({ column: 90, top: -45 });
    expect(got[0]!.fill).toBe(fill(TONE.top));
    expect(faces({ column: 90, top: -45 }, { wings: "paper" })[0]!.fill).toBe("var(--bg)");
  });

  test("the viewBox holds the mark at every pose", () => {
    const [x, y, w, h] = VIEWBOX.split(" ").map(Number) as [number, number, number, number];
    const check = (pose: Pose): void => {
      for (const f of faces(pose)) for (const [px, py] of f.points) {
        expect(px).toBeGreaterThanOrEqual(x);
        expect(px).toBeLessThanOrEqual(x + w);
        expect(py).toBeGreaterThanOrEqual(y);
        expect(py).toBeLessThanOrEqual(y + h);
      }
    };
    for (let a = 0; a < 360; a += 3) { check({ column: a, top: 0 }); check({ column: 90, top: a }); }
  });

  test("fills are the theme's own three, mixed", () => {
    expect(fill(1)).toBe("var(--fg)");
    expect(fill(0)).toBe("var(--bg)");
    expect(fill(0.3)).toBe("color-mix(in srgb, var(--fg) 30%, var(--bg))");
    expect(area(solidFront)).toBeCloseTo(CUBE * CUBE * Math.sqrt(3) / 2, 1);
  });
});

describe("the loops", () => {
  test("walk: the column flips, the top steps, alternating; solved at two rests of four", () => {
    expect(WALK.map((m) => m.slab)).toEqual(["column", "top", "column", "top"]);
    const rests = WALK.map((_, k) => movePose(k, 0, WALK));
    expect(rests.map(isSolved)).toEqual([true, true, false, false]);
    // round the loop, the picture is the start's (the numbers come round in four)
    expect(samePicture(faces(movePose(4, 0, WALK)), faces(movePose(0, 0, WALK)))).toBe(true);
    expect(movePose(16, 0, WALK)).toEqual(SOLVED);
    // the still mark is a frame of the column's first flip: 224° reads as 44°
    const frames = Array.from({ length: 200 }, (_, i) => movePose(0, i / 200, WALK));
    expect(frames.some((p) => Math.abs((p.column % 180) - STILL.column) < 2 && p.top === STILL.top)).toBe(true);
    expect(samePicture(faces({ column: 224, top: 0 }), faces(STILL))).toBe(true);
  });

  test("column: the column alone steps a quarter; solved at every other rest, its third on top between", () => {
    const topLeft = [project(36, 0, 0), project(24, 0, 0), project(24, 24, 0), project(36, 24, 0)];
    for (let k = 0; k < 4; k++) {
      const pose = movePose(k, 0, COLUMN);
      expect(pose.top).toBe(0);
      expect(isSolved(pose)).toBe(k % 2 === 0);
      if (k % 2) expect(faces(pose).some((f) => f.fill === ACTIVE && same(f.points, topLeft))).toBe(true);
    }
  });

  test("flip: both flip, and every rest is solved", () => {
    expect(FLIP.map((m) => m.slab)).toEqual(["column", "top"]);
    for (let k = 0; k < 4; k++) expect(isSolved(movePose(k, 0, FLIP))).toBe(true);
  });

  test("timing: hold, then ease; a half turn takes half as long again", () => {
    const o = { turnMs: 800, holdMs: 1200 };
    expect(poseAt(0, o)).toEqual(SOLVED);
    expect(poseAt(o.holdMs - 1, o)).toEqual(SOLVED);
    const half = o.turnMs * 1.5;
    expect(poseAt(o.holdMs + half / 2, o).column).toBeCloseTo(180, 5);
    expect(poseAt(o.holdMs + half, o).column).toBeCloseTo(270, 5);
    // the second move is the top's quarter, at the quarter's length
    const t1 = o.holdMs + half;
    expect(poseAt(t1 + o.holdMs + o.turnMs / 2, o).top).toBeCloseTo(45, 5);
    expect(poseAt(t1 + o.holdMs + o.turnMs, o).top).toBeCloseTo(90, 5);
    // and it runs on, past the loop's end, without a jump
    const loopMs = 2 * (o.holdMs + half) + 2 * (o.holdMs + o.turnMs);
    expect(poseAt(loopMs, o)).toEqual({ column: 90, top: 180 });
    expect(poseAt(loopMs + o.holdMs + half, o).column).toBeCloseTo(270, 5);
    // the default has no hold: the moves run into one another
    expect(TURN.holdMs).toBe(0);
    expect(poseAt(1, TURN).column).toBeGreaterThan(90);
  });

  test("no square pops: the active area is continuous into and out of every rest", () => {
    for (const loop of [WALK, FLIP]) {
      for (let k = 0; k < loop.length; k++) {
        expect(activeArea(movePose(k, 0.001, loop))).toBeCloseTo(activeArea(movePose(k, 0, loop)), 0);
        expect(activeArea(movePose(k, 0.999, loop))).toBeCloseTo(activeArea(movePose(k + 1, 0, loop)), 0);
      }
    }
  });
});
