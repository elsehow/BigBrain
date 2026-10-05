// The v2 view's model: /api/graph's entities lifted into a shallow 3D
// field, and the name search. Pure — the scene (scene.ts) draws it, the view
// (V2View.svelte) reads it, and neither reshapes it.

import type { V2Feed, V2FeedRow } from "../../../../../lib/v2Feed";
import type { GraphData } from "../types";

export type { V2Feed, V2FeedRow };

export interface FieldNode {
  i: number;
  id: string;
  label: string;
  /** /api/graph's note path, for the entity's own assertions. */
  path: string | null;
  degree: number;
  memory: boolean;
  p: [number, number, number];
  /** Labelled at rest: a hub or a memory topic. */
  named: boolean;
}
export interface Field {
  nodes: FieldNode[];
  byId: Map<string, number>;
  /** Every co-mention among drawn nodes: [a, b, weight]. */
  edges: Array<[number, number, number]>;
  /** The few worth drawing: strong, and strong for both ends. */
  strong: Array<[number, number]>;
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

export function buildField(graph: GraphData): Field {
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

  return { nodes, byId, edges, strong: strongEdges(nodes, edges), hubs };
}

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

// ── pilots: the real agents ────────────────────────────────────────────────
/** A pilot session as /api/pilot/chat summarises it (the fields this view reads). */
export interface PilotSummary {
  id: string;
  title: string;
  model: string;
  phase: "draft" | "working" | "answered" | "interrupted" | "failed";
  lifecycle?: "active" | "dormant" | "ingested";
  /** Set when the session was archived (closed by hand) — the app's rule. */
  deactivatedAt?: string;
  lastActivityAt?: string;
  created?: string;
  updated?: string;
  live?: string;
  activity?: string;
  context?: string[];
  contextNodes?: Array<{ id: string; path?: string; title?: string; group?: string }>;
}
export interface FieldPilot {
  id: string;
  title: string;
  model: string;
  phase: PilotSummary["phase"];
  /** Field nodes in its context: what it's about. */
  ctx: number[];
  p: [number, number, number];
}

/** The pilots worth a place, in the order they were started (a new one joins
 * on the right): not archived (closed by hand, the app's `deactivatedAt`) and
 * not filed away (ingested, after a day idle). An idle session ("dormant"
 * after ten quiet minutes) keeps its seat. Plus `keep` (the one open),
 * whatever its state, until it's closed. */
export function barPilots(sessions: readonly PilotSummary[], keep: string | null, limit = 9): PilotSummary[] {
  const born = (s: PilotSummary) => s.created ?? s.lastActivityAt ?? "";
  const live = sessions.filter((s) => !s.deactivatedAt && s.lifecycle !== "ingested").sort((a, b) => born(a).localeCompare(born(b)) || a.id.localeCompare(b.id));
  const open = keep ? sessions.find((s) => s.id === keep) : undefined;
  const seats = live.slice(-limit);
  return open && !seats.includes(open) ? [...seats, open] : seats;
}

/** Each pilot over its context; one with nothing placeable waits above the
 * middle. Then they're pushed apart so none sits inside another. */
export function placePilots(field: Field, sessions: readonly PilotSummary[]): FieldPilot[] {
  const out: FieldPilot[] = sessions.map((s, k) => {
    const refs = [...(s.contextNodes ?? []).flatMap((n) => [n.id, n.path ?? ""]), ...(s.context ?? [])];
    const ctx = [...new Set(refs.map((r) => field.byId.get(r)).filter((x): x is number => x != null))];
    const c: [number, number, number] = [0, 0, 0];
    if (ctx.length) for (const i of ctx) for (let d = 0; d < 3; d++) c[d]! += field.nodes[i]!.p[d]! / ctx.length;
    else { c[0] = (k - (sessions.length - 1) / 2) * 3; c[1] = 4; c[2] = -2; }
    return { id: s.id, title: s.title, model: s.model, phase: s.phase, ctx, p: [c[0] + 0.4, Math.min(7.2, c[1] + 2.2), c[2] + 0.8] };
  });
  for (let pass = 0; pass < 40; pass++) for (const a of out) for (const b of out) {
    if (a === b) continue;
    const dx = a.p[0] - b.p[0], dz = a.p[2] - b.p[2], d = Math.hypot(dx, dz) || 0.01;
    if (d < 3.2) { const push = (3.2 - d) / 2 / d; a.p[0] += dx * push; a.p[2] += dz * push; }
  }
  return out;
}

/** A model id read as family and version, with no list of names: the
 * numbers are the version ("claude-opus-4-5" → claude-opus 4.5, "gpt-6.1-sol"
 * → gpt-sol 6.1), a trailing date marks a pinned snapshot of an alias. */
function modelVersion(id: string): { family: string; version: number[]; dated: boolean } {
  const parts = id.toLowerCase().split("-");
  const dated = parts.length > 1 && /^\d{8}$/.test(parts[parts.length - 1]!);
  if (dated) parts.pop();
  const version = parts.filter((p) => /^\d+(\.\d+)*$/.test(p)).flatMap((p) => p.split(".").map(Number));
  return { family: parts.filter((p) => !/^\d+(\.\d+)*$/.test(p)).join("-"), version, dated };
}
const newer = (a: number[], b: number[]): number => {
  for (let k = 0; k < Math.max(a.length, b.length); k++) if ((a[k] ?? 0) !== (b[k] ?? 0)) return (a[k] ?? 0) - (b[k] ?? 0);
  return 0;
};
/** Each family's newest model (its alias over a dated snapshot), in the
 * list's own order, and the rest. New releases sort themselves in. */
export function latestPerFamily<M extends { id: string }>(models: readonly M[]): { latest: M[]; other: M[] } {
  const best = new Map<string, { m: M; v: ReturnType<typeof modelVersion> }>();
  for (const m of models) {
    const v = modelVersion(m.id), held = best.get(v.family);
    const d = held ? newer(v.version, held.v.version) : 1;
    if (!held || d > 0 || (d === 0 && held.v.dated && !v.dated)) best.set(v.family, { m, v });
  }
  const keep = new Set([...best.values()].map((b) => b.m));
  return { latest: models.filter((m) => keep.has(m)), other: models.filter((m) => !keep.has(m)) };
}
