/** layout.ts — where each node sits, as a view
 * (docs/plans/2026-10-11-field-of-assertions.md, "Layout";
 * docs/plans/2026-10-12-stages-and-views-refactor.md, R7).
 *
 * Two steps. First the seats (seatLayout): each node is seated in the order
 * its assertions were added (ties by id), beside the earlier nodes it arrived
 * linked to, spreading outward around them as more arrive; one that arrived
 * alone takes the next place on an open spiral; a slot an earlier seat holds
 * is passed over, so a seat depends only on the seats before it.
 *
 * Seats alone draw the order things arrived in, not how they connect: a hub
 * seated early, alone, never moves toward what it was linked to later, and
 * its lines cross the whole field. So, second, the settle (fieldLayout): from
 * the seats, a force layout of everything tied to more than one thing — each
 * pair pushed apart, each tie pulled together, all drawn gently to the middle
 * — for a fixed number of passes, in a fixed order. What is tied to one thing
 * fans out around it, and what is tied to nothing rings the field. Connected
 * things sit together, and the shape is the structure. The seats keep it
 * steady: a new assertion starts from the same seats plus its own, so the
 * picture shifts a little, not into another picture.
 *
 * A picture can extend another (`fixed`): the nodes it already placed keep
 * their places exactly and count as earlier than every other, and the rest
 * are seated beside them and settle around them, which never move. Your field
 * with a joined server's beside it is your field unmoved, and the server's
 * nodes placed around it (lib/sharedReadUnion.ts).
 *
 * The same record draws the same picture on any machine: the arithmetic is
 * +, ×, ÷ and √, which every engine rounds alike, and directions come from
 * the fixed table and constants below, never `Math.sin`, `Math.cos`,
 * `Math.hypot` or `**`, whose last bits are each engine's own. No history:
 * nothing reads a layout drawn before.
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
/** Code-unit order, never a locale's: the same on every machine. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The picture of `graph`, from when each node and edge arrived (`arrivals`:
 * a time for every node id and every edge's `edgeKey`; one absent is
 * earliest), extending `fixed`: the seats a picture already gave some of
 * its nodes, which stay where they are. */
