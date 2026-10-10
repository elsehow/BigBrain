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
 * A structure change places rather than re-settles (placeLayout): only the
 * nodes whose own connections changed move, settling among the nodes around
 * them, which stay where they are. A whole-graph settle (computeLayout) runs
 * on a cold start, a change too large to place, and once the moves placed
 * since the last settle add up to a share of the graph (lib/graphCache.ts).
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
export function computeLayout(graph: Graph, previous: Positions = {}): Positions {
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
  // have a place, nudge them rather than re-throwing the whole graph.
  const known = graph.nodes.filter((n) => previous[n.id]).length;
  const alpha = known > graph.nodes.length / 2 ? 0.55 : 1;

  const sim = forceSimulation(nodes)
    .force("charge", charge())
    .force("link", pull(links))
    .force("center", forceCenter(0, 0).strength(0.05))
    .force("x", forceX(0).strength(0.02))
    .force("y", forceY(0).strength(0.02))
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

const neighbours = (graph: Graph): Map<string, string[]> => {
  const around = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) {
    const a = around.get(e.source), b = around.get(e.target);
    if (a && b) { a.push(e.target); b.push(e.source); }
  }
  return around;
};

/** What each node is connected to, as a short signature ("" for none). */
export function neighbourSignatures(graph: Graph): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, ids] of neighbours(graph)) out[id] = ids.length ? sha256hex(ids.sort().join("\n")).slice(0, 12) : "";
  return out;
}

/** A turn of the circle, from the id: where a node sits around its anchor. */
const angleOf = (id: string): number => (parseInt(sha256hex(id).slice(0, 8), 16) / 2 ** 32) * 2 * Math.PI;

/**
 * Place a structure change into `previous`, a settled layout whose nodes had
 * the connections `before` signs. A node moves only when its connections
 * changed (`now`) or it is new; everything else keeps its position exactly.
 * A moving node that was already connected starts where it was; one that is
 * new or newly connected starts beside what it now connects to; one that
 * connects to nothing placed starts where the layout keeps its lone nodes,
 * at their median distance from the centre, at an angle from its id. They then
 * settle with the same forces as a whole-graph settle, among their
 * neighbours and whatever stands where they land, held still.
 *
 * Undefined when most of the graph is new: there is nothing to place into.
 */
export function placeLayout(graph: Graph, previous: Positions, before: Record<string, string>,
  now: Record<string, string> = neighbourSignatures(graph)): { positions: Positions; moved: number } | undefined {
  if (graph.nodes.filter((n) => previous[n.id]).length <= graph.nodes.length / 2) return undefined;
  const around = neighbours(graph);
  const degree = new Map(graph.nodes.map((n) => [n.id, n.degree]));
  const free = new Set(graph.nodes.filter((n) => !previous[n.id] || before[n.id] !== now[n.id]).map((n) => n.id));
  const at = new Map<string, [number, number]>();
  for (const n of graph.nodes) if (!free.has(n.id)) at.set(n.id, previous[n.id]!);
  const out: Positions = Object.fromEntries(at);
  if (!free.size) return { positions: out, moved: 0 };

  // Where each moving node starts.
  let waiting: string[] = [];
  for (const id of free) {
    if (previous[id] && before[id]) at.set(id, previous[id]!);
    else waiting.push(id);
  }
  for (let placed = true; placed && waiting.length; ) {
    placed = false;
    const next: string[] = [];
    for (const id of waiting) {
      const anchors = around.get(id)!.flatMap((o) => { const p = at.get(o); return p ? [p] : []; });
      if (!anchors.length) { next.push(id); continue; }
      const a = angleOf(id), r = nodeSpacing(degree.get(id) ?? 0) * 2;
      at.set(id, [anchors.reduce((t, p) => t + p[0], 0) / anchors.length + Math.cos(a) * r,
        anchors.reduce((t, p) => t + p[1], 0) / anchors.length + Math.sin(a) * r]);
      placed = true;
    }
    waiting = next;
  }
  if (waiting.length) {
    // A settle spreads unconnected nodes through the outer field; with none
    // to follow, just outside what is there.
    const radius = (lone: boolean) => graph.nodes.flatMap((n) => {
      const p = out[n.id];
      return p && (!lone || now[n.id] === "") ? [Math.hypot(p[0], p[1])] : [];
    }).sort((x, y) => x - y);
    const lone = radius(true), all = radius(false);
    const ring = lone.length ? lone[Math.floor(lone.length / 2)]! : (all[Math.floor(all.length * 0.98)] ?? 0) + 40;
    for (const id of waiting) at.set(id, previous[id] ?? [Math.cos(angleOf(id)) * ring, Math.sin(angleOf(id)) * ring]);
  }

  // What they settle among: their neighbours, and what stands where they land.
  const CELL = 60, cell = ([x, y]: [number, number]) => [Math.floor(x / CELL), Math.floor(y / CELL)] as const;
  const grid = new Map<string, string[]>();
  for (const [id, p] of Object.entries(out)) {
    const [cx, cy] = cell(p), key = `${cx},${cy}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(id); else grid.set(key, [id]);
  }
  const context = new Set<string>();
  for (const id of free) {
    for (const o of around.get(id)!) if (!free.has(o)) context.add(o);
    const [cx, cy] = cell(at.get(id)!);
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (const o of grid.get(`${cx + dx},${cy + dy}`) ?? []) context.add(o);
  }
  const ids = [...free, ...context], index = new Map(ids.map((id, i) => [id, i]));
  const nodes: (SimNode & { fx?: number; fy?: number })[] = ids.map((id, i) => {
    const [x, y] = at.get(id)!;
    return { index: i, id, x, y, r: nodeSpacing(degree.get(id) ?? 0), ...(free.has(id) ? {} : { fx: x, fy: y }) };
  });
  const links: Link[] = [];
  for (const e of graph.edges) {
    const a = index.get(e.source), b = index.get(e.target);
    if (a !== undefined && b !== undefined && (free.has(e.source) || free.has(e.target))) links.push({ source: a, target: b });
  }
  const sim = forceSimulation(nodes).force("charge", charge()).force("link", pull(links)).force("collide", collide())
    .alpha(0.5).alphaDecay(0.04).stop();
  while (sim.alpha() > sim.alphaMin()) sim.tick();
  for (const n of nodes) if (free.has(n.id)) out[n.id] = rounded(n);
  return { positions: out, moved: free.size };
}
