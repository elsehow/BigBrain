/**
 * v2Read.ts — the v2 view's reads of the projection (engine side;
 * lib/views/v2Feed.ts stays browser-safe so the viewer can share it). Each is a query its
 * indexes answer: the projection keeps what a feed row needs beside each
 * assertion (when its claim was first recorded, the model of the gardener
 * run that wrote it) and the sorted feed's items from the stage's journal
 * (schema 24), so a read decodes only the rows it returns and never opens a
 * journal. The author tally alone counts every live row. Each is a view
 * (lib/views/view.ts): the routes hand it a snapshot; the dev preview, a
 * vault's projection opened read-only (bin/v2Preview.ts).
 */
import type { Database } from "bun:sqlite";
import type { AssertionEvent } from "../assertionLog";
import { sourceHeadsIn } from "../assertionProjection";
import { FEED_SECTIONS } from "../feedJournal";
import { insertionEventRel } from "../insertionLog";
import { liveAssertionSql, liveSourceSql } from "../sourceSupersede";
import { sourcesNewestFirst, type EntitySource } from "./entitySources";
import type { Snapshot } from "./view";
import { authorName, feedRow, pageKey, type SortedPage, type V2Author, type V2Feed, type V2FeedRow, type V2SortedRow } from "./v2Feed";

const LIVE = `a.revoked_by IS NULL AND ${liveAssertionSql("a")}`;
/** The latest assertions the feed shows. */
const FEED = 60;

/** An entity id folded through the alias table: the entity it names. */
function folding(db: Database): (id: string) => string {
  const alias = db.query("SELECT entity_id FROM entity_aliases WHERE alias_id = ?");
  const folded = new Map<string, string>();
  return (id) => {
    let to = folded.get(id);
    if (to === undefined) folded.set(id, to = (alias.get(id) as { entity_id: string } | null)?.entity_id ?? id);
    return to;
  };
}

/** Assertions as feed rows, in the order given. A query picks ids on narrow
 * columns; only the rows it returns are decoded. */
function feedRows(db: Database, ids: readonly { id: string }[]): V2FeedRow[] {
  const row = db.query("SELECT first_at AS firstAt, run_model AS runModel, event_json FROM assertions WHERE id = ?");
  const canonical = folding(db);
  return ids.map(({ id }) => {
    const { firstAt, runModel, event_json } = row.get(id) as { firstAt: string; runModel: string | null; event_json: string };
    return feedRow({ event: JSON.parse(event_json) as AssertionEvent, firstAt, runModel }, canonical);
  });
}

/** Every author's live assertions, most recent first: authorOf, as a tally. */
function authors(db: Database): V2Author[] {
  const tally = db.query(`SELECT CASE WHEN a.run_model IS NOT NULL
      OR substr(json_extract(a.production_json, '$.procedure'), -16) = '-assertion-agent' THEN 'gardener' ELSE a.author_id END AS id,
      count(*) AS count, max(a.created_at) AS lastAt
    FROM assertions a WHERE a.author_kind IN ('model', 'agent') AND ${LIVE} GROUP BY 1`).all() as Omit<V2Author, "name">[];
  return tally.map(({ id, count, lastAt }) => ({ id, name: authorName(id), count, lastAt }))
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt) || a.id.localeCompare(b.id));
}

/** The authors, and the latest assertions by when each claim was first
 * recorded, oldest first: a cleanup pass's rewrites sit at their originals'
 * dates instead of crowding the top. */
export function readV2Feed({ db }: Snapshot): V2Feed {
  const latest = db.query(`SELECT a.id FROM assertions a WHERE ${LIVE}
    ORDER BY a.first_at DESC, a.id DESC LIMIT ?`).all(FEED) as { id: string }[];
  return { authors: authors(db), feed: feedRows(db, latest.reverse()) };
}

/** One entity's latest assertions, its aliases folded in, dated and ordered as the feed is. */
export function readEntityFeed({ db }: Snapshot, entityId: string, limit = 6): V2FeedRow[] {
  const id = folding(db)(entityId);
  const latest = db.query(`SELECT a.id FROM assertions a
    WHERE a.id IN (SELECT assertion_id FROM assertion_entities
      WHERE entity_id IN (SELECT ? UNION ALL SELECT alias_id FROM entity_aliases WHERE entity_id = ?)) AND ${LIVE}
    ORDER BY a.first_at DESC, a.id DESC LIMIT ?`).all(id, id, limit) as { id: string }[];
  return feedRows(db, latest.reverse());
}

/** Every distinct source cited by live claims about this entity (including
 * aliases). A lens supplies its allowed claims, so mixed-scope evidence never
 * leaks into its list. This is independent of the feed's six recent claims. */
