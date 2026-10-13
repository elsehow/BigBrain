/** layout.ts — where each node sits, as a view
 * (docs/plans/2026-10-11-field-of-assertions.md, "Layout";
 * docs/plans/2026-10-12-stages-and-views-refactor.md, R7).
 *
 * Each node is seated in the order its assertions were added (ties by id):
 * beside the earlier nodes it arrived linked to, spreading outward around
 * them as more arrive; one that arrived alone takes the next place on an
 * open spiral; a slot an earlier seat holds is passed over, so a seat
 * depends only on the seats before it. A link made later never moves a
 * seat. Then one local settle: each node is nudged from its seat toward its
 * neighbours' seats, a few pixels at most, and its place depends on nothing
 * else. A new assertion nudges its neighbours; a
 * retraction can move what sat beside it.
 *
 * The same record draws the same picture on any machine: the arithmetic is
 * +, ×, ÷ and √, which every engine rounds alike, and directions come from
 * the fixed table below, never `Math.sin` or `Math.cos`, whose last bits
 * are each engine's own. No history: nothing reads a layout drawn before.
 */
import type { Graph } from "../graph";

/** Node id → [x, y], to two decimals. */
export type Positions = Record<string, [number, number]>;

/** Sixty-four unit directions, a turn of the circle in equal steps. */
const DIRECTIONS: readonly (readonly [number, number])[] = [
  [1.000000, 0.000000], [0.995185, 0.098017], [0.980785, 0.195090], [0.956940, 0.290285],
  [0.923880, 0.382683], [0.881921, 0.471397], [0.831470, 0.555570], [0.773010, 0.634393],
  [0.707107, 0.707107], [0.634393, 0.773010], [0.555570, 0.831470], [0.471397, 0.881921],
  [0.382683, 0.923880], [0.290285, 0.956940], [0.195090, 0.980785], [0.098017, 0.995185],
  [0.000000, 1.000000], [-0.098017, 0.995185], [-0.195090, 0.980785], [-0.290285, 0.956940],
  [-0.382683, 0.923880], [-0.471397, 0.881921], [-0.555570, 0.831470], [-0.634393, 0.773010],
  [-0.707107, 0.707107], [-0.773010, 0.634393], [-0.831470, 0.555570], [-0.881921, 0.471397],
  [-0.923880, 0.382683], [-0.956940, 0.290285], [-0.980785, 0.195090], [-0.995185, 0.098017],
  [-1.000000, 0.000000], [-0.995185, -0.098017], [-0.980785, -0.195090], [-0.956940, -0.290285],
  [-0.923880, -0.382683], [-0.881921, -0.471397], [-0.831470, -0.555570], [-0.773010, -0.634393],
  [-0.707107, -0.707107], [-0.634393, -0.773010], [-0.555570, -0.831470], [-0.471397, -0.881921],
  [-0.382683, -0.923880], [-0.290285, -0.956940], [-0.195090, -0.980785], [-0.098017, -0.995185],
  [0.000000, -1.000000], [0.098017, -0.995185], [0.195090, -0.980785], [0.290285, -0.956940],
  [0.382683, -0.923880], [0.471397, -0.881921], [0.555570, -0.831470], [0.634393, -0.773010],
  [0.707107, -0.707107], [0.773010, -0.634393], [0.831470, -0.555570], [0.881921, -0.471397],
  [0.923880, -0.382683], [0.956940, -0.290285], [0.980785, -0.195090], [0.995185, -0.098017],

];
/** Successive seats around one anchor step this far through the table: odd,
 * so every direction is used, and near the golden share of a turn, so
 * neighbours spread rather than bunch. */
const STEP = 25;
/** How far apart seats around one anchor start, and the open spiral's step. */
const SEAT_GAP = 24, LONE_GAP = 90;
/** No two seats closer than this: a slot taken by an earlier seat is passed over. */
const ROOM = 10;
/** How many slots a seat may pass over before it takes the next regardless. */
const TRIES = 64;
/** How far a node is drawn toward its neighbours' seats in the settle, and
 * the most it moves: under a third of ROOM, so two seats never come closer
 * than ROOM less two nudges. */
const PULL = 0.25, NUDGE = 3;

