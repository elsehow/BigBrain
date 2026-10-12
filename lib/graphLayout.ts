/**
 * graphLayout.ts — settled node positions for a graph.
 *
 * This ran in the browser until 2026-08-17 (web/ui/src/lib/layout.worker.ts,
 * now deleted). It was the wrong side of the wire: a layout is a pure
 * function of the link structure, and that structure already has an identity
 * — `graph.hash`. Same hash, same picture, for every viewer and every device.
 * Computing it per client meant every page load paid ~580ms of simulation for
 * 726 nodes, and the result then had to travel UPSTREAM to be cached, through
 * a boundary that refuses writes. It was refused silently, so no vault ever
 * held a layout and the cost was paid on every load forever.
 *
 * Here it is computed once per structure, next to the vault that determines
 * it. The forces are the browser worker's, unchanged.
 */

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from "d3-force";
import type { Graph } from "./graph";
import { nodeSpacing, seedPosition } from "./graphGeometry";
import { sha256hex } from "./hash";

/** Node id → [x, y], rounded to 2dp (a tenth of a pixel is far below what a
 * canvas node can show, and the rounding is a third of the payload). */
export type Positions = Record<string, [number, number]>;

interface SimNode {
  index: number;
  id: string;
  x: number;
  y: number;
  /** the collision radius — the drawn disc plus room (graphGeometry.ts) */
  r: number;
}

/**
 * Settle `graph` into positions.
 *
 * `previous` is the last layout for this vault, whatever structure it was
 * for. Seeding from it is what makes a structure change look like the graph
 * MOVING rather than a different graph appearing: surviving nodes start where
 * they already are and drift, and only genuinely new nodes come in off the
 * spiral. The browser used to do this per tab, so every tab drifted its own
 * way and no two devices agreed; done here, continuity becomes a property of
 * the vault.
 */
export function computeLayout(graph: Graph, previous: Positions = {}, hold?: number): Positions {
  const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const nodes: SimNode[] = graph.nodes.map((n, i) => {
    const [sx, sy] = previous[n.id] ?? seedPosition(i);
    return { index: i, id: n.id, x: sx, y: sy, r: nodeSpacing(n.degree) };
  });

  // Edges reference nodes by id; d3 wants indices into `nodes`. An edge whose
  // endpoint is missing would make forceLink read undefined.x forever, so
  // drop it rather than trust the caller — a builder may cut orphans after
  // building edges, and this module should survive that ordering changing.
  const links: { source: number; target: number }[] = [];
  for (const e of graph.edges) {
    const a = index.get(e.source);
    const b = index.get(e.target);
    if (a !== undefined && b !== undefined) links.push({ source: a, target: b });
  }

  // A warm start needs less energy than a cold one: if most nodes already
  // have a place, nudge them rather than re-throwing the whole graph. Held
  // nodes only settle around their seats.
  const known = graph.nodes.filter((n) => previous[n.id]).length;
  const alpha = hold !== undefined ? 0.3 : known > graph.nodes.length / 2 ? 0.55 : 1;

  const sim = forceSimulation(nodes)
    .force("charge", forceManyBody<SimNode>().strength(-90).theta(0.9).distanceMax(700))
    .force(
      "link",
      forceLink<SimNode, { source: number; target: number }>(links).distance(36).strength(0.4)
    );
  // `hold`: each node is pulled to its start, which then fixes the frame; otherwise a weak pull to the middle does
  if (hold !== undefined) sim.force("x", forceX<SimNode>((n) => previous[n.id]![0]).strength(hold)).force("y", forceY<SimNode>((n) => previous[n.id]![1]).strength(hold));
  else sim.force("center", forceCenter(0, 0).strength(0.05)).force("x", forceX(0).strength(0.02)).force("y", forceY(0).strength(0.02));
  sim
    .force(
      "collide",
      forceCollide<SimNode>()
        .radius((n) => n.r)
        .strength(0.6)
    )
    .alpha(alpha)
    .alphaDecay(0.022)
    .stop();

  // Ticking to alphaMin is ~311 ticks cold. The browser streamed intermediate
  // frames so the user watched it settle; nobody is watching here, so run it
  // out and return the settled state.
  while (sim.alpha() > sim.alphaMin()) sim.tick();

  const out: Positions = {};
  for (const n of nodes) out[n.id] = [Math.round(n.x * 100) / 100, Math.round(n.y * 100) / 100];
  return out;
}

/** How firmly each node keeps its seat while an arrival layout settles. */
const SEAT_HOLD = 0.3;
/** How far a node is seated from the earlier nodes it arrived linked to. */
const SEAT_GAP = 24;
const unit = (s: string) => Number.parseInt(sha256hex(s).slice(0, 8), 16) / 0x1_0000_0000;
/** An edge's key in `arrivals`: its two ends, in order. */
export const edgeKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/**
 * A picture that is a pure function of a record and when each part of it
 * arrived, and that stays put as the record grows. `arrivals` holds a time for
 * every node id and every edge (`edgeKey`). Nodes are seated in arrival order,
 * ties by id: each beside the earlier nodes it arrived linked to (edges that
 * came later never move a seat), and one that arrived alone on the spiral at
 * its rank. Nothing that arrives later can move an earlier seat. Then the
 * whole settles briefly, each node held to its seat, so a new arrival nudges
 * its neighbours and nothing else. Every reader of the same record draws the
 * same picture: a shared server's field (lib/sharedReadUnion.ts serverGraph).
 */
export function arrivalLayout(graph: Graph, arrivals: ReadonlyMap<string, string>): Positions {
  const at = (key: string) => arrivals.get(key) ?? "";
  const order = (a: string, b: string) => at(a).localeCompare(at(b)) || a.localeCompare(b);
  const nodes = [...graph.nodes].sort((a, b) => order(a.id, b.id));
  const linked = new Map<string, string[]>();
  for (const e of graph.edges) for (const [a, b] of [[e.source, e.target], [e.target, e.source]] as const) {
    // only the links it arrived with: one made later is no reason to have sat elsewhere
    if (at(edgeKey(a, b)) > at(a)) continue;
    let list = linked.get(a); if (!list) linked.set(a, list = []); list.push(b);
  }
  const seats: Positions = {};
  nodes.forEach((n, k) => {
    const near = (linked.get(n.id) ?? []).flatMap((id) => seats[id] ? [seats[id]] : []);
    if (!near.length) { seats[n.id] = seedPosition(k); return; }
    const [x, y] = near.reduce(([sx, sy], [px, py]) => [sx + px, sy + py], [0, 0]), turn = unit(n.id) * 2 * Math.PI;
    seats[n.id] = [x / near.length + Math.cos(turn) * SEAT_GAP, y / near.length + Math.sin(turn) * SEAT_GAP];
  });
  const edges = [...graph.edges].sort((a, b) => edgeKey(a.source, a.target).localeCompare(edgeKey(b.source, b.target)));
  return computeLayout({ ...graph, nodes, edges }, seats, SEAT_HOLD);
}
