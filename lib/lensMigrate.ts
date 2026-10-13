/** Migration 5: lenses into the vault (docs/plans/2026-10-11-field-of-assertions.md,
 * Migrations; decided in docs/plans/2026-10-12-stages-and-views-refactor.md).
 *
 * A lens used to be one file beside this computer's connection settings,
 * holding its rule, the owner's ratings, pins and exclusions, and the
 * members its last pass applied. Each becomes:
 *
 * - `lenses/<id>.json` in the vault: its name, rule, cut-off, the servers it
 *   is shared with, and any open review;
 * - an inclusion assertion by the owner for each rating, pin and exclusion,
 *   citing the note, at the time the lens was last changed;
 * - one inclusion assertion of scores per lens, from the scores already paid
 *   for (the score cache): no model is asked. A note with none is pending
 *   until the lens's next pass scores it, and a pending note is neither
 *   added to a server nor withdrawn from one.
 *
 * The reading is checked against the old one: every member the old file
 * held is in the new view, or pending. One that would now be out is reported
 * before anything is written, so `--yes` is said knowing it. The change is
 * one commit; the old files are kept in `.state/lens-migration/` and then
 * leave the settings directory. Runs only on the owner's `--yes`
 * (docs/design-principles.md §5).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { commitPathsOnly, gitOut } from "./git";
import { EVALUATOR_VERSION, inclusionEvaluator } from "./inclusionEvaluation";
import type { InclusionLabel } from "./inclusionPolicy";
import { legacyLensDir, writeLens, type Lens } from "./lenses";
import { landScores, sayOnLens } from "./lensRecord";
import { noteClaims } from "./sharedRuleMentions";
import { lensNotes, verdictInput } from "./stages/inclusion";
import type { InclusionVerdict } from "./assertionLog";

/** A lens as it was kept before it moved into the vault. */
export interface LegacyLens extends Omit<Lens, "review"> {
  labels: InclusionLabel[];
  pins: string[];
  exclusions: string[];
  members: string[];
  summarized?: string[];
  review?: { reason: "model" | "vault" | "update"; hold: boolean; at: string; joins?: string[]; leaves?: string[] };
  error?: string;
}

export interface LensPlan {
  lens: LegacyLens;
  ratings: number;
  pins: number;
  exclusions: number;
  /** Notes with a score already paid for, under the rule as it stands. */
  scored: number;
  /** Old members by what the new view will say of them. */
  kept: number;
  pending: number;
  out: string[];
  /** Hand edits naming a note the vault no longer holds: they say nothing. */
  dropped: number;
}

export const legacyLenses = (root: string, store: string): LegacyLens[] => {
  const dir = legacyLensDir(root, store);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^lens_[a-f0-9]{12}\.json$/u.test(f)).sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as LegacyLens);
};

/** What each lens would become, and how its members would read. Writes nothing. */
export function planLensMigration(root: string, store: string): LensPlan[] {
  const notes = lensNotes(root), claims = noteClaims(root);
  const held = new Map(notes.map((n) => [n.source_id, n]));
  const insertions = new Set(notes.map((n) => n.insertion.id));
  return legacyLenses(root, store).map((lens) => {
    const scores = cachedScores(root, store, lens, notes, claims);
    const ratings = new Map(lens.labels.flatMap((l) => {
      const note = notes.find((n) => n.insertion.id === l.source.id);
      return note ? [[note.source_id, l.include] as const] : [];
    }));
    const exclusions = new Set(lens.exclusions.filter((id) => held.has(id)));
    const pins = new Set(lens.pins.filter((id) => held.has(id) && !exclusions.has(id)));
    const verdict = (id: string): boolean | undefined => {
      if (exclusions.has(id)) return false;
      if (pins.has(id)) return true;
      if (ratings.has(id)) return ratings.get(id);
      const s = scores.get(id);
      return s === undefined ? undefined : s.score >= lens.calibration.threshold;
    };
    const plan: LensPlan = { lens, ratings: ratings.size, pins: pins.size, exclusions: exclusions.size, scored: scores.size,
      kept: 0, pending: 0, out: [],
      dropped: lens.pins.length + lens.exclusions.length - pins.size - exclusions.size + lens.labels.filter((l) => !insertions.has(l.source.id)).length };
    for (const id of lens.members) {
      if (!held.has(id)) continue;
      const v = verdict(id);
      if (v === undefined) plan.pending++; else if (v) plan.kept++; else plan.out.push(id);
    }
    return plan;
  });
}

/** Each note's score under the lens's rule as it stands, from the cache. */
function cachedScores(root: string, store: string, lens: LegacyLens, notes: ReturnType<typeof lensNotes>, claims: ReturnType<typeof noteClaims>) {
  const evaluator = inclusionEvaluator(root, store, lens.text, lens.labels);
  const out = new Map<string, { score: number; verdict: InclusionVerdict; identity: string; model: string }>();
  for (const n of notes) {
    const score = evaluator.peek({ id: n.insertion.id, title: n.title, body: n.body }, n.digest);
    if (score === undefined) continue;
    out.set(n.source_id, { score, identity: evaluator.identity, model: evaluator.model, verdict: {
      insertion_id: n.insertion.id, source_id: n.source_id, input: verdictInput(n.digest, claims.get(n.insertion.id)), score,
      ...(lens.summarized?.includes(n.source_id) ? { summary: true as const } : {}) } });
  }
  return out;
}

export interface LensMigrationResult { lenses: number; assertions: number; committed: boolean }

/** Move every lens in, as one commit, and set the old files aside. */
export function migrateLenses(root: string, store: string, plans: LensPlan[] = planLensMigration(root, store)): LensMigrationResult {
  const paths: string[] = [], notes = lensNotes(root), claims = noteClaims(root);
  let assertions = 0;
  for (const { lens: old } of plans) {
    const at = old.updated, w = { commit: false, at, procedure: "lens-migrate" };
    const lens: Lens = { id: old.id, name: old.name, text: old.text, servers: old.servers, version: old.version, created: old.created, updated: old.updated,
      calibration: { ...old.calibration, version: old.calibration.version ?? EVALUATOR_VERSION },
      ...(old.review ? { review: { reason: old.review.reason, hold: old.review.hold, at: old.review.at } } : {}) };
    paths.push(writeLens(root, lens, false));
    const said = sayOnLens(root, lens, { pins: old.pins, exclusions: old.exclusions,
      ratings: old.labels.map((l) => ({ insertion_id: l.source.id, include: l.include })) }, w);
    const scores = [...cachedScores(root, store, old, notes, claims).values()];
    const landed = scores.length ? landScores(root, lens, scores[0]!.identity, scores[0]!.model, scores.map((s) => s.verdict), w) : [];
    paths.push(...said, ...landed);
    assertions += said.length + landed.length;
  }
  let committed = false;
  if (paths.length && gitOut(root, ["rev-parse", "--git-dir"]))
    committed = commitPathsOnly(root, "migrate", `migrate: ${plans.length} lens(es) into the vault, ${assertions} inclusion assertion(s)`, paths);
  const kept = join(root, ".state", "lens-migration");
  mkdirSync(kept, { recursive: true });
  // Settings and vault may sit on different disks: copy, then let the old go.
  for (const { lens } of plans) {
    const from = join(legacyLensDir(root, store), `${lens.id}.json`);
    copyFileSync(from, join(kept, `${lens.id}.json`));
    rmSync(from);
  }
  return { lenses: plans.length, assertions, committed };
}
