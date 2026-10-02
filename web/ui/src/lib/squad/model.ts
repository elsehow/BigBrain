// The squad view's model: /api/graph's entities lifted into a shallow 3D
// field, the agents of /api/squad placed over what they're writing about,
// and the name search. Pure — the scene (scene.ts) draws it, the view
// (SquadView.svelte) reads it, and neither reshapes it.

import type { Squad, SquadAgent, SquadFeedRow } from "../../../../../lib/squadGraph";
import type { GraphData } from "../types";

export type { SquadFeedRow };
export type SquadData = Squad;

export interface FieldNode {
  i: number;
  id: string;
  label: string;
  /** /api/graph's note path, for the entity's own assertions. */
  path: string | null;
  degree: number;
  memory: boolean;
  p: [number, number, number];
  /** Labelled at rest: a hub, a memory topic, or something an agent touches. */
  named: boolean;
}
export interface FieldAgent extends SquadAgent {
  i: number;
  key: string;
  /** Wrote within the last day. */
  working: boolean;
  p: [number, number, number];
  touchIdx: number[];
}
export interface Field {
  nodes: FieldNode[];
  byId: Map<string, number>;
  /** Every co-mention among drawn nodes: [a, b, weight]. */
  edges: Array<[number, number, number]>;
  /** The few worth drawing: strong, and strong for both ends. */
  strong: Array<[number, number]>;
  agents: FieldAgent[];
  hubs: Set<number>;
}

const STRONG_EDGES = 140;
const HUBS = 8;

/** Deterministic 0..1 from a string: an entity keeps its height across loads. */
function unit(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10007) / 10007;
}

export function buildField(graph: GraphData, squad: SquadData, now = Date.now()): Field {
  const drawn = graph.nodes.filter((n) => (n.entity || n.group === "memory") && n.x != null && n.y != null);
  // the engine's settled 2D layout is the floor plan; height is a small,
  // stable lift so the field reads as a volume without inventing structure
  const xs = drawn.map((n) => n.x!), ys = drawn.map((n) => n.y!);
  const med = (a: number[]) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)] ?? 0;
  const cx = med(xs), cy = med(ys);
  // a vault's layout is a dense core and a sparse halo; keep each node's
  // direction from the centre but re-space its distance by rank, so the core
  // opens up and the halo comes in (the field then reads evenly at a glance)
  const radius = drawn.map((n) => Math.hypot(n.x! - cx, n.y! - cy));
  const order = radius.map((r, i) => [r, i] as const).sort((a, b) => a[0] - b[0]);
  const spaced = new Float32Array(drawn.length);
  order.forEach(([, i], rank) => { spaced[i] = 15 * (0.08 + 0.92 * Math.sqrt(rank / Math.max(1, drawn.length - 1))); });
  const nodes: FieldNode[] = drawn.map((n, i) => {
    const memory = n.group === "memory";
    const r = radius[i]! || 1, s = spaced[i]! / r;
    return {
      i, id: n.id, label: n.title, path: n.path === undefined ? n.id : n.path, degree: n.degree, memory, named: memory,
      p: [(n.x! - cx) * s, 3 + (unit(n.id) - 0.5) * 2.6 + Math.min(1.2, Math.log1p(n.degree) * 0.12) + (memory ? 1.8 : 0), (n.y! - cy) * s * 0.8 - 4],
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n.i]));
  const edges: Array<[number, number, number]> = [];
  for (const e of graph.edges) {
    const a = byId.get(e.source), b = byId.get(e.target);
    if (a != null && b != null) edges.push([a, b, e.weight ?? 1]);
  }
  const hubs = new Set([...nodes].filter((n) => !n.memory).sort((a, b) => b.degree - a.degree).slice(0, HUBS).map((n) => n.i));
  for (const h of hubs) nodes[h]!.named = true;

  const agents: FieldAgent[] = squad.agents.map((a, i) => {
    const touchIdx = a.touch.map((id) => byId.get(id)).filter((x): x is number => x != null);
    for (const t of touchIdx) nodes[t]!.named = true;
    const c: [number, number, number] = [0, 0, 0];
    const pts = touchIdx.length ? touchIdx : [...hubs];
    for (const t of pts) for (let d = 0; d < 3; d++) c[d]! += nodes[t]!.p[d]! / pts.length;
    return { ...a, i, key: String(i + 1), working: now - Date.parse(a.lastAt) < 864e5, touchIdx, p: [c[0] + 0.4, Math.min(7.2, c[1] + 2.2), c[2] + 0.8] };
  });
  // agents whose work centres on the same cluster would sit inside each
  // other: push them apart on the floor until each has room
  for (let pass = 0; pass < 40; pass++) for (const a of agents) for (const b of agents) {
    if (a === b) continue;
    const dx = a.p[0] - b.p[0], dz = a.p[2] - b.p[2], d = Math.hypot(dx, dz) || 0.01;
    if (d < AGENT_ROOM) { const push = (AGENT_ROOM - d) / 2 / d; a.p[0] += dx * push; a.p[2] += dz * push; }
  }
  return { nodes, byId, edges, strong: strongEdges(nodes, edges), agents, hubs };
}
const AGENT_ROOM = 3.2;

