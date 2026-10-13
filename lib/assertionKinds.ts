/** What the folds read of the assertion kinds besides prose and inclusion
 * (lib/assertionLog.ts; docs/plans/2026-10-12-stages-and-views-refactor.md,
 * R11).
 *
 * Each kind has its own projection table, whose columns are the assertion's
 * own fields (lib/assertionProjection.ts: `identities`, `declines`,
 * `retractions`), and the folds — latest alias wins, latest binding per
 * pair, latest copy word per pair — read the rows below, whether from those
 * tables or, where no projection is at hand, from the assertion log itself.
 * Nothing is read in a retired log's shape.
 */

import {
  isProse, readRecordedAssertions, type AssertionEntity, type IdentityAssertion, type RecordedAssertion, type RetractionAssertion,
} from "./assertionLog";
import { entityAliasResolution, type AliasDeclaration } from "./entityAliasLog";
import type { AssertionId, InsertionId } from "./ids";
import { refuseRetired } from "./retiredLogs";
import type { CopySaid } from "./sourceCopies";

/** A retraction: the assertion it withdraws, and the one standing in its place. */
export interface Retraction {
  id: AssertionId;
  retracts: AssertionId;
  superseded_by?: AssertionId;
  reason: string;
  created_at: string;
}

/** An is-source identity: an entity that is this landing. */
export interface Binding {
  id: AssertionId;
  entity: AssertionEntity;
  insertion_id: InsertionId;
  created_at: string;
}

export const retractionOf = (a: RetractionAssertion): Retraction => ({
  id: a.id, retracts: a.retracts, ...(a.superseded_by ? { superseded_by: a.superseded_by } : {}), reason: a.reason, created_at: a.created_at,
});

/** A `same` identity as the alias fold reads it; undefined for any other. */
export function aliasOf(a: IdentityAssertion): AliasDeclaration | undefined {
  const { identity } = a;
  return identity.says === "same"
    ? { id: a.id, alias: identity.alias.label, alias_id: identity.alias.id, entity: identity.entity, created_at: a.created_at }
    : undefined;
}

/** A copy or not-copy identity as the copy fold reads it: a score is a
 * model's judgment, its absence a person's word. */
export function copySaidOf(a: IdentityAssertion): CopySaid | undefined {
  const { identity, sources } = a;
  if (identity.says !== "copy" && identity.says !== "not-copy") return undefined;
  const pair: [string, string] = [sources[0]!.insertion_id, sources[1]!.insertion_id];
  return identity.says === "copy" && identity.score !== undefined
    ? { id: a.id, pair, created_at: a.created_at, score: identity.score, model: a.author.id }
    : { id: a.id, pair, created_at: a.created_at, same: identity.says === "copy" };
}

/** The assertion log's kinds, and what its retractions withdraw. */
function recordedKinds(root: string, opts: { strict?: boolean }): { kinds: RecordedAssertion[]; withdrawn: Set<string> } {
  // as the projection does: a retired log is refused, not read as empty
  refuseRetired(root);
  const kinds: RecordedAssertion[] = [], withdrawn = new Set<string>();
  for (const event of readRecordedAssertions(root, opts)) {
    if (isProse(event)) continue;
    if (event.kind === "retraction") withdrawn.add(event.retracts);
    kinds.push(event);
  }
  return { kinds, withdrawn };
}

/** Every alias declaration still standing, from the log: the identity
 * assertions saying `same`, less what a retraction withdrew. */
export function standingAliases(root: string, opts: { strict?: boolean } = {}): AliasDeclaration[] {
  const { kinds, withdrawn } = recordedKinds(root, opts);
  return kinds.flatMap((e) => {
    const alias = e.kind === "identity" && !withdrawn.has(e.id) ? aliasOf(e) : undefined;
    return alias ? [alias] : [];
  });
}

/** Every retraction in the log. */
export function retractionsIn(root: string, opts: { strict?: boolean } = {}): Retraction[] {
  return recordedKinds(root, opts).kinds.flatMap((e) => (e.kind === "retraction" ? [retractionOf(e)] : []));
}

/** The read-side resolver over a vault's logs: an entity as an assertion
 * links it → the entity every reader should show. */
export function entityAliasResolver(root: string): (entity: AssertionEntity) => AssertionEntity {
  const { canonical } = entityAliasResolution(standingAliases(root, { strict: true }));
  return (entity) => canonical.get(entity.id) ?? entity;
}
