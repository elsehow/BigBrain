import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";

export interface GraphFocusStyle {
  overviewCount: number;
  compactness: number;
  hops: number;
  preferConnected?: boolean;
}

export const GRAPH_FOCUS: Readonly<GraphFocusStyle> = { overviewCount: 180, compactness: 1, hops: 1, preferConnected: true };

/** Stable importance ranking: changing the budget reveals a nested set. */
export function overviewNodes(scores: Float32Array, count: number, ids: readonly string[] = [], adjacency?: readonly (readonly number[])[], preferConnected = true): Uint8Array {
  const order = Array.from(scores, (_, i) => i).sort((a, b) => scores[b]! - scores[a]!
    || (ids[a] ?? String(a)).localeCompare(ids[b] ?? String(b)));
  const visible = new Uint8Array(scores.length);
  const limit = Math.max(1, Math.round(count));
  if (!adjacency || !preferConnected) {
    for (const i of order.slice(0, limit)) visible[i] = 1;
    return visible;
  }
  // Choose the largest real component; importance breaks equal-size ties.
  // Starting at its highest-ranked note, grow through actual neighbors so
  // omitted bridge notes cannot turn the visible subset into little islands.
  const seen = new Uint8Array(scores.length);
  let component: number[] = [], bestImportance = -Infinity;
  for (const root of order) {
    if (seen[root]) continue;
    const queue = [root]; seen[root] = 1;
    let importance = 0;
    for (let k = 0; k < queue.length; k++) {
      const i = queue[k]!; importance += scores[i]!;
      for (const j of adjacency[i] ?? []) if (j >= 0 && j < scores.length && !seen[j]) {
        seen[j] = 1; queue.push(j);
      }
    }
    if (queue.length > component.length || (queue.length === component.length && importance > bestImportance)) {
      component = queue; bestImportance = importance;
    }
  }
  const members = new Set(component), seed = order.find(i => members.has(i));
  const frontier = new Set(seed === undefined ? [] : [seed]);
  for (let k = 0; k < limit && frontier.size; k++) {
    const i = order.find(j => frontier.has(j))!;
    frontier.delete(i); visible[i] = 1;
    for (const j of adjacency[i] ?? []) if (members.has(j) && !visible[j]) frontier.add(j);
  }
  return visible;
}

type Dot = { id: string; x: number; y: number; r: number };

/** A display-only layout of the overview. Hidden notes exert no forces.
 * Solve only when the data or overview controls change, never on hover.
 * Real links determine the springs; no inferred links are drawn. */
export function compactOverview(nodes: readonly Dot[], adj: readonly (readonly number[])[], visible: Uint8Array, amount: number): { x: number; y: number }[] {
  const strength = Math.max(0, Math.min(1, amount));
  if (!strength || !nodes.length) return nodes.map(n => ({ x: n.x, y: n.y }));
  const indices = nodes.map((_, i) => i).filter(i => visible[i]).sort((a, b) => nodes[a]!.id.localeCompare(nodes[b]!.id));
  const simNodes = indices.map(i => ({ ...nodes[i]!, x: nodes[i]!.x * 0.2, y: nodes[i]!.y * 0.2 }));
  const links = indices.flatMap(i => adj[i]!.filter(j => visible[j] && nodes[i]!.id < nodes[j]!.id)
    .map(j => ({ source: nodes[i]!.id, target: nodes[j]!.id })));
  const sim = forceSimulation(simNodes)
    .force("charge", forceManyBody().strength(-65))
    .force("link", forceLink<(typeof simNodes)[number], (typeof links)[number]>(links).id(n => n.id).distance(38).strength(0.15))
    .force("x", forceX(0).strength(0.07))
    .force("y", forceY(0).strength(0.07))
    .force("collide", forceCollide<(typeof simNodes)[number]>().radius(n => n.r + 7).iterations(2))
    .stop();
  sim.tick(180);
  const target = nodes.map(n => ({ x: n.x * 0.2, y: n.y * 0.2 }));
  indices.forEach((i, k) => { target[i] = { x: simNodes[k]!.x, y: simNodes[k]!.y }; });
  // Attach background notes to the closest overview node by graph distance.
  // Their positions are ready before hover, so revealing them never moves peers.
  const owner = new Int32Array(nodes.length).fill(-1), queue = [...indices];
  for (const i of indices) owner[i] = i;
  for (let k = 0; k < queue.length; k++) {
    const i = queue[k]!;
    for (const j of adj[i]!) if (owner[j] === -1) { owner[j] = owner[i]!; queue.push(j); }
  }
  nodes.forEach((n, i) => {
    if (visible[i] || owner[i]! < 0) return;
    const a = owner[i]!, origin = nodes[a]!;
    let dx = (n.x - origin.x) * 0.35, dy = (n.y - origin.y) * 0.35;
    if (Math.hypot(dx, dy) < 1) { dx = 24 * Math.cos(i * 2.4); dy = 24 * Math.sin(i * 2.4); }
    const cap = Math.min(1, 90 / Math.hypot(dx, dy));
    target[i] = { x: target[a]!.x + dx * cap, y: target[a]!.y + dy * cap };
  });
  // Background notes can share a parent and the same capped offset. They
  // need collision space too, before exploration reveals them. Fix the
  // overview in place so hidden notes never rearrange the visible picture.
  if (indices.length < nodes.length) {
    const order = nodes.map((_, i) => i).sort((a, b) => nodes[a]!.id.localeCompare(nodes[b]!.id));
    const separated = order.map(i => ({
      ...target[i]!, r: nodes[i]!.r, vx: 0, vy: 0,
      fx: visible[i] ? target[i]!.x : undefined,
      fy: visible[i] ? target[i]!.y : undefined,
    }));
    const collision = forceSimulation(separated)
      .force("collide", forceCollide<(typeof separated)[number]>().radius(n => n.r + 7).iterations(4))
      .stop();
    for (let tick = 0; tick < 120; tick++) {
      collision.tick();
      if (separated.every(n => Math.hypot(n.vx ?? 0, n.vy ?? 0) < 0.02)) break;
    }
    order.forEach((i, k) => { target[i] = { x: separated[k]!.x, y: separated[k]!.y }; });
  }
  return nodes.map((n, i) => ({ x: n.x + (target[i]!.x - n.x) * strength, y: n.y + (target[i]!.y - n.y) * strength }));
}