/** Keep each node's strongest ties, then the few that are strong AND specific
 * to both ends (weight × cosine): a hub's lines don't crowd out the rest. */
export function strongEdges(nodes: FieldNode[], edges: Array<[number, number, number]>, limit = STRONG_EDGES): Array<[number, number]> {
  const deg = new Map<number, number>();
  for (const [a, b, w] of edges) { deg.set(a, (deg.get(a) ?? 0) + w); deg.set(b, (deg.get(b) ?? 0) + w); }
  const best = new Map<number, Array<[number, number, number]>>();
  for (const e of edges) for (const end of [e[0], e[1]]) { const l = best.get(end) ?? []; l.push(e); best.set(end, l); }
  const kept = new Set<[number, number, number]>();
  for (const l of best.values()) for (const e of l.sort((x, y) => y[2] - x[2]).slice(0, 4)) kept.add(e);
  return [...kept]
    .filter(([a, b, w]) => w >= 2 && !nodes[a]!.memory && !nodes[b]!.memory)
    .map(([a, b, w]) => [w * w / Math.sqrt((deg.get(a) ?? 1) * (deg.get(b) ?? 1)), a, b] as const)
    .sort((x, y) => y[0] - x[0]).slice(0, limit).map(([, a, b]) => [a, b]);
}

/** An entity's strongest ties, for the opened view. */
export function neighbours(field: Field, i: number, limit = 8): number[] {
  return field.edges.filter(([a, b]) => a === i || b === i).sort((x, y) => y[2] - x[2]).slice(0, limit).map(([a, b]) => (a === i ? b : a));
}

// ── search by name ─────────────────────────────────────────────────────────
export const normName = (s: string): string => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "");

/** Same name once case, spaces and punctuation go: "StarChart" and
 * "Star Chart" are twins, and probably one thing split in two. */
export function twinsOf(field: Field): Map<number, number[]> {
  const groups = new Map<string, number[]>();
  for (const n of field.nodes) if (!n.memory) { const k = normName(n.label); groups.set(k, [...(groups.get(k) ?? []), n.i]); }
  const out = new Map<number, number[]>();
  for (const g of groups.values()) if (g.length > 1) for (const i of g) out.set(i, g.filter((j) => j !== i));
  return out;
}

export function searchNames(field: Field, raw: string): number[] {
  const q = raw.trim().toLowerCase(), qn = normName(q);
  if (!q) return [];
  const score = (n: FieldNode): number => {
    const low = n.label.toLowerCase(), norm = normName(n.label);
    if (low === q || norm === qn) return 0;
    if (low.startsWith(q)) return 1;
    if (low.split(/[\s\-–(/]+/).some((w) => w.startsWith(q))) return 2;
    if (low.includes(q)) return 3;
    if (qn.length >= 3 && norm.includes(qn)) return 4;
    return -1;
  };
  return field.nodes.map((n) => [score(n), n] as const).filter(([s]) => s >= 0)
    .sort((a, b) => a[0] - b[0] || b[1].degree - a[1].degree).map(([, n]) => n.i);
}
