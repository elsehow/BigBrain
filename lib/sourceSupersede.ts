/**
 * sourceSupersede.ts — the read side of "a source-side revision is a NEW
 * insertion (envelope `supersedes`)" (lib/references.ts). The lake keeps
 * both events; the readers show the successor.
 *
 * The rule, in one place: insertion B supersedes insertion A when B's
 * envelope names A in `supersedes` AND both carry the same `source_id` —
 * a later landing of the same object (a relabeled transcript, a re-clip of
 * a page). The second half is the guard: an arrival cannot hide a stranger
 * by naming it, only its own earlier self.
 *
 * What "hidden" means, per reader:
 *  - the feed, search and the graph skip a superseded insertion;
 *  - intake never files one (the successor is the due job);
 *  - an assertion is hidden when every projected source it cites is
 *    superseded — one citing the successor too, or a source the projection
 *    no longer holds, stays (the listing door's promise: gone ≠ hidden).
 * Nothing is revoked and no log gains a field: delete `.state/` and the
 * same view comes back.
 */

import type { SourceInsertion } from "./insertionLog";

type Enveloped = Pick<SourceInsertion, "envelope">;

/** The insertion id an event's envelope names as superseded, when it names
 * one in the shape an insertion id has. */
export function supersedesOf(event: Enveloped): string | undefined {
  const named = event.envelope["supersedes"];
  return typeof named === "string" && /^ins_[0-9a-f]{24}$/.test(named) ? named : undefined;
}

/** Every insertion id some LATER landing of the same source supersedes. */
export function supersededInsertionIds(events: Iterable<Pick<SourceInsertion, "id" | "source_id" | "envelope">>): Set<string> {
  const sourceOf = new Map<string, string>();
  const claims: [string, string][] = [];
  for (const event of events) {
    sourceOf.set(event.id, event.source_id);
    const named = supersedesOf(event);
    if (named) claims.push([named, event.source_id]);
  }
  const out = new Set<string>();
  for (const [named, sourceId] of claims) if (sourceOf.get(named) === sourceId) out.add(named);
  return out;
}

/** Is an assertion citing `insertionIds` hidden? Only when the record
 * holds at least one of them and holds no live one. */
export function assertionSuperseded(
  insertionIds: Iterable<string>,
  superseded: ReadonlySet<string>,
  held: (insertionId: string) => boolean
): boolean {
  let projected = false;
  for (const id of insertionIds) {
    if (!held(id)) continue;
    projected = true;
    if (!superseded.has(id)) return false;
  }
  return projected;
}

/** The same rule in SQL, over the projection's `sources.supersedes` column
 * (lib/assertionProjection.ts). `s` is the alias of the sources row asked
 * about. */
export const liveSourceSql = (s: string): string =>
  `NOT EXISTS (SELECT 1 FROM sources t WHERE t.present = 1 AND t.supersedes = ${s}.insertion_id AND t.source_id = ${s}.source_id)`;

/** `assertionSuperseded`, negated, in SQL; `a` is the assertions alias. */
export const liveAssertionSql = (a: string): string =>
  `(NOT EXISTS (SELECT 1 FROM assertion_sources x JOIN sources s ON s.insertion_id = x.insertion_id AND s.present = 1
      WHERE x.assertion_id = ${a}.id)
    OR EXISTS (SELECT 1 FROM assertion_sources x JOIN sources s ON s.insertion_id = x.insertion_id AND s.present = 1
      WHERE x.assertion_id = ${a}.id AND ${liveSourceSql("s")}))`;
