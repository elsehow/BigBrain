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
  /** Its other names (aliases folded into it): search finds it by any. */
  aliases: string[];
  /** /api/graph's note path, for the entity's own assertions. */
  path: string | null;
  degree: number;
  memory: boolean;
  p: [number, number, number];
  /** Labelled at rest: a hub or a memory topic. */
  named: boolean;
}
/** A source: the graph's own source node, on the entities' floor plan. Kept
 * apart from `nodes`, so search, ties, folds and Desktops read entities alone. */
export interface FieldSource {
  id: string;
  label: string;
  /** Its note path (a thread's, then its members'): how a feed row finds it. */
  paths: string[];
  p: [number, number, number];
  /** The entities it mentions, as node indices. */
  ties: number[];
}
export interface Field {
  nodes: FieldNode[];
  byId: Map<string, number>;
  /** Every co-mention among drawn nodes: [a, b, weight]. */
  edges: Array<[number, number, number]>;
  /** The few worth drawing: strong, and strong for both ends. */
  strong: Array<[number, number]>;
  hubs: Set<number>;
  sources: FieldSource[];
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
  // MEMORY.md with no topic files beside it would be one glass labelled
  // "Memory" over the whole field, which shows the user nothing.
  const memories = graph.nodes.filter((n) => n.group === "memory");
  const loneIndex = memories.length === 1 && /(^|\/)MEMORY\.md$/.test(memories[0]!.path ?? memories[0]!.id);
  const drawn = graph.nodes.filter((n) => (n.entity || (n.group === "memory" && !loneIndex)) && n.x != null && n.y != null);
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
  const spacedAt = (rank: number) => 15 * (0.08 + 0.92 * Math.sqrt(rank / Math.max(1, drawn.length - 1)));
  const spaced = new Float32Array(drawn.length);
  order.forEach(([, i], rank) => { spaced[i] = spacedAt(rank); });
  const nodes: FieldNode[] = drawn.map((n, i) => {
    const memory = n.group === "memory";
    const r = radius[i]! || 1, s = spaced[i]! / r;
    return {
      i, id: n.id, label: n.title, aliases: n.aliases ?? [], path: n.path === undefined ? n.id : n.path, degree: n.degree, memory, named: memory,
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

  // Sources keep their own place in the engine's layout, re-spaced as the
  // entities were: a source's distance takes the rank it would have among
  // theirs. One the layout didn't place sits over what it mentions.
  const sortedR = order.map(([r]) => r);
  const spaceAt = (r: number): number => {
    if (!sortedR.length) return 0;
    let lo = 0, hi = sortedR.length - 1;
    if (r >= sortedR[hi]!) return 15 * Math.min(1.15, r / (sortedR[hi]! || 1));
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (sortedR[m]! <= r) lo = m; else hi = m; }
    return spacedAt(lo + Math.max(0, (r - sortedR[lo]!) / ((sortedR[hi]! - sortedR[lo]!) || 1)));
  };
  const sourceNodes = graph.nodes.filter((n) => n.group === "source");
  const mentions = new Map(sourceNodes.map((n) => [n.id, new Set<number>()]));
  const mention = (src: string, other: string) => {
    const set = mentions.get(src), i = byId.get(other);
    if (!set || i == null || nodes[i]!.memory) return;
    set.add(i);
  };
  for (const e of graph.edges) { mention(e.source, e.target); mention(e.target, e.source); }
  const sources: FieldSource[] = [];
  for (const n of sourceNodes) {
    const ties = [...(mentions.get(n.id) ?? [])];
    const lift = 3 + (unit(n.id) - 0.5) * 2.6;
    let p: [number, number, number];
    if (n.x != null && n.y != null) {
      const r = Math.hypot(n.x - cx, n.y - cy) || 1, s = spaceAt(r) / r;
      p = [(n.x - cx) * s, lift, (n.y - cy) * s * 0.8 - 4];
    } else if (ties.length) {
      p = [0, lift, 0];
      for (const i of ties) { p[0] += nodes[i]!.p[0] / ties.length; p[2] += nodes[i]!.p[2] / ties.length; }
    } else continue;
    const path = n.path === undefined ? n.id : n.path;
    sources.push({ id: n.id, label: n.title, paths: [...(path ? [path] : []), ...(n.memberPaths ?? [])], p, ties });
  }

  return { nodes, byId, edges, strong: strongEdges(nodes, edges), hubs, sources };
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

// ── folding: names that are one thing ──────────────────────────────────────
/** The merges an opened entity is part of, each `from` → `keep`: every
 * other member of its group folding into the one that stays (a proposal's own
 * pick, else the most-tied twin). The same rows show on every member's page;
 * the opened entity's own row comes first. */
export interface FoldOffer { keep: string; rows: string[]; kind: "twins" | "proposal"; why?: string }
const RECORDED = /^ent_[a-f0-9]{20}$/;
/** The offer on entity `i`: the memory pass's proposal it belongs to, else
 * its same-name twins — less any pair you said are two things (`rejected`,
 * the fold log's pairs). Only entities this vault's record holds fold: a
 * joined vault's node or a legacy note never does. */
export function foldOffer(field: Field, i: number, twins: ReadonlyMap<number, number[]>,
  proposals: ReadonlyArray<{ canonical: string; members: ReadonlyArray<{ id: string }>; why: string }>,
  rejected: ReadonlyArray<readonly [string, string]> = []): FoldOffer | null {
  const n = field.nodes[i];
  if (!n || !RECORDED.test(n.id)) return null;
  const apart = (a: string, b: string) => rejected.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  const ties = (id: string) => field.nodes[field.byId.get(id) ?? -1]?.degree ?? 0;
  const g = proposals.find((p) => p.members.some((m) => m.id === n.id));
  const members = (g ? g.members.map((m) => m.id) : [n.id, ...(twins.get(i) ?? []).map((j) => field.nodes[j]!.id)])
    .filter((id) => RECORDED.test(id) && (id === n.id || !apart(id, n.id)));
  if (members.length < 2) return null;
  const keep = g && members.includes(g.canonical) ? g.canonical : members.reduce((a, b) => (ties(b) > ties(a) ? b : a));
  const rows = members.filter((id) => id !== keep && !apart(id, keep))
    .sort((a, b) => Number(b === n.id) - Number(a === n.id) || ties(b) - ties(a));
  return rows.length ? { keep, rows, kind: g ? "proposal" : "twins", ...(g?.why ? { why: g.why } : {}) } : null;
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
  const scoreName = (name: string): number => {
    const low = name.toLowerCase(), norm = normName(name);
    if (low === q || norm === qn) return 0;
    if (low.startsWith(q)) return 1;
    if (low.split(/[\s\-–(/]+/).some((w) => w.startsWith(q))) return 2;
    if (low.includes(q)) return 3;
    if (qn.length >= 3 && norm.includes(qn)) return 4;
    return Infinity;
  };
  // an entity answers to any of its names (aliases folded into it): its best one scores it
  const score = (n: FieldNode): number => Math.min(...[n.label, ...n.aliases].map(scoreName));
  return field.nodes.map((n) => [score(n), n] as const).filter(([s]) => s < Infinity)
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
  /** A source among them carries the entities its claims mention (lib/contextSources.ts). */
  contextNodes?: Array<{ id: string; path?: string; title?: string; group?: string; entities?: string[] }>;
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

/** A Desktop stands among what it concerns: the set of entities it has
 * read or been given, directly or through a source that mentions them (the
 * `entities` the engine serves on a source's context node). Each counts
 * once, however it came and however often; reading order makes no
 * difference. It stands at their average, in the nodes' own height band,
 * nudged off any dot it would cover. One with nothing placeable waits above
 * the middle; then they're pushed apart so none sits inside another. The
 * field never moves for them. */
export function placePilots(field: Field, sessions: readonly PilotSummary[]): FieldPilot[] {
  const byPath = new Map(field.nodes.map((n) => [n.path, n.i]));
  const out: FieldPilot[] = sessions.map((s, k) => {
    const sources = new Map<string, string[]>();
    for (const n of s.contextNodes ?? []) if (n.entities) for (const ref of [n.id, n.path]) if (ref) sources.set(ref, n.entities);
    const resolve = (ref: string): number[] => {
      const i = field.byId.get(ref) ?? byPath.get(ref);
      if (i != null) return [i];
      return (sources.get(ref) ?? []).map((id) => field.byId.get(id)).filter((x): x is number => x != null);
    };
    const refs = [...(s.context ?? []), ...(s.contextNodes ?? []).map((n) => n.path ?? n.id)];
    const ctx = [...new Set(refs.flatMap(resolve))].sort((a, b) => a - b);
    if (!ctx.length) return { id: s.id, title: s.title, model: s.model, phase: s.phase, ctx, p: [(k - (sessions.length - 1) / 2) * 3, 6.2, -1.2] };
    const x: [number, number, number] = [0, 0, 0];
    for (const i of ctx) for (let d = 0; d < 3; d++) x[d] += field.nodes[i]!.p[d]! / ctx.length;
    // just above the dots it concerns, then off any dot near enough to cover
    x[1] += 0.9;
    for (let pass = 0; pass < 6; pass++) for (const n of field.nodes) {
      const dx = x[0] - n.p[0], dz = x[2] - n.p[2], d = Math.hypot(dx, dz) || 0.01;
      if (d < 0.8 && Math.abs(x[1] - n.p[1]) < 1) { x[0] += dx / d * (0.8 - d); x[2] += dz / d * (0.8 - d); }
    }
    return { id: s.id, title: s.title, model: s.model, phase: s.phase, ctx, p: x };
  });
  for (let pass = 0; pass < 40; pass++) for (const a of out) for (const b of out) {
    if (a === b) continue;
    const dx = a.p[0] - b.p[0], dz = a.p[2] - b.p[2], d = Math.hypot(dx, dz) || 0.01;
    if (d < 2.4) { const push = (2.4 - d) / 2 / d; a.p[0] += dx * push; a.p[2] += dz * push; }
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
