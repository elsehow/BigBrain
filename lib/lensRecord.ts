/**
 * lensRecord.ts — a lens's verdicts, written and read (R5,
 * docs/plans/2026-10-12-stages-and-views-refactor.md).
 *
 * The owner's word on a note is one inclusion assertion: a pin, an
 * exclusion or a rating, each its own so taking it back retracts it alone.
 * A scoring pass is one inclusion assertion of every verdict it reached. What
 * is in a lens is read back through the lens views (lib/views/lens.ts).
 */
import { randomUUID } from "node:crypto";
import {
  commitAssertionEvents, createInclusionAssertion, createRetraction, type InclusionVerdict, type RecordedAssertion,
} from "./assertionLog";
import { appendAndProjectAssertion } from "./assertionProjection";
import type { EventAuthor } from "./insertionLog";
import type { InclusionLabel } from "./inclusionPolicy";
import type { Lens } from "./lenses";
import { projectedSource, withSnapshot } from "./vaultReadModel";
import { lensHandsOf, lensMembersOf, lensNotesOf, type LensHands, type LensMembers, type LensNoteHead } from "./views/lens";

const OWNER: EventAuthor = { kind: "user", id: "owner" };
/** How a write lands: committed now (the default), or left for the caller's one commit. */
export interface LensWrite { commit?: boolean; at?: string; procedure?: string }
const said = (fallback: string, w: LensWrite) =>
  ({ produced_by: { procedure: w.procedure ?? fallback, version: "1" }, created_at: w.at ?? new Date().toISOString() });

/** A lens as the passes and the screens read it: the owner's word, and what is in it. */
export interface LensReading { hands: LensHands; members: LensMembers; notes: LensNoteHead[] }
export function readLensState(root: string, lens: Pick<Lens, "id" | "calibration">): LensReading {
  return withSnapshot(root, (snapshot) => {
    const notes = lensNotesOf(snapshot);
    return { notes, hands: lensHandsOf(snapshot, lens.id), members: lensMembersOf(snapshot, lens, notes) };
  });
}

/** The owner's ratings as the evaluator is taught them: each rated landing's text. */
export function labelsOf(root: string, ratings: LensHands["ratings"]): InclusionLabel[] {
  return ratings.flatMap((r) => {
    const source = projectedSource(root, r.insertion_id);
    if (!source) return [];
    const origin = ["Personal", (source.received_at ?? "").slice(0, 10)].filter(Boolean).join(" · ");
    return [{ source: { id: source.id, title: source.title, body: source.body, origin }, include: r.include }];
  });
}

/** Append and project, and commit unless the caller will; the paths written. */
function land(root: string, events: RecordedAssertion[], summary: string, w: LensWrite): string[] {
  if (!events.length) return [];
  const paths = events.map((event) => appendAndProjectAssertion(root, event).path);
  if (w.commit !== false) commitAssertionEvents(root, paths, summary);
  return paths;
}

/** The live assertions in which the owner said `how` of a note in a lens. */
function standing(root: string, lens: string, sourceId: string, how: string): string[] {
  return withSnapshot(root, ({ db }) => (db.query(`SELECT DISTINCT assertion_id FROM inclusion_verdicts
    WHERE lens = ? AND source_id = ? AND how = ? AND retracted_by IS NULL ORDER BY assertion_id`).all(lens, sourceId, how) as { assertion_id: string }[])
    .map((row) => row.assertion_id));
}

/** Bring the owner's word on a lens to `want`: say what is new, retract what
 * was taken back. Ratings name the landing rated; pins and exclusions the
 * note, by its latest landing. */
export function sayOnLens(root: string, lens: Pick<Lens, "id" | "name">,
  want: { pins: readonly string[]; exclusions: readonly string[]; ratings: readonly { insertion_id: string; include: boolean }[] },
  w: LensWrite = {}): string[] {
  const { hands, notes } = readLensState(root, { id: lens.id, calibration: { identity: "", model: "", threshold: 1 } });
  const latest = new Map<string, (typeof notes)[number]>(notes.map((n) => [n.source_id, n]));
  const events: RecordedAssertion[] = [];
  const word = (verdict: InclusionVerdict) =>
    events.push(createInclusionAssertion({ lens: lens.id, verdicts: [verdict], author: OWNER, ...said("lens-edit", w) }));
  const takeBack = (sourceId: string, how: string) => {
    for (const id of standing(root, lens.id, sourceId, how))
      events.push(createRetraction({ retracts: id, reason: `taken off the lens's ${how}s`, author: OWNER, ...said("lens-edit", w) }));
  };
  const place = (how: "pin" | "exclusion", had: readonly string[], now: readonly string[]) => {
    for (const id of had) if (!now.includes(id)) takeBack(id, how);
    for (const id of now) {
      const note = latest.get(id);
      if (note && !had.includes(id)) word({ insertion_id: note.insertion_id, source_id: note.source_id, include: how === "pin", how });
    }
  };
  place("pin", hands.pins, want.pins);
  place("exclusion", hands.exclusions, want.exclusions);
  const rated = new Map<string, (typeof hands.ratings)[number]>(hands.ratings.map((r) => [r.insertion_id, r]));
  const wanted = new Map(want.ratings.map((r) => [r.insertion_id, r]));
  for (const r of hands.ratings) if (wanted.get(r.insertion_id)?.include !== r.include) takeBack(r.source_id, "rating");
  for (const r of want.ratings) {
    if (rated.get(r.insertion_id)?.include === r.include) continue;
    const source = projectedSource(root, r.insertion_id);
    if (source) word({ insertion_id: source.id, source_id: source.source_id, include: r.include, how: "rating" });
  }
  return land(root, events, `lens: ${lens.name} — the owner's word on ${events.length} note(s)`, w);
}

/** A scoring pass's verdicts, as one assertion by the model that made them.
 * `model` is the evaluator's identity (lib/inclusionEvaluation.ts). */
export function landScores(root: string, lens: Pick<Lens, "id" | "name">, rule: string, model: string, verdicts: InclusionVerdict[],
  w: LensWrite = {}): string[] {
  if (!verdicts.length) return [];
  let id = model;
  try { const parsed = JSON.parse(model) as { model?: unknown }; if (typeof parsed.model === "string") id = parsed.model; } catch { /* a plain name */ }
  return land(root, [createInclusionAssertion({ lens: lens.id, rule, verdicts,
    author: { kind: "model", id, invocation_id: randomUUID() }, ...said("lens-scoring", w) })],
  `lens: ${lens.name} — ${verdicts.length} note(s) scored`, w);
}
