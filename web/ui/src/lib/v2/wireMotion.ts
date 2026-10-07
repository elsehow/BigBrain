// A Desktop's motion, and its cube drawn flat: what the field's glass cube
// (wireCube.ts) and the strip's tokens (DesktopCube.svelte) share. No three.js
// here, so the strip draws without loading the field's renderer.

export const TURN_MS = 780, HOLD_MS = 340;
export type Axis = 0 | 1 | 2;
export const MOVES: ReadonlyArray<{ k: Axis; side: 1 | -1 }> = [
  { k: 0, side: -1 }, { k: 1, side: -1 }, { k: 2, side: 1 }, { k: 1, side: 1 }, { k: 0, side: 1 }, { k: 1, side: -1 },
];
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Where the motion is `t` ms in: which move, how far it has turned (0..π),
 * and how much of the seam shows. Settled is one block. */
export function wirePose(t: number): { move: number; settled: boolean; angle: number; seam: number } {
  const span = TURN_MS + HOLD_MS, move = Math.floor(Math.max(0, t) / span) % MOVES.length;
  const p = (Math.max(0, t) % span) / TURN_MS;
  if (p <= 0 || p >= 1) return { move, settled: true, angle: 0, seam: 0 };
  const angle = Math.PI * easeInOut(p);
  const x = Math.min(1, Math.abs(Math.sin(angle)) / 0.45);
  return { move, settled: false, angle, seam: x * x * (3 - 2 * x) };
}

type V3 = [number, number, number];

/** Where a Desktop's motion is now: each on its own clock, so Desktops
 * working at once never turn in step, and the same in the field and the
 * strip, so a token's cube turns with its cube in the field. */
const CYCLE = MOVES.length * (TURN_MS + HOLD_MS);
export const wireClock = (id: string) => performance.now() + ([...id].reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 7) % CYCLE);

/** The cube flat, for the strip: as the overview sees it (a corner to the
 * eye, from EL above), the faces that face the eye filled as glass and the
 * edges they show lined. Far block first, so the near one covers it; while
 * a move turns, the cut plane parts the halves, so its side tells which is
 * near. `t` as tick's; coordinates are ±√3 at most, y down. */
export interface FlatBlock { faces: string; edges: string; seams: string }
const EL = 0.55, YAW = -Math.PI / 4;
const rot = ([x, y, z]: V3, k: Axis, a: number): V3 => {
  const c = Math.cos(a), s = Math.sin(a);
  return k === 0 ? [x, y * c - z * s, y * s + z * c] : k === 1 ? [x * c + z * s, y, -x * s + z * c] : [x * c - y * s, x * s + y * c, z];
};
/** Screen x, y (down) and nearness, of a point in the body. */
const eye = (p: V3): V3 => { const [x, y, z] = rot(p, 1, YAW); return [x, -(y * Math.cos(EL) - z * Math.sin(EL)), y * Math.sin(EL) + z * Math.cos(EL)]; };
const n3 = (v: number) => +v.toFixed(3);
/** A block, turned `a` about its cut axis (none at rest). */
function flatBlock(center: V3, half: V3, cut: Axis | -1, a = 0): FlatBlock {
  const k = cut === -1 ? 0 : cut;
  const at = (s: V3): V3 => rot(center.map((c, i) => c + s[i]! * half[i]!) as V3, k, a);
  const facing = (ax: Axis, s: number) => { const n: V3 = [0, 0, 0]; n[ax] = s; return eye(rot(n, k, a))[2] > 1e-9; };
  const pt = (s: V3) => { const [x, y] = eye(at(s)); return `${n3(x)} ${n3(y)}`; };
  let faces = "", edges = "", seams = "";
  for (const ax of [0, 1, 2] as const) {
    const b = ((ax + 1) % 3) as Axis, c = ((ax + 2) % 3) as Axis;
    const corner = (sa: number, sb: number, sc: number) => { const s: V3 = [0, 0, 0]; s[ax] = sa; s[b] = sb; s[c] = sc; return s; };
    for (const s of [-1, 1]) if (facing(ax, s))
      faces += `M${pt(corner(s, -1, -1))}L${pt(corner(s, 1, -1))}L${pt(corner(s, 1, 1))}L${pt(corner(s, -1, 1))}Z`;
    // the four edges along ax, each shown if either face it joins is
    for (const sb of [-1, 1]) for (const sc of [-1, 1]) if (facing(b, sb) || facing(c, sc)) {
      const d = `M${pt(corner(-1, sb, sc))}L${pt(corner(1, sb, sc))}`, sCut = cut === b ? sb : cut === c ? sc : 0;
      if (sCut && Math.abs(center[cut as Axis] + sCut * half[cut as Axis]) < 1e-6) seams += d; else edges += d;
    }
  }
  return { faces, edges, seams };
}
export function flatWire(t: number): { blocks: FlatBlock[]; seam: number } {
  const pose = wirePose(t);
  if (pose.settled) return { blocks: [flatBlock([0, 0, 0], [1, 1, 1], -1)], seam: 0 };
  const { k, side } = MOVES[pose.move]!, half: V3 = [1, 1, 1], still: V3 = [0, 0, 0], turn: V3 = [0, 0, 0], axis: V3 = [0, 0, 0];
  half[k] = 0.5; still[k] = -side * 0.5; turn[k] = side * 0.5; axis[k] = 1;
  const a = flatBlock(still, half, k), b = flatBlock(turn, half, k, -pose.angle);
  return { blocks: eye(axis)[2] * side > 0 ? [a, b] : [b, a], seam: pose.seam };
}
