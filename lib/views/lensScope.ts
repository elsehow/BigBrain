/** lensScope.ts — what a lens serves an agent that holds a credential bound
 * to it (docs/plans/2026-10-13-lenses-are-the-door.md §3, #303).
 *
 * Its members (lib/views/lens.ts), with two cuts:
 *
 *   - Additions nobody made are held. While the rule the lens is scored
 *     under is not the one its owner last saw (`calibration`) — a model
 *     upgrade, a change in the vault's entities, a BigBrain update — or a
 *     review holds it, a note is served only if that earlier rule had it in,
 *     or the owner's own word (a pin, a rating) does. A model's scoring
 *     decides what the agent reads, so a change to it waits for the owner.
 *   - Agents' words do not widen it. A note an agent dropped (agent voice,
 *     lib/voice.ts) is served only if the owner pinned or rated it in: what
 *     an agent writes through a lens never becomes what that lens serves on
 *     the model's say-so.
 *
 * An assertion is in only if every source it cites is in. Memory never is.
 */
import type { Snapshot } from "./view";
import { lensHandsOf, lensMembersOf, lensNotesOf } from "./lens";

export interface ReadScope {
  lens: string;
  /** Served notes, by source id. */
  sources: ReadonlySet<string>;
  /** Every landing of a served note. */
  insertions: ReadonlySet<string>;
  /** Assertions every cited source of which is served. */
  assertions: ReadonlySet<string>;
}

export interface ScopedLens {
  id: string;
  calibration: { identity: string; threshold: number };
  review?: { hold: boolean };
}

/** The notes a lens serves an agent, by source id. */
export function lensServedOf(snapshot: Snapshot, lens: ScopedLens): Set<string> {
  const notes = lensNotesOf(snapshot), members = lensMembersOf(snapshot, lens, notes), hands = lensHandsOf(snapshot, lens.id);
  const owned = new Set([...hands.pins, ...hands.ratings.filter((r) => r.include).map((r) => r.source_id)]);
  // A lens never scored before takes its first rule as the one its owner saw (lib/lensSync.ts reviewLens).
  const changed = !!lens.review?.hold || (!!members.rule && !!lens.calibration.identity && members.rule !== lens.calibration.identity);
  const seen = changed ? lensMembersOf(snapshot, lens, notes, lens.calibration.identity).in : members.in;
  const served = new Set([...members.in].filter((id) => owned.has(id) || seen.has(id)));
  const latest = new Map(notes.map((n) => [n.source_id as string, n.insertion_id as string]));
  const voice = snapshot.db.query("SELECT json_extract(event_json, '$.envelope.from_kind') AS k FROM source_documents WHERE insertion_id = ?");
  for (const id of served) {
    if (owned.has(id)) continue;
    const insertion = latest.get(id);
    if (insertion && (voice.get(insertion) as { k: unknown } | null)?.k === "agent") served.delete(id);
  }
  return served;
}

/** What every read through a lens-bound credential answers inside. */
export function lensScopeOf(snapshot: Snapshot, lens: ScopedLens): ReadScope {
  const sources = lensServedOf(snapshot, lens), { db } = snapshot;
  const insertions = new Set<string>();
  for (const row of db.query("SELECT insertion_id, source_id FROM sources").all() as { insertion_id: string; source_id: string }[])
    if (sources.has(row.source_id)) insertions.add(row.insertion_id);
  const cited = new Map<string, boolean>();
  for (const row of db.query("SELECT assertion_id, source_id FROM assertion_sources").all() as { assertion_id: string; source_id: string }[])
    cited.set(row.assertion_id, (cited.get(row.assertion_id) ?? true) && sources.has(row.source_id));
  const assertions = new Set([...cited].flatMap(([id, inside]) => (inside ? [id] : [])));
  return { lens: lens.id, sources, insertions, assertions };
}
