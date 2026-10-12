/** How the assertion kinds (lib/assertionLog.ts) reach readers while the logs
 * they replace are still read: docs/plans/2026-10-11-field-of-assertions.md,
 * step 1.
 *
 * A decline, a retraction or an identity assertion is written to the
 * assertion log. Each one also lands, in the shape its old log's events
 * have, in the projection table that log fills (lib/assertionProjection.ts).
 * So every fold over that table reads the old events and the new
 * assertions side by side: latest alias wins, latest binding per pair,
 * latest copy judgment per pair. The readers below fold the logs directly,
 * where no projection is at hand. All of this goes when the old logs are
 * migrated (step 3).
 */

import {
  isProse, readRecordedAssertions, type AssertionEntity, type DeclineAssertion, type IdentityAssertion, type RetractionAssertion,
} from "./assertionLog";
import type { DeclineEvent } from "./declineLog";
import { entityAliasResolution, readEntityAliasLog, type EntityAliasEvent } from "./entityAliasLog";
import type { EntityFoldRejectEvent } from "./entityFoldLog";
import type { EntitySourceEvent } from "./entitySourceLog";
import { readRevocationLog, type RevocationEvent } from "./revocationLog";
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
  const shapes: LegacyShape[] = [], withdrawn = new Set<string>();
  for (const event of readRecordedAssertions(root, opts)) {
    if (isProse(event)) continue;
    if (event.kind === "retraction") withdrawn.add(event.retracts);
    shapes.push(legacyShape(event));
  }
  return { shapes, withdrawn };
}

/** Every alias declaration still standing: the alias log's and the identity
 * assertions saying `same`, less what a retraction withdrew. */
export function aliasEvents(root: string, opts: { strict?: boolean } = {}): EntityAliasEvent[] {
  const { shapes, withdrawn } = recordedKinds(root, opts);
  const said = shapes.flatMap((s) => (s.kind === "alias" ? [s.event] : []));
  return [...readEntityAliasLog(root, opts), ...said].filter((event) => !withdrawn.has(event.id));
}

/** Every revocation: the revocation log's and the retractions. */
export function revocationEvents(root: string, opts: { strict?: boolean } = {}): RevocationEvent[] {
  const said = recordedKinds(root, opts).shapes.flatMap((s) => (s.kind === "revocation" ? [s.event] : []));
  return [...readRevocationLog(root, opts), ...said];
}

/** The read-side resolver over a vault's logs: an entity as an assertion
 * links it → the entity every reader should show. */
export function entityAliasResolver(root: string): (entity: AssertionEntity) => AssertionEntity {
  const { canonical } = entityAliasResolution(aliasEvents(root, { strict: true }));
  return (entity) => canonical.get(entity.id) ?? entity;
}