export function seatLayout(graph: Graph, arrivals: ReadonlyMap<string, string>, fixed: Positions = {}): Positions {
  const at = (key: string) => arrivals.get(key) ?? "";
  const order = (a: string, b: string) => cmp(at(a), at(b)) || cmp(a, b);
  const held = graph.nodes.map((n) => n.id).filter((id) => fixed[id]);
  const nodes = graph.nodes.map((n) => n.id).filter((id) => !fixed[id]).sort(order);
  // a fixed seat is earlier than any other, and was there before any link
  const rank = new Map([...held.map((id) => [id, -1] as const), ...nodes.map((id, i) => [id, i] as const)]);
  const isFixed = (id: string) => rank.get(id) === -1;
  const earlier = new Map<string, string[]>(), around = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!rank.has(e.source) || !rank.has(e.target)) continue;
    for (const [a, b] of [[e.source, e.target], [e.target, e.source]] as const) {
      let all = around.get(a); if (!all) around.set(a, all = []); all.push(b);
      // only the links it arrived with: one made later is no reason to have sat elsewhere
      if (!isFixed(b) && (at(edgeKey(a, b)) > at(a) || rank.get(b)! > rank.get(a)!)) continue;
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
  for (const id of held) seat(id, fixed[id]!);
  let lone = 0;
  for (const id of nodes) {
    const near = (earlier.get(id) ?? []).sort((a, b) => rank.get(a)! - rank.get(b)! || cmp(a, b));
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
  for (const id of held) out[id] = fixed[id]!;
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

/** The settle's passes, fixed: the same seats settle the same way everywhere. */
const PASSES = 100;
/** Passes that first move each seat toward its ties' seats, so what is
 * connected starts together rather than wherever it arrived. */
const GATHER = 4;
/** Every two nodes push apart by their ties + 1 each; every node is drawn to
 * the middle by its ties + 1. */
const REPEL = 40, GRAVITY = 1;
/** The most a node moves in the first pass, falling to almost nothing by the last. */
const HEAT = 80;
/** Barnes–Hut's opening angle: coarse while nodes move far, finer as they settle. */
const THETA_FROM = 2, THETA_TO = 1.2;
/** How far from the middle the seeds start, per √node. */
const SPREAD = 14;
/** How far a leaf sits from its one tie. */
const FAN = 7;
/** The ring of what is tied to nothing: from this share of the field's reach
 * to this, evenly. */
const HALO_FROM = 1.08, HALO_TO = 1.5;
/** The golden angle's cosine and sine, as literals: turning by them takes
 * only × and +, so a fan or the ring never lines up in spokes. */
const TURN_C = -0.7373688780783197, TURN_S = 0.6754902942615238;
const turn = ([ux, uy]: readonly [number, number]): [number, number] => [ux * TURN_C - uy * TURN_S, ux * TURN_S + uy * TURN_C];
/** How deep the Barnes–Hut tree goes before nodes at one point count as one. */
const DEPTH = 20;

/** The field: `graph` seated (seatLayout), then settled into the shape of its
 * ties. `fixed` places stay exactly where they are. */
export function fieldLayout(graph: Graph, arrivals: ReadonlyMap<string, string>, fixed: Positions = {}): Positions {
  const seats = seatLayout(graph, arrivals, fixed);
  const at = (key: string) => arrivals.get(key) ?? "";
  const ids = graph.nodes.map((n) => n.id);
  const held = ids.filter((id) => fixed[id]).sort(cmp);
  const order = [...held, ...ids.filter((id) => !fixed[id]).sort((a, b) => cmp(at(a), at(b)) || cmp(a, b))];
  return settle(graph, seats, order, new Set(held));
}

/** Settle `seats` into the shape of `graph`'s ties, every node in `order`
 * (the sums run in it); `held` nodes push and pull but never move. */
function settle(graph: Graph, seats: Positions, order: readonly string[], held: ReadonlySet<string>): Positions {
  const n = order.length, index = new Map(order.map((id, i) => [id, i]));
  const edges: Array<[number, number, number]> = [];
  for (const e of graph.edges) {
    const a = index.get(e.source), b = index.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    edges.push(a < b ? [a, b, e.weight ?? 1] : [b, a, e.weight ?? 1]);
  }
  edges.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const deg = new Int32Array(n), tie = new Int32Array(n).fill(-1);
  for (const [a, b] of edges) { deg[a] = deg[a]! + 1; deg[b] = deg[b]! + 1; tie[a] = b; tie[b] = a; }
  const isHeld = order.map((id) => held.has(id));
  // a leaf hangs on one tie to something tied to more; it fans out after
  const leaf = (i: number) => !isHeld[i] && deg[i] === 1 && deg[tie[i]!]! > 1;
  const core: number[] = [];
  for (let i = 0; i < n; i++) if (isHeld[i] || (deg[i]! > 0 && !leaf(i))) core.push(i);
  const C = core.length, slot = new Int32Array(n).fill(-1);
  core.forEach((i, k) => { slot[i] = k; });
  const ties: Array<[number, number, number]> = [];
  for (const [a, b, w] of edges) if (slot[a]! >= 0 && slot[b]! >= 0) ties.push([slot[a]!, slot[b]!, Math.sqrt(w)]);
  const x = new Float64Array(2 * C), mass = new Float64Array(C), moves = new Uint8Array(C);
  core.forEach((i, k) => {
    const [sx, sy] = seats[order[i]!]!;
    x[2 * k] = sx; x[2 * k + 1] = sy; mass[k] = deg[i]! + 1; moves[k] = isHeld[i] ? 0 : 1;
  });
  if (!held.size && C) gather(x, ties, SPREAD * Math.sqrt(C));
  forces(x, mass, moves, ties);

  const out: Positions = {};
  let reach = 0;
  core.forEach((i, k) => {
    const px = x[2 * k]!, py = x[2 * k + 1]!, r = Math.sqrt(px * px + py * py);
    if (r > reach) reach = r;
    out[order[i]!] = isHeld[i] ? seats[order[i]!]! : [two(px), two(py)];
  });
  // leaves: a sunflower around their tie, the first on the side away from the middle
  const fans = new Map<number, { u: [number, number]; k: number }>();
  for (let i = 0; i < n; i++) {
    if (!leaf(i)) continue;
    const p = tie[i]!, [px, py] = out[order[p]!]!;
    let fan = fans.get(p);
    if (!fan) { const l = Math.sqrt(px * px + py * py); fan = { u: l > 0 ? [px / l, py / l] : [1, 0], k: 0 }; fans.set(p, fan); }
    const r = FAN * Math.sqrt(fan.k + 1);
    out[order[i]!] = [two(px + fan.u[0] * r), two(py + fan.u[1] * r)];
    fan.u = turn(fan.u); fan.k++;
  }
  // tied to nothing: an even ring outside everything that is, in order
  const lone: number[] = [];
  for (let i = 0; i < n; i++) if (!isHeld[i] && deg[i] === 0) lone.push(i);
  const base = Math.max(reach, FAN), r0 = base * HALO_FROM, r1 = base * HALO_TO;
  let u: [number, number] = [1, 0];
  for (const [k, i] of lone.entries()) {
    const r = Math.sqrt(r0 * r0 + (r1 * r1 - r0 * r0) * (k + 0.5) / lone.length);
    out[order[i]!] = [two(u[0] * r), two(u[1] * r)];
    u = turn(u);
  }
  return out;
}

/** Bring the seeds together by their ties: centred, `size` across (root
 * mean square), then GATHER passes each moving a node a third of the way to
 * its ties' mean, rescaled to `size` after each. */
function gather(x: Float64Array, ties: ReadonlyArray<readonly [number, number, number]>, size: number): void {
  const C = x.length / 2, next = new Float64Array(2 * C), weight = new Float64Array(C);
  // centre `from` and write it into x at `size`
  const fit = (from: Float64Array) => {
    let cx = 0, cy = 0;
    for (let k = 0; k < C; k++) { cx += from[2 * k]!; cy += from[2 * k + 1]!; }
    cx /= C; cy /= C;
    let r2 = 0;
    for (let k = 0; k < C; k++) { from[2 * k] = from[2 * k]! - cx; from[2 * k + 1] = from[2 * k + 1]! - cy; r2 += from[2 * k]! * from[2 * k]! + from[2 * k + 1]! * from[2 * k + 1]!; }
    const f = r2 > 0 ? size / Math.sqrt(r2 / C) : 1;
    for (let k = 0; k < 2 * C; k++) x[k] = from[k]! * f;
  };
  fit(x);
  for (let pass = 0; pass < GATHER; pass++) {
    next.fill(0); weight.fill(0);
    for (const [a, b, w] of ties) {
      next[2 * a] = next[2 * a]! + x[2 * b]! * w; next[2 * a + 1] = next[2 * a + 1]! + x[2 * b + 1]! * w; weight[a] = weight[a]! + w;
      next[2 * b] = next[2 * b]! + x[2 * a]! * w; next[2 * b + 1] = next[2 * b + 1]! + x[2 * a + 1]! * w; weight[b] = weight[b]! + w;
    }
    for (let k = 0; k < C; k++) {
      const w = weight[k]!;
      if (w === 0) { next[2 * k] = x[2 * k]!; next[2 * k + 1] = x[2 * k + 1]!; continue; }
      next[2 * k] = (2 * w * x[2 * k]! + next[2 * k]!) / (3 * w); next[2 * k + 1] = (2 * w * x[2 * k + 1]! + next[2 * k + 1]!) / (3 * w);
    }
    fit(next);
  }
}

/** PASSES of the forces, in place: Barnes–Hut repulsion, ties pulled
 * together by √weight, gravity to the middle, each move capped by a heat
 * that falls pass by pass. Nodes with `moves` 0 never move. */
function forces(x: Float64Array, mass: Float64Array, moves: Uint8Array, ties: ReadonlyArray<readonly [number, number, number]>): void {
  const C = mass.length, cap = (DEPTH + 1) * C + 1;
  // the tree, rebuilt each pass: centre of mass, mass, corner, size, children, the one node a leaf cell holds (-1 none, -2 a lump)
  const cx = new Float64Array(cap), cy = new Float64Array(cap), cm = new Float64Array(cap);
  const ox = new Float64Array(cap), oy = new Float64Array(cap), size = new Float64Array(cap);
  const kids = new Int32Array(4 * cap), body = new Int32Array(cap), stack = new Int32Array(cap);
  const fx = new Float64Array(C), fy = new Float64Array(C);
  let used = 0;
  const cell = (x0: number, y0: number, s: number): number => {
    const c = used++;
    cx[c] = 0; cy[c] = 0; cm[c] = 0; ox[c] = x0; oy[c] = y0; size[c] = s; body[c] = -1;
    kids[4 * c] = -1; kids[4 * c + 1] = -1; kids[4 * c + 2] = -1; kids[4 * c + 3] = -1;
    return c;
  };
  const child = (c: number, px: number, py: number): number => {
    const h = size[c]! / 2, q = (px >= ox[c]! + h ? 1 : 0) + (py >= oy[c]! + h ? 2 : 0);
    let k = kids[4 * c + q]!;
    if (k < 0) { k = cell(ox[c]! + (q & 1 ? h : 0), oy[c]! + (q & 2 ? h : 0), h); kids[4 * c + q] = k; }
    return k;
  };
  const add = (c: number, i: number) => { cx[c] = cx[c]! + x[2 * i]! * mass[i]!; cy[c] = cy[c]! + x[2 * i + 1]! * mass[i]!; cm[c] = cm[c]! + mass[i]!; };
  for (let pass = 0; pass < PASSES; pass++) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < C; i++) {
      const px = x[2 * i]!, py = x[2 * i + 1]!;
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
    }
    used = 0;
    cell(x0, y0, Math.max(x1 - x0, y1 - y0) + 1);
    for (let i = 0; i < C; i++) {
      let c = 0;
      for (let depth = 0; ; depth++) {
        const empty = cm[c] === 0;
        add(c, i);
        if (empty) { body[c] = i; break; }
        if (body[c] === -2) break;
        if (depth === DEPTH) { body[c] = -2; break; }
        const j = body[c]!;
        if (j >= 0) { body[c] = -1; const k = child(c, x[2 * j]!, x[2 * j + 1]!); add(k, j); body[k] = j; }
        c = child(c, x[2 * i]!, x[2 * i + 1]!);
      }
    }
    for (let c = 0; c < used; c++) { cx[c] = cx[c]! / cm[c]!; cy[c] = cy[c]! / cm[c]!; }
    const theta = THETA_FROM + (THETA_TO - THETA_FROM) * pass / PASSES, open = theta * theta;
    for (let i = 0; i < C; i++) {
      if (!moves[i]) continue;
      const px = x[2 * i]!, py = x[2 * i + 1]!;
      let ax = 0, ay = 0, top = 0;
      stack[top++] = 0;
      while (top) {
        const c = stack[--top]!, b = body[c]!;
        if (b === i) continue;
        const dx = px - cx[c]!, dy = py - cy[c]!, d2 = dx * dx + dy * dy + 1;
        if (b !== -1 || size[c]! * size[c]! < open * d2) { const f = cm[c]! / d2; ax += dx * f; ay += dy * f; continue; }
        for (let q = 4 * c; q < 4 * c + 4; q++) if (kids[q]! >= 0) stack[top++] = kids[q]!;
      }
      fx[i] = ax * REPEL * mass[i]!; fy[i] = ay * REPEL * mass[i]!;
    }
    for (const [a, b, w] of ties) {
      const dx = (x[2 * a]! - x[2 * b]!) * w, dy = (x[2 * a + 1]! - x[2 * b + 1]!) * w;
      fx[a] = fx[a]! - dx; fy[a] = fy[a]! - dy; fx[b] = fx[b]! + dx; fy[b] = fy[b]! + dy;
    }
    const heat = HEAT * (1 - pass / PASSES) + 0.25;
    for (let i = 0; i < C; i++) {
      if (!moves[i]) continue;
      const px = x[2 * i]!, py = x[2 * i + 1]!, g = GRAVITY * mass[i]! / (Math.sqrt(px * px + py * py) + 0.01);
      let dx = (fx[i]! - px * g) / mass[i]!, dy = (fy[i]! - py * g) / mass[i]!;
      const l = Math.sqrt(dx * dx + dy * dy);
      if (l > heat) { dx = dx / l * heat; dy = dy / l * heat; }
      x[2 * i] = px + dx; x[2 * i + 1] = py + dy;
    }
  }
}

/** The graph with its positions in it. */
export const withLayout = (graph: Graph, arrivals: ReadonlyMap<string, string>): Graph => {
  const at = fieldLayout(graph, arrivals);
  return { ...graph, nodes: graph.nodes.map((n) => ({ ...n, x: at[n.id]![0], y: at[n.id]![1] })) };
};
