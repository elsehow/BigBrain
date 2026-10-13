/**
 * v2Feed.ts — who wrote the vault lately, and what they wrote.
 *
 * The v2 view (web/ui V2View) draws /api/graph's entities as a field;
 * this is its one extra read: the latest assertions as a feed, each with its
 * author, and the sorted feed the feed stage places sources in. The rows and
 * their order are queried from the projection (lib/views/v2Read.ts); this is what a
 * row says, and how the sorted feed pages.
 *
 * An author is named only from what the record says: a model or agent author
 * by its id, and the vault's own assertion passes (procedures named
 * *-assertion-agent) as the gardener, whatever model ran them. The gardener
 * that writes through its agent as a client is named the same way, its model
 * read from the journal of the run it wrote in (the projection's run_model).
 * Nothing here guesses at tasks or presents an author as a running agent.
 *
 * Pure, and safe for the browser bundle (the view imports plainText).
 */

import type { AssertionEvent } from "../assertionLog";

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

/** One live assertion as the projection keeps it: the event, when its claim
 * was first recorded, and the model of the gardener run that wrote it, when
 * one did (lib/assertionProjection.ts, schema 24). */
export interface V2Assertion {
  event: AssertionEvent;
  firstAt: string;
  runModel: string | null;
}

const GARDENER = "gardener";
const NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", pi: "Pi", claude: "Claude", [GARDENER]: "Gardener" };

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

/** A row as the feed shows it; `canonical` folds an entity id through the alias table. */
export function feedRow({ event: row, firstAt: at, runModel: ran }: V2Assertion, canonical: (id: string) => string): V2FeedRow {
  return {
    id: row.id, at, ...(at !== row.created_at ? { writtenAt: row.created_at } : {}),
    author: authorOf(row, !!ran), by: ran ?? row.author.id, model: !!ran || namesModel(row.author), text: plainText(row.text),
    entities: [...new Set(row.entities.map((e) => canonical(e.id)))],
  };
}

/** One source on the sorted feed (lib/stages/feed.ts), joined to the live record. */
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
  /** The source itself, as the projection names it (lib/v2Read.ts adds these):
   * its title, its note path, and the integration it came through. */
  title?: string;
  path?: string;
  via?: string;
  /** A lens event's lens (lib/lensSync.ts): the row is no source. A review
   * opens its lens; what a pass shared selects `entities`, what those notes' claims name. */
  lens?: string;
}

const SECTIONS: readonly V2SortedRow["section"][] = ["needs-you", "agent", "know"];

/** Rows to a page of the sorted feed: about three days of a steady feed,
 * dozens of screens of the viewer's strip (#207). */
export const SORTED_PAGE = 100;

type SortedKey = Pick<V2SortedRow, "added" | "section" | "source">;

/** The sorted feed's order: newest first, the most pressing first within
 * one arrival, then by source, so that every row has one place. */
export const newestFirst = (a: SortedKey, b: SortedKey): number =>
  b.added.localeCompare(a.added) || SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section) || a.source.localeCompare(b.source);

export interface SortedPage { rows: V2SortedRow[]; next: string | null }
/** A row's place in the sorted feed, as `before` and `next` name it. */
export const pageKey = (r: SortedKey): string => `${r.added}|${r.section}|${r.source}`;

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
  return { rows: page, next: last && from + page.length < rows.length ? pageKey(last) : null };
}

/** A page read elsewhere (lib/v2Read.ts readSortedPage) with `extra` rows
 * merged in where they fall: rows from outside the record, few enough to
 * hold, paged by the same keys. */
export function withRows(page: SortedPage, extra: readonly V2SortedRow[], limit: number, before?: string): SortedPage {
  if (!extra.length) return page;
  const after = pageSortedFeed([...extra].sort(newestFirst), extra.length, before).rows;
  const all = [...page.rows, ...after].sort(newestFirst), rows = all.slice(0, limit), last = rows.at(-1);
  return { rows, next: last && (page.next !== null || all.length > limit) ? pageKey(last) : null };
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
