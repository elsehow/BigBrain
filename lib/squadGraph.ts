/**
 * squadGraph.ts — who is writing the vault right now, and what they wrote.
 *
 * The squad view (web/ui SquadView) draws /api/graph's entities as a field
 * and puts the agents IN it: each one sits over the things it has been
 * writing about, and a feed under the graph reads the record as it lands.
 * This module is that view's one read: a pure function of the live
 * assertion rows and the alias table, so the route (web/server.ts) and a
 * read-only dev preview feed it the same way.
 *
 * An "agent" is an author that is a model or an agent — never a user, never
 * the engine's own bookkeeping (system). The vault's own assertion passes
 * (procedures named *-assertion-agent) are one agent, the gardener, whatever
 * model ran them. Assertions carry no task title, so an agent's task is
 * READ OFF its recent work: the entity it has written about most lately,
 * leaving out the hubs every agent touches (the owner first among them).
 */

import type { AssertionEvent } from "./assertionLog";
import type { EntityAliasResolution } from "./entityAliasLog";

export interface SquadAgent {
  id: string;
  name: string;
  /** Live assertions this agent wrote. */
  count: number;
  lastAt: string;
  /** The entity its recent work centres on, or null when it has none. */
  task: { id: string; label: string } | null;
  /** Up to three entities it has been writing about lately, most first. */
  touch: string[];
  /** Its latest word on each touched entity (plain text). */
  say: Record<string, string>;
}

export interface SquadFeedRow {
  id: string;
  at: string;
  /** SquadAgent.id, or null for an author that is not an agent. */
  agent: string | null;
  text: string;
  entities: string[];
}

export interface Squad {
  agents: SquadAgent[];
  /** Oldest first: the latest assertions overall, plus each agent's own latest. */
  feed: SquadFeedRow[];
}

const GARDENER = "gardener";
const NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", pi: "Pi", claude: "Claude", [GARDENER]: "Gardener" };
const RECENT = 60;
const FEED_ALL = 40;
const FEED_EACH = 24;
const MAX_AGENTS = 6;
/** An entity in more than this share of all assertions is a hub, not a task. */
const HUB_SHARE = 0.05;

export function agentOf(row: Pick<AssertionEvent, "author" | "produced_by">): string | null {
  if (row.author.kind !== "model" && row.author.kind !== "agent") return null;
  if (row.produced_by.procedure.endsWith("-assertion-agent")) return GARDENER;
  return row.author.id;
}

export function agentName(id: string): string {
  return NAMES[id] ?? id.split(/[-_]/).filter(Boolean).map((w, i) => (i ? w : w[0]!.toUpperCase() + w.slice(1))).join(" ");
}

/** `[[id|Label]]` and `[[Label]]` read as their labels: the feed is prose. */
export function plainText(text: string): string {
  return text.replace(/\[\[[^|\]]*\|([^\]]*)\]\]/g, "$1").replace(/\[\[([^\]]*)\]\]/g, "$1").replace(/\s+/g, " ").trim();
}

export function buildSquad(rows: readonly AssertionEvent[], aliases: EntityAliasResolution): Squad {
  const resolve = (id: string, label: string) => aliases.canonical.get(id) ?? { id, label };
  const live = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const labels = new Map<string, string>();
  const mentions = new Map<string, number>();
  const entitiesOf = (row: AssertionEvent): string[] => {
    const ids = new Map<string, string>();
    for (const e of row.entities) { const c = resolve(e.id, e.label); ids.set(c.id, c.label); }
    for (const [id, label] of ids) labels.set(id, label);
    return [...ids.keys()];
  };
  const resolved = live.map((row) => ({ row, agent: agentOf(row), entities: entitiesOf(row) }));
  for (const r of resolved) for (const id of r.entities) mentions.set(id, (mentions.get(id) ?? 0) + 1);
  const hub = (id: string) => (mentions.get(id) ?? 0) > Math.max(20, live.length * HUB_SHARE);

  const byAgent = new Map<string, typeof resolved>();
  for (const r of resolved) if (r.agent) {
    const list = byAgent.get(r.agent) ?? [];
    list.push(r);
    byAgent.set(r.agent, list);
  }
  const agents: SquadAgent[] = [...byAgent].map(([id, mine]) => {
    const recent = mine.slice(-RECENT);
    const tally = new Map<string, number>();
    for (const r of recent) for (const e of r.entities) if (!hub(e)) tally.set(e, (tally.get(e) ?? 0) + 1);
    const touch = [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([e]) => e);
    const say: Record<string, string> = {};
    for (const e of touch) {
      const last = [...recent].reverse().find((r) => r.entities.includes(e));
      if (last) say[e] = plainText(last.row.text);
    }
    return {
      id, name: agentName(id), count: mine.length, lastAt: mine.at(-1)!.row.created_at,
      task: touch[0] ? { id: touch[0], label: labels.get(touch[0])! } : null, touch, say,
    };
  }).sort((a, b) => b.lastAt.localeCompare(a.lastAt) || a.id.localeCompare(b.id)).slice(0, MAX_AGENTS);

  const shown = new Set(agents.map((a) => a.id));
  const keep = new Set(resolved.slice(-FEED_ALL));
  for (const id of shown) for (const r of (byAgent.get(id) ?? []).slice(-FEED_EACH)) keep.add(r);
  const feed = resolved.filter((r) => keep.has(r)).map((r) => ({
    id: r.row.id, at: r.row.created_at, agent: r.agent && shown.has(r.agent) ? r.agent : null,
    text: plainText(r.row.text), entities: r.entities,
  }));
  return { agents, feed };
}
