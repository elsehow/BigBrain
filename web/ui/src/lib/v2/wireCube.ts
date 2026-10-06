// A Desktop in the field: the Wire mark, the logo's two-by-two cube, in glass
// with a hairline outline. Its motion is bigbrain.cool's: a half of the cube
// turns a half turn (TURN_MS, eased), holds HOLD_MS, and the next move begins.
//
// Drawn as the site draws it: one block at rest; while a move turns, two half
// blocks, one turning. Only the outer edges are lined. The seam between the
// halves (the four edges of the cut face) fades with how far the halves stand
// apart, so it is never seen while they align. A half turn of a half block
// looks as it did before, so nothing needs remembering between moves.
//
// Bodies are real-size geometry, never scaled: transmission refracts by the
// mesh's scale, so a half made by squashing a block would bend the field
// behind it differently from the whole, and the picture would jump each time
// one became the other.

import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

export const TURN_MS = 780, HOLD_MS = 340;
type Axis = 0 | 1 | 2;
const MOVES: ReadonlyArray<{ k: Axis; side: 1 | -1 }> = [
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
  return { move, settled: false, angle, seam: THREE.MathUtils.smoothstep(Math.abs(Math.sin(angle)), 0, 0.45) };
}

type V3 = [number, number, number];
/** A box's twelve edges, split into those on the cut plane at the centre
 * (`seam`) and the rest (`body`). */
function outline(center: V3, half: V3, cut: Axis | -1, part: "body" | "seam"): LineSegmentsGeometry {
  const out: number[] = [];
  for (const a of [0, 1, 2] as const) {
    const b = (a + 1) % 3, c = (a + 2) % 3;
    for (const sb of [-1, 1]) for (const sc of [-1, 1]) {
      const p = [...center] as V3, q = [...center] as V3;
      p[a] -= half[a]; q[a] += half[a];
      p[b] += sb * half[b]; q[b] += sb * half[b];
      p[c] += sc * half[c]; q[c] += sc * half[c];
      const onSeam = cut !== -1 && Math.abs(p[cut]) < 1e-6 && Math.abs(q[cut]) < 1e-6;
      if ((part === "seam") === onSeam) out.push(...p, ...q);
    }
  }
  return new LineSegmentsGeometry().setPositions(out);
}
const WHOLE = { body: new THREE.BoxGeometry(2, 2, 2), line: outline([0, 0, 0], [1, 1, 1], -1, "body") };
const HALF_BODY = ([0, 1, 2] as const).map((k) => { const d: V3 = [2, 2, 2]; d[k] = 1; return new THREE.BoxGeometry(...d); });
const HALVES = MOVES.map(({ k, side }) => {
  const half: V3 = [1, 1, 1]; half[k] = 0.5;
  const still: V3 = [0, 0, 0], turn: V3 = [0, 0, 0];
  still[k] = -side * 0.5; turn[k] = side * 0.5;
  return { still, turn, stillLine: outline(still, half, k, "body"), turnLine: outline(turn, half, k, "body"),
    stillSeam: outline(still, half, k, "seam"), turnSeam: outline(turn, half, k, "seam") };
});
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

export interface WireCube {
  /** Place and scale this; its extent is ±1 before scaling. */
  root: THREE.Group;
  /** Pose it `t` ms into its motion (0 is at rest). */
  tick(t: number): void;
}

/** `line` draws the outline; `seam` must be this cube's own (its opacity is
 * the seam's fade). Both should be transparent, so they draw after the
 * glass: it hides the back edges, and they stay out of what it refracts. */
export function createWireCube(glass: THREE.Material, line: LineMaterial, seam: LineMaterial): WireCube {
  const root = new THREE.Group(), body = new THREE.Group(), pivot = new THREE.Group();
  // turned a quarter about the vertical, so a corner faces the overview as the logo's does
  body.rotation.y = -Math.PI / 4;
  root.add(body); body.add(pivot);
  const whole = new THREE.Mesh(WHOLE.body, glass), still = new THREE.Mesh(HALF_BODY[0], glass), turn = new THREE.Mesh(HALF_BODY[0], glass);
  const wholeL = new LineSegments2(WHOLE.line, line), stillL = new LineSegments2(WHOLE.line, line), turnL = new LineSegments2(WHOLE.line, line);
  const stillS = new LineSegments2(WHOLE.line, seam), turnS = new LineSegments2(WHOLE.line, seam);
  body.add(whole, wholeL, still, stillL, stillS);
  pivot.add(turn, turnL, turnS);
  for (const o of [whole, still, turn, wholeL, stillL, turnL, stillS, turnS]) o.renderOrder = 4;
  return {
    root,
    tick(t) {
      const pose = wirePose(t), h = HALVES[pose.move]!, k = MOVES[pose.move]!.k;
      whole.visible = wholeL.visible = pose.settled;
      still.visible = turn.visible = stillL.visible = turnL.visible = stillS.visible = turnS.visible = !pose.settled;
      if (pose.settled) return;
      still.geometry = turn.geometry = HALF_BODY[k]!;
      still.position.fromArray(h.still); turn.position.fromArray(h.turn);
      stillL.geometry = h.stillLine; turnL.geometry = h.turnLine;
      stillS.geometry = h.stillSeam; turnS.geometry = h.turnSeam;
      seam.opacity = pose.seam * line.opacity;
      pivot.setRotationFromAxisAngle(AXES[k]!, -pose.angle);
    },
  };
}
