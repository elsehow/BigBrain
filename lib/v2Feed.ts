/**
 * v2Feed.ts — who wrote the vault lately, and what they wrote.
 *
 * The v2 view (web/ui V2View) draws /api/graph's entities as a field;
 * this is its one extra read: the latest assertions as a feed, each with its
 * author. A pure function of the live assertion rows and the alias table, so
 * the route (web/server.ts) and a read-only dev preview feed it the same way.
 *
 * An author is named only from what the record says: a model or agent author
 * by its id, and the vault's own assertion passes (procedures named
 * *-assertion-agent) as the gardener, whatever model ran them. The gardener
 * that writes through its agent as a client is named the same way, its model
 * read from the journal of the run it wrote in (lib/v2Read.ts). Nothing here
 * guesses at tasks or presents an author as a running agent.
 *
 * Pure, and safe for the browser bundle (the view imports plainText): the
 * projection read lives in lib/v2Read.ts.
 */

import type { AssertionEvent } from "./assertionLog";
import type { EntityAliasResolution } from "./entityAliasLog";

export interface V2Author {
  id: string;
  name: string;
  /** Live assertions this author wrote. */
  count: number;
  lastAt: string;
}

export interface V2FeedRow {
  id: string;
  /** When the claim was first recorded. A rewrite (one assertion standing in
   * for another, `supersedes`) keeps its original's date, so a cleanup pass
   * doesn't re-date everything it touched. */
  at: string;
  /** Present when this row is a rewrite: when the standing version was written. */
  writtenAt?: string;
  /** V2Author.id, or null for a user or the engine's own bookkeeping. */
  author: string | null;
  /** Exactly who the record says wrote it: the model id when the record
   * names one (the vault's own passes, or the gardener's run journal), else
   * the client or user id. */
  by: string;
  /** Whether `by` is a model. Connected clients write over MCP under their
   * own name (lib/vaultTools.ts, invocation "mcp"): their model isn't recorded. */
  model: boolean;
  text: string;
  entities: string[];
}

export interface V2Feed {
  authors: V2Author[];
  /** The latest assertions, oldest first. */
  feed: V2FeedRow[];
}

/** What the v2 view reads, from one projection snapshot: the live rows, the
 * alias table, and each live row's first-recorded date. */
export interface V2Source {
  rows: AssertionEvent[];
  aliases: EntityAliasResolution;
  firstAt: ReadonlyMap<string, string>;
  /** The model behind each row the gardener wrote through its agent, by
   * assertion id: the record names only the agent, and the run's journal
   * names the model (lib/v2Read.ts gardenerModels). */
  models?: ReadonlyMap<string, string>;
}

export interface ChainLink { id: string; created_at: string; supersedes: string | null }
/** Follow each live row's `supersedes` back to the claim it stands in for,
 * and keep the earliest date on the way. */
export function firstRecordedAt(rows: readonly AssertionEvent[], chain: ReadonlyMap<string, ChainLink>): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows) {
    let at = row.created_at, next = row.supersedes ?? null;
    const seen = new Set([row.id]);
    while (next && !seen.has(next)) {
      seen.add(next);
      const prior = chain.get(next);
      if (!prior) break;
      if (prior.created_at < at) at = prior.created_at;
      next = prior.supersedes;
    }
    out.set(row.id, at);
  }
  return out;
}

const GARDENER = "gardener";
const NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", pi: "Pi", claude: "Claude", [GARDENER]: "Gardener" };
const FEED = 60;

/** `gardener`: the row is known, from a run journal, to be the gardener's. */
export function authorOf(row: Pick<AssertionEvent, "author" | "produced_by">, gardener = false): string | null {
  if (row.author.kind !== "model" && row.author.kind !== "agent") return null;
  if (gardener || row.produced_by.procedure.endsWith("-assertion-agent")) return GARDENER;
  return row.author.id;
}

export function authorName(id: string): string {
  return NAMES[id] ?? id.split(/[-_]/).filter(Boolean).map((w, i) => (i ? w : w[0]!.toUpperCase() + w.slice(1))).join(" ");
}

/** A model author names its model, except a connected client writing over MCP,
 * which records only its own name. */
export function namesModel(author: AssertionEvent["author"]): boolean {
  return author.kind === "model" && "invocation_id" in author && author.invocation_id !== "mcp";
}

/** `[[id|Label]]` and `[[Label]]` read as their labels: the feed is prose. */
export function plainText(text: string): string {
  return text.replace(/\[\[[^|\]]*\|([^\]]*)\]\]/g, "$1").replace(/\[\[([^\]]*)\]\]/g, "$1").replace(/\s+/g, " ").trim();
}

const canonical = (src: V2Source, id: string) => src.aliases.canonical.get(id)?.id ?? id;
const feedRow = (src: V2Source, row: AssertionEvent): V2FeedRow => {
  const at = src.firstAt.get(row.id) ?? row.created_at;
  const ran = src.models?.get(row.id);
  return {
    id: row.id, at, ...(at !== row.created_at ? { writtenAt: row.created_at } : {}),
    author: authorOf(row, !!ran), by: ran ?? row.author.id, model: !!ran || namesModel(row.author), text: plainText(row.text),
    entities: [...new Set(row.entities.map((e) => canonical(src, e.id)))],
  };
};
/** The entities named by claims that cite any of these notes (personal
 * source ids): a lens, as the field filters to it. */
