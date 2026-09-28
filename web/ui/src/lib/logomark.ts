/**
 * THE MARK, AS GEOMETRY. A 36-unit isometric cube with two layers that
 * turn the way a puzzle cube's do: the LEFT COLUMN — a 12-thick slab —
 * about the cube's axis through it, and the TOP — a 12-thick slab — about
 * the vertical. One turns at a time, and they alternate. The brand's still
 * pose is the column 44° into a turn (the "Logo cube" comp).
 *
 * Everything is derived from the still mark (web/ui/src/assets/logo.svg),
 * which faces(STILL) reproduces to a tenth of a unit — test/logomark.test.ts
 * holds it there.
 *
 * Colour is the theme's three and nothing else. The cube is monochrome:
 * tones between --bg and --fg, told apart by value alone, because the mark
 * has no outlines — except ONE face, the front-left, which is --activity.
 * Each slab carries a third of that face on one side AND on the side
 * opposite, so a half turn of either lands the face whole again: that is
 * what makes a solution frequent. The column only ever flips (a quarter
 * turn would park a third on top, where the next top turn would carry it
 * off); the top may step a quarter at a time, walking its third across
 * the right face and round.
 *
 * The square the two slabs share — the corner — is red on a column third
 * only while the top is solved: when the top turns, it takes that square
 * with it, and the column's next arrival finds it gone. The top's thirds
 * keep theirs, because the top only turns with the column solved.
 *
 * Every other surface — the body, the slabs' other sides, the inner faces
 * the turns open — is shaded by where it points, so it reads the same at
 * every rest.
 *
 * Axes: u runs back-left, v back-right, d down; the cube's top-front vertex
 * sits at the comp's (60, 39.7). The column is u ∈ [24, 36], turned about
 * the line (v, d) = (18, 18); the top is d ∈ [0, 12], turned about the
 * line (u, v) = (18, 18). The eye looks along (1, 1, 1): nothing of the
 * body is ever nearer than the column, and nothing of the lower body ever
 * nearer than the top — so the column is painted, then the body over it;
 * the lower body, then the top over it. The occlusion is exact.
 */

export const CUBE = 36;
export const SLAB = 12;
const BODY = CUBE - SLAB;
const ISO = Math.sqrt(3) / 2;
const ORIGIN: Point = [60, 39.7];

export type Point = readonly [number, number];

/** A 3D point of the cube on the comp's 120 × 84 canvas. */
export function project(u: number, v: number, d: number): Point {
  return [ORIGIN[0] + (v - u) * ISO, ORIGIN[1] - (u + v) / 2 + d];
}

/** The square viewBox that holds the mark at EVERY pose — the union of
 * the body (x 39.2–91.2, y 9.7–75.7), the column's sweep (x from 22.3,
 * y from 2.2) and the top's (x from 28.8, y from 3.7), centred, so the
 * mark neither clips nor jiggles as it turns. favicon.svg's frame is the
 * same box shifted 1.35 up, cut for the still pose alone. */
export const VIEWBOX = "19.25 1.45 75 75";

/** How much --fg goes into --bg on each face of the body. Top lightest,
 * left darkest, right between: the still mark's ink-200 / ink-900 /
 * ink-500. A slab's sides take the tone of whatever they currently point
 * at, between these, so a side that has turned into the left face IS the
 * left face's tone.
 *
 * With the front-left face in the activity colour, though, nothing wears
 * the left tone but a grey side turned to the front — a black that
 * matches no face and reads as a fourth colour. So while the face is
 * active, a side pointing front wears the RIGHT face's tone, the other
 * upright grey; the full ink is for the all-monochrome mark. */
export const TONE = { top: 0.3, right: 0.55, left: 1 } as const;
/** the tone of a surface pointing front */
export const frontTone = (active: boolean): number => (active ? TONE.right : TONE.left);

/** What the inner faces wear where a turn opens them: the tone of the
 * face they point like (the right for the column's, the top for the
 * top's), or the background — the comp's monochrome variant, where the
 * gap reads as a cut-out. */
export type Wings = "ink" | "paper";

export interface Look {
  /** the front-left face in the activity colour; off is a wholly monochrome mark */
  active?: boolean;
  wings?: Wings;
}

export interface Pose {
  /** the column's angle: 90 and 270 are flush with a third on the front */
  column: number;
  /** the top's angle: 0 and 180 are flush with a third on the front */
  top: number;
}

/** The face whole. */
export const SOLVED: Pose = { column: 90, top: 0 };
/** The brand's still: the column caught 44° into its turn. */
export const STILL: Pose = { column: 44, top: 0 };