export function readEntitySources({ db }: Snapshot, entityId: string, claims?: ReadonlySet<string>): EntitySource[] {
  const id = folding(db)(entityId);
  const ids = db.query(`SELECT DISTINCT s.insertion_id AS id FROM assertion_entities e
    JOIN assertions a ON a.id = e.assertion_id
    JOIN assertion_sources x ON x.assertion_id = a.id
    JOIN sources s ON s.insertion_id = x.insertion_id
    WHERE e.entity_id IN (SELECT ?1 UNION ALL SELECT alias_id FROM entity_aliases WHERE entity_id = ?1)
      AND ${LIVE} AND s.present = 1 AND ${liveSourceSql("s")}
      AND (?2 = 0 OR a.id IN (SELECT value FROM json_each(?3)))`)
    .all(id, claims ? 1 : 0, JSON.stringify([...(claims ?? [])])) as { id: string }[];
  return [...sourceHeadsIn(db, ids.map(r => r.id)).values()].map(s => ({
    id: s.id, path: insertionEventRel(s), title: s.title,
    added: s.received_at ?? s.occurred_at ?? "", ...(s.source ? { via: s.source } : {}),
  })).sort(sourcesNewestFirst);
}

/** The entities named by live claims citing any of these notes (personal
 * source ids), folded through the alias table: a lens, as the field filters
 * to it. */
export function readEntitiesCiting({ db }: Snapshot, sourceIds: Iterable<string>): string[] {
  const canonical = folding(db);
  const named = db.query(`SELECT DISTINCT e.entity_id AS id FROM assertion_entities e JOIN assertions a ON a.id = e.assertion_id
    WHERE ${LIVE} AND e.assertion_id IN (SELECT assertion_id FROM assertion_sources WHERE source_id IN (SELECT value FROM json_each(?)))`)
    .all(JSON.stringify([...sourceIds])) as { id: string }[];
  return [...new Set(named.map(({ id }) => canonical(id)))];
}

/** The claims a lens's notes alone support: live, citing at least one note,
 * every note they cite a member. All a briefing on the lens reads
 * (lib/noteBriefing.ts claimsOnly). */
export function readLensClaims({ db }: Snapshot, members: Iterable<string>): Set<string> {
  const ids = db.query(`SELECT a.id FROM assertions a WHERE ${LIVE}
    AND EXISTS (SELECT 1 FROM assertion_sources x WHERE x.assertion_id = a.id)
    AND NOT EXISTS (SELECT 1 FROM assertion_sources x WHERE x.assertion_id = a.id
      AND x.source_id NOT IN (SELECT value FROM json_each(?)))`).all(JSON.stringify([...members])) as { id: string }[];
  return new Set(ids.map(({ id }) => id));
}

/** One page of the sorted feed (lib/views/v2Feed.ts pageSortedFeed, as a query):
 * the stage's items newest first, after the row `before` names, each joined
 * to its live claims' entities and to its source. An item whose claims have
 * all been revoked or superseded since it was sorted drops out: the record
 * no longer says it. */
export function readSortedPage({ db }: Snapshot, limit: number, before?: string): SortedPage {
  const [added = "", section = "", source = ""] = before?.split("|") ?? [];
  const rank = (FEED_SECTIONS as readonly string[]).indexOf(section);
  const items = db.query(`SELECT f.source, f.section, f.headline, f.due, f.added FROM feed_items f
    WHERE f.rank >= 0 AND (?1 = 0 OR f.added < ?2 OR (f.added = ?2 AND (f.rank > ?3 OR (f.rank = ?3 AND f.source > ?4))))
      AND EXISTS (SELECT 1 FROM feed_item_assertions i JOIN assertions a ON a.id = i.assertion_id WHERE i.source = f.source AND ${LIVE})
    ORDER BY f.added DESC, f.rank, f.source LIMIT ?5`).all(before ? 1 : 0, added, rank, source, limit + 1) as Omit<V2SortedRow, "entities">[];
  const page = items.slice(0, limit);
  const claims = db.query(`SELECT a.id FROM feed_item_assertions i JOIN assertions a ON a.id = i.assertion_id
    WHERE i.source = ? AND ${LIVE} ORDER BY i.position`);
  const heads = sourceHeadsIn(db, page.map((r) => r.source));
  const rows = page.map((item): V2SortedRow => {
    const h = heads.get(item.source);
    return {
      ...item, entities: [...new Set(feedRows(db, claims.all(item.source) as { id: string }[]).flatMap((r) => r.entities))],
      ...(h ? { title: h.title, path: insertionEventRel(h), ...(h.source ? { via: h.source } : {}) } : {}),
    };
  });
  const last = rows.at(-1);
  return { rows, next: last && items.length > limit ? pageKey(last) : null };
}
