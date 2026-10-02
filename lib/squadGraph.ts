/**
 * squadGraph.ts — who wrote the vault lately, and what they wrote.
 *
 * The squad view (web/ui SquadView) draws /api/graph's entities as a field;
 * this is its one extra read: the latest assertions as a feed, each with its
 * author. A pure function of the live assertion rows and the alias table, so
 * the route (web/server.ts) and a read-only dev preview feed it the same way.
 *
 * An author is named only from what the record says: a model or agent author
 * by its id, and the vault's own assertion passes (procedures named
 * *-assertion-agent) as the gardener, whatever model ran them. Nothing here
 * guesses at tasks or presents an author as a running agent.
 */

import type { AssertionEvent } from "./assertionLog";
import type { EntityAliasResolution } from "./entityAliasLog";

export interface SquadAuthor {
  id: string;
  name: string;
  /** Live assertions this author wrote. */
  count: number;
  lastAt: string;
}

export interface SquadFeedRow {
  id: string;
  at: string;
  /** SquadAuthor.id, or null for a user or the engine's own bookkeeping. */
  author: string | null;
  text: string;
  entities: string[];
}

export interface Squad {
  authors: SquadAuthor[];
  /** The latest assertions, oldest first. */
  feed: SquadFeedRow[];
}

const GARDENER = "gardener";
const NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", pi: "Pi", claude: "Claude", [GARDENER]: "Gardener" };
const FEED = 60;

export function authorOf(row: Pick<AssertionEvent, "author" | "produced_by">): string | null {
  if (row.author.kind !== "model" && row.author.kind !== "agent") return null;
  if (row.produced_by.procedure.endsWith("-assertion-agent")) return GARDENER;
  return row.author.id;
}

export function authorName(id: string): string {
  return NAMES[id] ?? id.split(/[-_]/).filter(Boolean).map((w, i) => (i ? w : w[0]!.toUpperCase() + w.slice(1))).join(" ");
}

/** `[[id|Label]]` and `[[Label]]` read as their labels: the feed is prose. */
export function plainText(text: string): string {
  return text.replace(/\[\[[^|\]]*\|([^\]]*)\]\]/g, "$1").replace(/\[\[([^\]]*)\]\]/g, "$1").replace(/\s+/g, " ").trim();
}

export function buildSquad(rows: readonly AssertionEvent[], aliases: EntityAliasResolution): Squad {
  const live = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const authors = new Map<string, SquadAuthor>();
  for (const row of live) {
    const id = authorOf(row);
    if (!id) continue;
    const a = authors.get(id) ?? { id, name: authorName(id), count: 0, lastAt: row.created_at };
    a.count++;
    a.lastAt = row.created_at;
    authors.set(id, a);
  }
  const feed = live.slice(-FEED).map((row) => ({
    id: row.id, at: row.created_at, author: authorOf(row), text: plainText(row.text),
    entities: [...new Set(row.entities.map((e) => aliases.canonical.get(e.id)?.id ?? e.id))],
  }));
  return { authors: [...authors.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt) || a.id.localeCompare(b.id)), feed };
}