export interface Face {
  points: Point[];
  d: string;
  fill: string;
}

/** A tone as a fill, against the theme's two neutrals. */
export function fill(tone: number): string {
  if (tone >= 1) return "var(--fg)";
  if (tone <= 0) return "var(--bg)";
  return `color-mix(in srgb, var(--fg) ${Math.round(tone * 100)}%, var(--bg))`;
}

const angleOf = (a: number, b: number): number => {
  const psi = (Math.atan2(b, a) * 180) / Math.PI;
  return psi < 0 ? psi + 360 : psi;
};
const between = (from: number, to: number, psi: number): number => {
  const s = Math.min(1, Math.max(0, (psi - 180) / 90));
  return from + (to - from) * s;
};

/** The tone of a column side from its turned normal (nv, nd). A side is
 * visible while nv + nd < 0, which is the normal's angle in (135°, 315°):
 * from pointing left (180°, the left tone) round through pointing up (270°,
 * the top tone), linear between and clamped past. */
export function sideTone(nv: number, nd: number, front: number = TONE.left): number {
  return between(front, TONE.top, angleOf(nv, nd));
}

/** The tone of a top-slab side from its turned normal (nu, nv): from
 * pointing right (180°, the right tone) round to pointing left (270°, the
 * left tone). */
export function capTone(nu: number, nv: number, front: number = TONE.left): number {
  return between(TONE.right, front, angleOf(nu, nv));
}

const path = (pts: Point[]): string => "M" + pts.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(" L") + " Z";
const face = (points: Point[], fillValue: string): Face => ({ points, d: path(points), fill: fillValue });
const ACTIVE = "var(--activity)";
const P = project;

const norm = (a: number): number => ((a % 360) + 360) % 360;
/** an angle snapped to its rest, in [0, 360) */
const rest = (a: number): number => norm(Math.round(a / 90) * 90);
const atRest = (a: number): boolean => Math.abs(a / 90 - Math.round(a / 90)) < 1e-9;
/** a column angle with a third on the front; a top angle likewise */
export const columnSolved = (a: number): boolean => atRest(a) && rest(a) % 180 === 90;
export const topSolved = (a: number): boolean => atRest(a) && rest(a) % 180 === 0;
export const isSolved = (p: Pose): boolean => columnSolved(p.column) && topSolved(p.top);

type Side = { edge: [Point, Point]; n: Point; third?: "start" | "end" };

// The column's cross-section, a square in (v, d), its corners going round.
const A: Point = [0, 0], B: Point = [CUBE, 0], C: Point = [CUBE, CUBE], D: Point = [0, CUBE];
// One side per edge of the square, with the side's outward normal at 0°.
// A third rides the side that is the TOP at 0° — a quarter turn on, it is
// flush with the front-left face — and the side opposite, flush after a
// half turn more. On each, `third` names the end whose square lands in
// the corner: near B for the first, near D for the second.
const COLUMN_SIDES: Side[] = [
  { edge: [B, A], n: [0, -1], third: "start" },
  { edge: [A, D], n: [-1, 0] },
  { edge: [D, C], n: [0, 1], third: "start" },
  { edge: [C, B], n: [1, 0] },
];
// The top's cross-section, a square in (u, v). Its thirds are the FRONT
// at 0° and the back; the corner square is the end in the column for the
// first (u ≥ 24) and the end that a half turn puts there for the second.
const TOP_SIDES: Side[] = [
  { edge: [[0, 0], [CUBE, 0]], n: [0, -1], third: "end" },
  { edge: [[0, CUBE], [0, 0]], n: [-1, 0] },
  { edge: [[CUBE, CUBE], [0, CUBE]], n: [0, 1], third: "end" },
  { edge: [[CUBE, 0], [CUBE, CUBE]], n: [1, 0] },
];
/** the point a third of the way from p to q, or two thirds */
const along = (p: Point, q: Point, f: number): Point => [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];

type Paint = (tone: number, red: boolean) => string;

/** The mark at one pose, as faces in paint order. One slab may be
 * mid-turn; the other is taken at its rest. */
export function faces(pose: Pose, look: Look = {}): Face[] {
  const { active = true, wings = "ink" } = look;
  const paint: Paint = (tone, red) => (red && active ? ACTIVE : fill(tone));
  const front = frontTone(active);
  return atRest(pose.top) ? columnTurning(pose, paint, wings, front) : topTurning(pose, paint, wings, front);
}

