/** How the assertion kinds (lib/assertionLog.ts) reach the folds readers
 * apply: docs/plans/2026-10-11-field-of-assertions.md.
 *
 * A decline, a retraction or an identity assertion lands, in the shape the
 * retired log for its kind gave its events, in the projection table that
 * log filled (lib/assertionProjection.ts), and every fold over that table —
 * latest alias wins, latest binding per pair, latest copy judgment per
 * pair — reads it there. The readers below fold the assertion log directly,
 * where no projection is at hand.
 */

import {
  isProse, readRecordedAssertions, type AssertionEntity, type DeclineAssertion, type IdentityAssertion, type RetractionAssertion,
} from "./assertionLog";
import type { DeclineEvent } from "./declineLog";
import { entityAliasResolution, type EntityAliasEvent } from "./entityAliasLog";
import type { EntityFoldRejectEvent } from "./entityFoldLog";
import type { EntitySourceEvent } from "./entitySourceLog";
import { refuseRetiredLogs } from "./retiredLogs";
import type { RevocationEvent } from "./revocationLog";
import type { SourceCopyEvent } from "./sourceCopyLog";

/** An assertion as its old log would have recorded it, by the projection's
 * change kind for that log. */
export type LegacyShape =
  | { kind: "decline"; event: DeclineEvent }
  | { kind: "revocation"; event: RevocationEvent }
  | { kind: "alias"; event: EntityAliasEvent }
  | { kind: "entity_source"; event: EntitySourceEvent }
  | { kind: "copy"; event: SourceCopyEvent }
  | { kind: "fold_reject"; event: EntityFoldRejectEvent };

export function legacyShape(assertion: IdentityAssertion | DeclineAssertion | RetractionAssertion): LegacyShape {
  const { id, author, created_at, produced_by } = assertion;
  const said = { author, created_at, produced_by };
  if (assertion.kind === "decline")
    return { kind: "decline", event: { event: "work.declined", id, insertions: assertion.sources, reason: assertion.reason, ...said } };
  if (assertion.kind === "retraction")
    return { kind: "revocation", event: { event: "assertion.revoked", id, assertion_id: assertion.retracts,
      ...(assertion.superseded_by ? { superseded_by: assertion.superseded_by } : {}), reason: assertion.reason, ...said } };
  const { identity, sources } = assertion;
  switch (identity.says) {
    case "same":
      return { kind: "alias", event: { event: "entity.aliased", id, alias: identity.alias.label, alias_id: identity.alias.id,
        entity: identity.entity, ...said } };
    case "is-source":
      return { kind: "entity_source", event: { event: "entity.source-bound", id, entity: identity.entity,
        insertion_id: sources[0]!.insertion_id, bound: true, ...said } };
    case "distinct":
      return { kind: "fold_reject", event: { event: "entity.fold-rejected", id, pair: identity.entities, ...said } };
    case "copy":
    case "not-copy": {
      const pair: [string, string] = [sources[0]!.insertion_id, sources[1]!.insertion_id];
      return { kind: "copy", event: identity.says === "copy" && identity.score !== undefined
        ? { event: "source.copies-judged", id, pair, score: identity.score, ...said }
        : { event: "source.copies-declared", id, pair, same: identity.says === "copy", ...said } };
    }
  }
}

/** The assertion log's identity, decline and retraction events in their old
 * shapes, and what its retractions withdraw. */
function recordedKinds(root: string, opts: { strict?: boolean }): { shapes: LegacyShape[]; withdrawn: Set<string> } {
  // as the projection does: a retired log is refused, not read as empty
  refuseRetiredLogs(root);
  const shapes: LegacyShape[] = [], withdrawn = new Set<string>();
  for (const event of readRecordedAssertions(root, opts)) {
    if (isProse(event) || event.kind === "inclusion") continue; // inclusion has no old shape
    if (event.kind === "retraction") withdrawn.add(event.retracts);
    shapes.push(legacyShape(event));
  }
  return { shapes, withdrawn };
}

/** Every alias declaration still standing: the identity assertions saying
 * `same`, less what a retraction withdrew. */
export function aliasEvents(root: string, opts: { strict?: boolean } = {}): EntityAliasEvent[] {
  const { shapes, withdrawn } = recordedKinds(root, opts);
  return shapes.flatMap((s) => (s.kind === "alias" && !withdrawn.has(s.event.id) ? [s.event] : []));
}

/** Every retraction, as the revocation it replaced. */
export function revocationEvents(root: string, opts: { strict?: boolean } = {}): RevocationEvent[] {
  return recordedKinds(root, opts).shapes.flatMap((s) => (s.kind === "revocation" ? [s.event] : []));
}

/** The read-side resolver over a vault's logs: an entity as an assertion
 * links it → the entity every reader should show. */
export function entityAliasResolver(root: string): (entity: AssertionEntity) => AssertionEntity {
  const { canonical } = entityAliasResolution(aliasEvents(root, { strict: true }));
  return (entity) => canonical.get(entity.id) ?? entity;
}