/** An edge's key in `arrivals`: its two ends, in order. */
export const edgeKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** FNV-1a: a node's own turn, from its id alone. */
function spin(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return h % DIRECTIONS.length;
}
const two = (v: number): number => Math.round(v * 100) / 100;

/** The picture of `graph`, from when each node and edge arrived (`arrivals`:
 * a time for every node id and every edge's `edgeKey`; one absent is
 * earliest). */
export function seatLayout(graph: Graph, arrivals: ReadonlyMap<string, string>): Positions {
  const at = (key: string) => arrivals.get(key) ?? "";
  // code-unit order, never a locale's: the same on every machine
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const order = (a: string, b: string) => cmp(at(a), at(b)) || cmp(a, b);
  const nodes = graph.nodes.map((n) => n.id).sort(order);
  const rank = new Map(nodes.map((id, i) => [id, i]));
  const earlier = new Map<string, string[]>(), around = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!rank.has(e.source) || !rank.has(e.target)) continue;
    for (const [a, b] of [[e.source, e.target], [e.target, e.source]] as const) {
      let all = around.get(a); if (!all) around.set(a, all = []); all.push(b);
      // only the links it arrived with: one made later is no reason to have sat elsewhere
      if (at(edgeKey(a, b)) > at(a) || rank.get(b)! > rank.get(a)!) continue;
      let list = earlier.get(a); if (!list) earlier.set(a, list = []); list.push(b);
    }
  }
  // Earlier seats by grid cell, so a slot one of them holds is passed over:
  // a seat depends only on the seats before it.
  const seats = new Map<string, [number, number]>(), placed = new Map<string, number>(), grid = new Map<string, [number, number][]>();
  const cell = (v: number) => Math.floor(v / ROOM);
  const free = ([x, y]: [number, number]) => {
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++)
      for (const [px, py] of grid.get(`${cell(x) + i},${cell(y) + j}`) ?? []) if ((px - x) * (px - x) + (py - y) * (py - y) < ROOM * ROOM) return false;
    return true;
  };
  const seat = (id: string, at: [number, number]) => {
    seats.set(id, at);
    const key = `${cell(at[0])},${cell(at[1])}`, held = grid.get(key);
    if (held) held.push(at); else grid.set(key, [at]);
  };
  let lone = 0;
  for (const id of nodes) {
    const near = (earlier.get(id) ?? []).sort((a, b) => rank.get(a)! - rank.get(b)!);
    let x = 0, y = 0;
    for (const o of near) { const [px, py] = seats.get(o)!; x += px; y += py; }
    const [cx, cy] = near.length ? [x / near.length, y / near.length] : [0, 0];
    const anchor = near[0], turn = near.length ? spin(id) : 0;
    let at: [number, number] = [cx, cy];
    for (let k = 0; k < TRIES; k++) {
      const n = anchor === undefined ? lone++ : (placed.get(anchor) ?? 0);
      if (anchor !== undefined) placed.set(anchor, n + 1);
      const [dx, dy] = DIRECTIONS[(n * STEP + turn) % DIRECTIONS.length]!;
      const r = anchor === undefined ? LONE_GAP * Math.sqrt(n + 0.5) : SEAT_GAP * Math.sqrt(n + 1);
      at = [cx + dx * r, cy + dy * r];
      if (free(at)) break;
    }
    seat(id, at);
  }
  const out: Positions = {};
  for (const id of nodes) {
    const [sx, sy] = seats.get(id)!, by = around.get(id);
    if (!by?.length) { out[id] = [two(sx), two(sy)]; continue; }
    let x = 0, y = 0;
    for (const o of by) { const [px, py] = seats.get(o)!; x += px; y += py; }
    let dx = (x / by.length - sx) * PULL, dy = (y / by.length - sy) * PULL;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length > NUDGE) { dx = (dx / length) * NUDGE; dy = (dy / length) * NUDGE; }
    out[id] = [two(sx + dx), two(sy + dy)];
  }
  return out;
}

/** The graph with its positions in it. */
export const withSeats = (graph: Graph, arrivals: ReadonlyMap<string, string>): Graph => {
  const at = seatLayout(graph, arrivals);
  return { ...graph, nodes: graph.nodes.map((n) => ({ ...n, x: at[n.id]![0], y: at[n.id]![1] })) };
};