export function entitiesCiting(src: V2Source, sourceIds: ReadonlySet<string>): string[] {
  return [...new Set(src.rows.filter((r) => r.sources?.some((s) => sourceIds.has(s.source_id))).flatMap((r) => r.entities.map((e) => canonical(src, e.id))))];
}
const byRecorded = (a: V2FeedRow, b: V2FeedRow) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id);

export function buildV2Feed(src: V2Source): V2Feed {
  const live = [...src.rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const authors = new Map<string, V2Author>();
  for (const row of live) {
    const id = authorOf(row, src.models?.has(row.id));
    if (!id) continue;
    const a = authors.get(id) ?? { id, name: authorName(id), count: 0, lastAt: row.created_at };
    a.count++;
    a.lastAt = row.created_at;
    authors.set(id, a);
  }
  // the latest by when each claim was first recorded, so a cleanup pass's
  // rewrites sit at their originals' dates instead of crowding the top
  const feed = live.map((row) => feedRow(src, row)).sort(byRecorded).slice(-FEED);
  return { authors: [...authors.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt) || a.id.localeCompare(b.id)), feed };
}

/** One source on the sorted feed (lib/feedStage.ts), joined to the live record. */
export interface V2SortedRow {
  source: string;
  section: "needs-you" | "agent" | "know";
  /** The stage's headline, written for the owner. */
  headline: string;
  /** The date something is due by (lib/feedJournal.ts dueOf), or null: a
   * meeting's own date is not a deadline. */
  due: string | null;
  /** When it entered the feed. */
  added: string;
  entities: string[];
  /** The source itself, as the projection names it (the route adds these):
   * its title, its note path, and the integration it came through. */
  title?: string;
  path?: string;
  via?: string;
  /** A lens event's lens (lib/lensSync.ts): the row is no source. A review
   * opens its lens; what a pass shared selects `entities`, what those notes' claims name. */
  lens?: string;
}

/** What the sorted feed is built from: the stage's items (lib/feedJournal.ts feedItems). */
export interface SortedEntry { source: string; section: string; headline: string; due: string | null; assertions: string[]; added: string }

const SECTIONS: readonly V2SortedRow["section"][] = ["needs-you", "agent", "know"];

/** Rows to a page of the sorted feed: about three days of a steady feed,
 * dozens of screens of the viewer's strip (#207). */
export const SORTED_PAGE = 100;

type SortedKey = Pick<V2SortedRow, "added" | "section" | "source">;

/** The sorted feed's order: newest first, the most pressing first within
 * one arrival, then by source, so that every row has one place. */
export const newestFirst = (a: SortedKey, b: SortedKey): number =>
  b.added.localeCompare(a.added) || SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section) || a.source.localeCompare(b.source);

/** The stage's items, newest first, as a feed reads: what just arrived is
 * what shows (the most pressing within one arrival first). An item whose
 * claims have all been revoked or superseded since it was sorted drops out:
 * the record no longer says it. */
export function buildSortedFeed(src: V2Source, entries: readonly SortedEntry[]): V2SortedRow[] {
  const live = new Map(src.rows.map((row) => [row.id, row]));
  const out: V2SortedRow[] = [];
  for (const e of entries) {
    const section = SECTIONS.find((s) => s === e.section);
    const rows = e.assertions.map((id) => live.get(id)).filter((r): r is AssertionEvent => !!r).map((r) => feedRow(src, r));
    if (!section || !rows.length) continue;
    out.push({ source: e.source, section, headline: e.headline, due: e.due, added: e.added, entities: [...new Set(rows.flatMap((r) => r.entities))] });
  }
  return out.sort(newestFirst);
}

export interface SortedPage { rows: V2SortedRow[]; next: string | null }

/** One page of the sorted feed: at most `limit` rows, newest first, after
 * the row `before` names (the `next` of the page before). `next` names the
 * page's last row while older rows remain. A row's key, not an offset, so
 * what arrives between two pages doesn't shift the second. */
export function pageSortedFeed(rows: readonly V2SortedRow[], limit: number, before?: string): SortedPage {
  let from = 0;
  if (before) {
    const [added = "", section = "", source = ""] = before.split("|");
    const cut = { added, section: section as V2SortedRow["section"], source };
    from = rows.findIndex((r) => newestFirst(cut, r) < 0);
    if (from < 0) from = rows.length;
  }
  const page = rows.slice(from, from + limit);
  const last = page.at(-1);
  return { rows: page, next: last && from + page.length < rows.length ? `${last.added}|${last.section}|${last.source}` : null };
}

/** The loaded pages, read again from the top (`fresh`: as many rows as were
 * loaded): a row revoked since drops out; rows that new arrivals pushed past
 * the fresh read's last stay below it, in order, and the page before them is
 * still the one to load next. */
export function refreshSortedPages(loaded: SortedPage, fresh: SortedPage): SortedPage {
  const last = fresh.rows.at(-1);
  const beyond = last ? loaded.rows.filter((r) => newestFirst(last, r) < 0) : [];
  return { rows: [...fresh.rows, ...beyond], next: beyond.length ? loaded.next : fresh.next };
}

/** One entity's latest assertions (aliases folded), dated the same way. */
export function buildEntityFeed(src: V2Source, entityId: string, limit = 6): V2FeedRow[] {
  const id = src.aliases.canonical.get(entityId)?.id ?? entityId;
  return src.rows.map((row) => feedRow(src, row)).filter((r) => r.entities.includes(id)).sort(byRecorded).slice(-limit);
}
