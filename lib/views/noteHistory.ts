/** noteHistory.ts — what touched a note, read from the record
 * (docs/plans/2026-10-12-stages-and-views-refactor.md, R6). It replaces a
 * merge of the note's frontmatter, `git log` and the retired editor's
 * journal trees: the record already says who did what to a source or an
 * entity, and when.
 *
 * - A source (a landing, or a thread of them): each landing of it; each
 *   claim citing it, and its retraction; each decline; each copy judgment
 *   or binding naming it.
 * - An entity: each live claim naming it, under any of its aliases; each alias
 *   and binding declared for it.
 * - Anything else (a memory topic, a note) has no history in the record.
 */
import type { Snapshot } from "./view";

export interface HistoryRow {
  at: number; // epoch ms
  actor: string;
  action: string;
}

/** The newest `limit` touches, newest first; undefined when the path names
 * nothing the record holds. */
export function noteHistoryOf({ db }: Snapshot, path: string, limit = 50): HistoryRow[] | undefined {
  const rows: { at: string; actor: string; action: string }[] = [];
  const add = (sql: string, ...params: string[]) => rows.push(...db.query(sql).all(...params) as typeof rows);
  const insertion = /(?:^|\/)(ins_[a-f0-9]{24})\.json$/u.exec(path)?.[1];
  const entity = /^projection\/entities\/(ent_[a-f0-9]{20})\.md$/u.exec(path)?.[1];
  const thread = /^projection\/threads\/(thread_[a-f0-9]{24})\.md$/u.exec(path)?.[1];
  let landings: string[] = [];
  if (insertion) {
    const source = db.query("SELECT source_id FROM sources WHERE insertion_id = ?").get(insertion) as { source_id: string } | null;
    if (!source) return undefined;
    landings = (db.query("SELECT insertion_id FROM sources WHERE source_id = ?").all(source.source_id) as { insertion_id: string }[]).map((r) => r.insertion_id);
  } else if (thread) {
    landings = (db.query(`SELECT insertion_id FROM read_thread_members
      WHERE thread_id = (SELECT thread_id FROM read_thread_paths WHERE path = ?)`).all(path) as { insertion_id: string }[]).map((r) => r.insertion_id);
    if (!landings.length) return undefined;
  } else if (entity) {
    if (!db.query("SELECT 1 FROM entities WHERE id = ? UNION SELECT 1 FROM entity_aliases WHERE entity_id = ? OR alias_id = ?").get(entity, entity, entity)) return undefined;
    const ids = `(SELECT ?1 UNION SELECT alias_id FROM entity_aliases WHERE entity_id = ?1)`;
    // the live claims naming it: a retracted claim leaves its entity edges
    add(`SELECT a.created_at AS at, a.author_id AS actor, 'asserted' AS action FROM assertions a
      WHERE a.id IN (SELECT assertion_id FROM assertion_entities WHERE entity_id IN ${ids})`, entity);
    add(`SELECT created_at AS at, author_id AS actor,
        CASE WHEN retracted_by IS NULL THEN 'named ' || alias_label ELSE 'withdrew the name ' || alias_label END AS action
      FROM identities WHERE says = 'same' AND (entity_id = ?1 OR alias_id = ?1)`, entity);
    add(`SELECT created_at AS at, author_id AS actor, 'bound to a source' AS action
      FROM identities WHERE says = 'is-source' AND entity_id = ?`, entity);
  } else return undefined;
  for (const id of landings) {
    add(`SELECT coalesce(received_at, occurred_at, '') AS at,
        coalesce(json_extract(header_json, '$.author.id'), '') AS actor, 'landed' AS action FROM sources WHERE insertion_id = ?`, id);
    add(`SELECT a.created_at AS at, a.author_id AS actor, 'asserted' AS action FROM assertions a
      JOIN assertion_sources x ON x.assertion_id = a.id WHERE x.insertion_id = ?`, id);
    add(`SELECT r.created_at AS at, r.author_id AS actor,
        CASE WHEN r.superseded_by IS NULL THEN 'retracted a claim' ELSE 'rewrote a claim' END AS action
      FROM retractions r JOIN assertion_sources x ON x.assertion_id = r.retracts WHERE x.insertion_id = ?`, id);
    add(`SELECT created_at AS at, author_id AS actor,
        CASE WHEN retracted_by IS NULL THEN 'declined' ELSE 'declined, then took it back' END AS action
      FROM declines WHERE insertion_id = ?`, id);
    add(`SELECT created_at AS at, author_id AS actor,
        CASE WHEN score IS NOT NULL THEN 'judged a copy' WHEN says = 'copy' THEN 'said is a copy' ELSE 'said is not a copy' END AS action
      FROM identities WHERE says IN ('copy', 'not-copy') AND (a = ?1 OR b = ?1)`, id);
  }
  const seen = new Set<string>();
  return rows.map((r) => ({ at: Date.parse(r.at) || 0, actor: r.actor || "unknown", action: r.action }))
    .filter((r) => { const key = `${r.at} ${r.actor} ${r.action}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => b.at - a.at || a.action.localeCompare(b.action)).slice(0, limit);
}