function columnTurning(pose: Pose, paint: Paint, wings: Wings, front: number): Face[] {
  const phi = pose.column, theta = rest(pose.top);
  const r = (phi * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const h = CUBE / 2;
  const turn = ([v, d]: Point): Point => [h + (v - h) * c + (d - h) * s, h - (v - h) * s + (d - h) * c];
  const at = (p: Point, u: number): Point => P(u, ...turn(p));
  const out: Face[] = [];

  // The column's inner face, in the plane of the cube's own hidden
  // back-left face. Only what its turn carries out past the cube's
  // silhouette shows — two wings, nothing at all at rest.
  out.push(face([C, D, A, B].map((p) => at(p, BODY)), wings === "ink" ? fill(TONE.right) : fill(0)));
  // Its sides that face the eye after the turn. A third's corner square
  // is red only while the top is solved: the top takes it when it turns.
  const cornerRed = topSolved(theta);
  for (const { edge: [p, q], n: [nv, nd], third } of COLUMN_SIDES) {
    const tv = nv * c + nd * s, td = -nv * s + nd * c;
    if (tv + td >= -1e-9) continue; // edge-on, or a hair past it
    const tone = sideTone(tv, td, front);
    if (third) {
      const m = along(p, q, 1 / 3);
      out.push(face([at(p, CUBE), at(p, BODY), at(m, BODY), at(m, CUBE)], paint(tone, cornerRed)));
      out.push(face([at(m, CUBE), at(m, BODY), at(q, BODY), at(q, CUBE)], paint(tone, true)));
    } else out.push(face([at(p, CUBE), at(p, BODY), at(q, BODY), at(q, CUBE)], fill(tone)));
  }

  // The body, u ∈ [0, 24], last. Its top row is the top slab at rest,
  // wearing a third where the slab's turns have put one: on the front at
  // 0° and 180°, on the right at 90° and 270°.
  out.push(face([P(BODY, CUBE, 0), P(0, CUBE, 0), P(0, 0, 0), P(BODY, 0, 0)], fill(TONE.top)));
  out.push(face([P(BODY, 0, CUBE), P(0, 0, CUBE), P(0, 0, SLAB), P(BODY, 0, SLAB)], paint(front, true)));
  out.push(face([P(BODY, 0, SLAB), P(0, 0, SLAB), P(0, 0, 0), P(BODY, 0, 0)], paint(front, theta % 180 === 0)));
  out.push(face([P(0, CUBE, CUBE), P(0, 0, CUBE), P(0, 0, SLAB), P(0, CUBE, SLAB)], fill(TONE.right)));
  out.push(face([P(0, CUBE, SLAB), P(0, 0, SLAB), P(0, 0, 0), P(0, CUBE, 0)], paint(TONE.right, theta % 180 === 90)));
  return out;
}

function topTurning(pose: Pose, paint: Paint, wings: Wings, front: number): Face[] {
  const theta = pose.top, phi = rest(pose.column);
  const r = (theta * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const h = CUBE / 2;
  const spin = ([u, v]: Point): Point => [h + (u - h) * c - (v - h) * s, h + (u - h) * s + (v - h) * c];
  const at = (p: Point, d: number): Point => P(...spin(p), d);
  const out: Face[] = [];

  // The lower body, d ∈ [12, 36], first: the plane the top sits on shows
  // only where the turn has carried the slab off it. Its front column is
  // the column at rest, wearing a third when flush.
  out.push(face([P(CUBE, CUBE, SLAB), P(0, CUBE, SLAB), P(0, 0, SLAB), P(CUBE, 0, SLAB)], wings === "ink" ? fill(TONE.top) : fill(0)));
  out.push(face([P(BODY, 0, CUBE), P(0, 0, CUBE), P(0, 0, SLAB), P(BODY, 0, SLAB)], paint(front, true)));
  out.push(face([P(CUBE, 0, CUBE), P(BODY, 0, CUBE), P(BODY, 0, SLAB), P(CUBE, 0, SLAB)], paint(front, phi % 180 === 90)));
  out.push(face([P(0, CUBE, CUBE), P(0, 0, CUBE), P(0, 0, SLAB), P(0, CUBE, SLAB)], fill(TONE.right)));

  // The top slab, turned. Its lid — with a column third lying on it when
  // the column is parked at 0° or 180°, its corner square gone with the lid.
  const lid = (...ps: Point[]): Point[] => ps.map((p) => at(p, 0));
  if (phi % 180 === 0) {
    out.push(face(lid([0, 0], [BODY, 0], [BODY, CUBE], [0, CUBE]), fill(TONE.top)));
    out.push(face(lid([BODY, 0], [CUBE, 0], [CUBE, BODY], [BODY, BODY]), paint(TONE.top, true)));
    out.push(face(lid([BODY, BODY], [CUBE, BODY], [CUBE, CUBE], [BODY, CUBE]), fill(TONE.top)));
  } else out.push(face(lid([0, 0], [CUBE, 0], [CUBE, CUBE], [0, CUBE]), fill(TONE.top)));
  // Its sides that face the eye. The top's thirds keep their corner
  // squares: the top only turns with the column solved.
  for (const { edge: [p, q], n: [nu, nv], third } of TOP_SIDES) {
    const tu = nu * c - nv * s, tv = nu * s + nv * c;
    if (tu + tv >= -1e-9) continue;
    const tone = capTone(tu, tv, front);
    if (third) {
      const m = along(p, q, 2 / 3);
      out.push(face([at(p, 0), at(m, 0), at(m, SLAB), at(p, SLAB)], paint(tone, true)));
      out.push(face([at(m, 0), at(q, 0), at(q, SLAB), at(m, SLAB)], paint(tone, true)));
    } else out.push(face([at(p, 0), at(q, 0), at(q, SLAB), at(p, SLAB)], fill(tone)));
  }
  return out;
}

// ── the loops ───────────────────────────────────────────────────────────────

export interface Move {
  slab: "column" | "top";
  /** degrees, signed; ±180 is a flip */
  by: number;
}

/** The column flips; the top walks. The column's front third sinks under
 * while the back one comes over the top into place — whole again (the
 * still mark is a frame of this); the top's front third slips away behind
 * as the opposite one comes onto the right face; the column flips again;
 * the right third slides into place. Solved at two rests of four. */
export const WALK: readonly Move[] = [
  { slab: "column", by: 180 },
  { slab: "top", by: 90 },
  { slab: "column", by: 180 },
  { slab: "top", by: 90 },
];

/** Both flip: every rest is solved, and each move is a third leaving in
 * plain view while its opposite arrives. */
export const FLIP: readonly Move[] = [
  { slab: "column", by: 180 },
  { slab: "top", by: 180 },
];

/** The column alone, a quarter at a time — the original motion. With a
 * third on either side it is solved at every other rest, the third on
 * top between. */
export const COLUMN: readonly Move[] = [{ slab: "column", by: 90 }];

export const LOOPS = { walk: WALK, flip: FLIP, column: COLUMN } as const;
export type LoopName = keyof typeof LOOPS;

const easeInOut = (p: number): number => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);

/** The pose `p` of the way through move `k` of a loop (0 is its rest),
 * counting from solved; k may run past the loop's end, which continues
 * it. Angles accumulate, so a walk of four quarter turns comes round
 * numerically as well as in the picture. */
export function movePose(k: number, p: number, loop: readonly Move[] = WALK): Pose {
  const pose = { ...SOLVED };
  for (let i = 0; i < k; i++) {
    const m = loop[i % loop.length]!;
    pose[m.slab] += m.by;
  }
  const m = loop[k % loop.length]!;
  pose[m.slab] += m.by * easeInOut(Math.min(1, Math.max(0, p)));
  return { column: norm(pose.column), top: norm(pose.top) };
}

/** The motion's timing: a quarter turn, and a hold before each move; a
 * half turn takes half as long again. No hold by default — the ease into
 * and out of every move is the pause. */
export interface Turn {
  turnMs: number;
  holdMs: number;
}

export const TURN: Turn = { turnMs: 800, holdMs: 0 };

export const HALF_TURN = 1.5;

/** The pose `t` milliseconds into a loop. A loop's poses repeat every
 * pass through it in the picture, if not always in the numbers, so the
 * clock runs over the whole walk round — four passes at most. */
export function poseAt(t: number, o: Turn = TURN, loop: readonly Move[] = WALK): Pose {
  const spans = loop.map((m) => o.holdMs + o.turnMs * (Math.abs(m.by) > 90 ? HALF_TURN : 1));
  const period = spans.reduce((a, b) => a + b, 0);
  const passes = 4;
  let r = ((t % (period * passes)) + period * passes) % (period * passes);
  let k = 0;
  while (r >= spans[k % loop.length]!) { r -= spans[k % loop.length]!; k++; }
  const span = spans[k % loop.length]!;
  const p = r < o.holdMs ? 0 : (r - o.holdMs) / (span - o.holdMs);
  return movePose(k, p, loop);
}
