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
 *
 * Your field and a server's own field are seated instead (lib/views/layout.ts,
 * R7): a pure function of when each part arrived. What is left here draws
 * the union of your field with your joined servers' (lib/sharedGraphLayout.ts)
 * until servers are held locally (R8).
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

type Link = { source: number; target: number };
// The forces a placement shares with a whole-graph settle, built in one place
// so the two cannot drift apart.
const charge = () => forceManyBody<SimNode>().strength(-90).theta(0.9).distanceMax(700);
const pull = (links: Link[]) => forceLink<SimNode, Link>(links).distance(36).strength(0.4);
const collide = () => forceCollide<SimNode>().radius((n) => n.r).strength(0.6);
const rounded = (n: SimNode): [number, number] => [Math.round(n.x * 100) / 100, Math.round(n.y * 100) / 100];

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
  const links: Link[] = [];
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
    .force("charge", charge())
    .force("link", pull(links));
  // `hold`: each node is pulled to its start, which then fixes the frame; otherwise a weak pull to the middle does
  if (hold !== undefined) sim.force("x", forceX<SimNode>((n) => previous[n.id]![0]).strength(hold)).force("y", forceY<SimNode>((n) => previous[n.id]![1]).strength(hold));
  else sim.force("center", forceCenter(0, 0).strength(0.05)).force("x", forceX(0).strength(0.02)).force("y", forceY(0).strength(0.02));
  sim
    .force("collide", collide())
    .alpha(alpha)
    .alphaDecay(0.022)
    .stop();

  // Ticking to alphaMin is ~311 ticks cold. The browser streamed intermediate
  // frames so the user watched it settle; nobody is watching here, so run it
  // out and return the settled state.
  while (sim.alpha() > sim.alphaMin()) sim.tick();

  const out: Positions = {};
  for (const n of nodes) out[n.id] = rounded(n);
  return out;
}
