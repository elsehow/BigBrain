/** lens.ts — a lens's members as a view over its verdicts
 * (docs/plans/2026-10-12-stages-and-views-refactor.md, R5).
 *
 * A note's place in a lens is decided, in order, by the owner's word on it
 * (an exclusion, then a pin, then a rating; taking one back retracts it), and
 * otherwise by the latest score the lens's current rule gave its current
 * text. The current rule is the one its latest scoring pass ran under: a
 * rule changes when its text, its ratings, the entities it names or the
 * model does, and every note waits to be scored again. A note no verdict
 * decides is pending: neither in nor out. Nothing falls back to what the
 * lens held before, so the record alone says what is in it.
 */
import type { InclusionVerdict } from "../assertionLog";
import type { Snapshot } from "./view";

/** A note as a lens sees it: a source, by its latest landing. */
export interface LensNoteHead { source_id: string; insertion_id: string; title: string; date: string }

/** The notes lenses are over: each source's latest landing, oldest first. */
export function lensNotesOf({ db }: Snapshot): LensNoteHead[] {
  const latest = new Map<string, LensNoteHead>();
  for (const row of db.query(`SELECT source_id, insertion_id, title, coalesce(received_at, occurred_at, '') AS at FROM sources
      WHERE present = 1 ORDER BY coalesce(received_at, occurred_at, ''), insertion_id`).all() as
      { source_id: string; insertion_id: string; title: string; at: string }[]) {
    latest.delete(row.source_id); // a later landing moves the note to its own place
    latest.set(row.source_id, { source_id: row.source_id, insertion_id: row.insertion_id, title: row.title, date: row.at.slice(0, 10) });
  }
  return [...latest.values()];
}

/** The owner's word on a lens's notes: what is pinned, excluded, and rated. */
export interface LensHands {
  pins: string[];
  exclusions: string[];
  /** Ratings teach the evaluator: the landing rated, by source. */
  ratings: { source_id: string; insertion_id: string; include: boolean }[];
}

type Said = { source_id: string; insertion_id: string; include: number; how: "rating" | "pin" | "exclusion" };

export function lensHandsOf({ db }: Snapshot, lens: string): LensHands {
  const said = db.query(`SELECT source_id, insertion_id, include, how FROM inclusion_verdicts
    WHERE lens = ? AND include IS NOT NULL AND retracted_by IS NULL ORDER BY created_at, assertion_id, position`).all(lens) as Said[];
  const pins = new Set<string>(), exclusions = new Set<string>(), rated = new Map<string, Said>();
  for (const s of said) {
    if (s.how === "rating") { rated.delete(s.source_id); rated.set(s.source_id, s); }
    else (s.how === "pin" ? pins : exclusions).add(s.source_id);
  }
  const hands: LensHands = { pins: [...pins], exclusions: [...exclusions], ratings: [] };
  for (const [id, s] of rated) hands.ratings.push({ source_id: id, insertion_id: s.insertion_id, include: s.include === 1 });
  return hands;
}

export interface LensMembers {
  in: Set<string>;
  out: Set<string>;
  pending: Set<string>;
  /** Members judged on a summary of the note. */
  summarized: Set<string>;
  /** The rule the lens was last scored under. */
  rule?: string;
}

/** A lens's notes, each in, out or pending, by source id. */
export function lensMembersOf(snapshot: Snapshot, lens: { id: string; calibration: { threshold: number } }, notes = lensNotesOf(snapshot)): LensMembers {
  const { db } = snapshot, hands = lensHandsOf(snapshot, lens.id);
  const rule = (db.query(`SELECT rule FROM inclusion_verdicts WHERE lens = ? AND score IS NOT NULL AND retracted_by IS NULL
    ORDER BY created_at DESC, assertion_id DESC LIMIT 1`).get(lens.id) as { rule: string } | null)?.rule ?? undefined;
  const scores = new Map<string, { score: number; summary: boolean }>();
  if (rule) for (const row of db.query(`SELECT insertion_id, score, summary FROM inclusion_verdicts
      WHERE lens = ? AND rule = ? AND score IS NOT NULL AND retracted_by IS NULL ORDER BY created_at, assertion_id, position`)
      .all(lens.id, rule) as { insertion_id: string; score: number; summary: number }[])
    scores.set(row.insertion_id, { score: row.score, summary: row.summary === 1 });
  const pins = new Set(hands.pins), exclusions = new Set(hands.exclusions), ratings = new Map(hands.ratings.map((r) => [r.source_id, r.include]));
  const out: LensMembers = { in: new Set(), out: new Set(), pending: new Set(), summarized: new Set(), ...(rule ? { rule } : {}) };
  for (const note of notes) {
    const id = note.source_id, scored = scores.get(note.insertion_id);
    const inside = exclusions.has(id) ? false : pins.has(id) ? true : ratings.has(id) ? ratings.get(id)!
      : scored ? scored.score >= lens.calibration.threshold : undefined;
    if (inside === undefined) out.pending.add(id);
    else (inside ? out.in : out.out).add(id);
    if (inside && scored?.summary && !pins.has(id) && !ratings.has(id)) out.summarized.add(id);
  }
  return out;
}

/** The scores a lens's passes gave under `rule`: what the inclusion stage
 * has written (lib/stages/inclusion.ts settles by them). */
export function scoresUnderOf({ db }: Snapshot, lens: string, rule: string): InclusionVerdict[] {
  return (db.query(`SELECT insertion_id, source_id, input, score, summary FROM inclusion_verdicts
    WHERE lens = ? AND rule = ? AND score IS NOT NULL AND retracted_by IS NULL ORDER BY created_at, assertion_id, position`)
    .all(lens, rule) as { insertion_id: string; source_id: string; input: string; score: number; summary: number }[])
    .map(({ summary, ...row }) => ({ ...row, ...(summary ? { summary: true as const } : {}) }));
}
