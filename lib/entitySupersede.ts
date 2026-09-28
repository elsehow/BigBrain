/** Supersede: correct past assertions per assertion, the right way (#629).
 *
 * A first-name stub ("Ezra", 6 assertions) holds claims whose entity link
 * is under-specified; the ideal record has each of them linked to the full,
 * unambiguous name. A label-level alias can't say that without also
 * claiming the label for the future; a read-time relink is a second
 * resolver every reader must apply. So: for each live assertion on the
 * stub, append a CORRECTED COPY — a plain `assertion.asserted` with the
 * same display words, the canonical id in place of the stub's, the same
 * sources (the insertion stays settled), the original's `created_at` (it
 * sits where the claim belongs), `supersedes: <original>` — then revoke
 * the original with `superseded_by` pointing at the copy. Readers stay
 * dumb: the copy is just an assertion.
 *
 * Author of the copy is the host procedure (`entity-supersede`); the
 * operator is named in the revocation's reason. The original keeps the
 * model's authorship and date. Nothing is rewritten. Idempotent: a re-run
 * finds nothing live on the stub; a retried run converges on the same
 * event ids.
 */

import { ENT_ID, ENTITY_ID_LINK } from "./ids";
import { assertionEntityId, assertionSourceReferences, createAssertionEvent, type AssertionEntity, type AssertionEvent } from "./assertionLog";
import {
  appendAndProjectAssertion,
  appendAndProjectRevocation,
  liveAssertionsForEntity,
  projectedEntityRow,
  projectedSourcesById,
  syncAssertionProjection,
} from "./assertionProjection";
import { commitAssertionEvents } from "./assertionLog";
import type { EventAuthor } from "./insertionLog";
import { commitRevocationEvents, createRevocationEvent } from "./revocationLog";

export const ENTITY_SUPERSEDE_PROCEDURE = "entity-supersede";
export const ENTITY_SUPERSEDE_VERSION = "1";

/** The corrected copy's author: the procedure, not the operator and not
 * the model whose claim it carries. */
export const SUPERSEDE_AUTHOR: EventAuthor = { kind: "system", id: ENTITY_SUPERSEDE_PROCEDURE };

export interface SupersedeOpts {
  /** The stub: an entity id or its label. */
  from: string;
  /** The canonical: an entity id or its label. A label no assertion has
   * linked yet is allowed — the copies mint it, under that label. */
  into: string;
  /** Only these assertion ids (a mixed stub split by hand); every live
   * assertion on the stub when absent. */
  only?: readonly string[];
  /** Who decided — named in each revocation's reason. */
  operator: string;
  now?: () => Date;
  dryRun?: boolean;
}

export interface SupersedeItem {
  original: string;
  copy: string;
  text: string;
}

export interface SupersedeResult {
  from: AssertionEntity;
  into: AssertionEntity;
  items: SupersedeItem[];
  /** Live assertions on the stub the run did not touch (`only` excluded them). */
  left: number;
  appended: number;
}

const idOf = (ref: string): string => (ENT_ID.test(ref) ? ref : assertionEntityId(ref));

/** The corrected copy of one assertion: every link to `from` now links
 * `into`, display words untouched; entities deduplicated when the claim
 * already linked the canonical too. */
export function correctedAssertion(
  original: AssertionEvent,
  from: AssertionEntity,
  into: AssertionEntity
): { text: string; entities: AssertionEntity[] } {
  const text = original.text.replace(
    ENTITY_ID_LINK,
    (whole, id: string, display: string) => (id === from.id ? `[[${into.id}|${display}]]` : whole)
  );
  const entities = new Map<string, AssertionEntity>();
  for (const entity of original.entities)
    entities.set(entity.id === from.id ? into.id : entity.id, entity.id === from.id ? into : entity);
  return { text, entities: [...entities.values()] };
}

export function supersedeEntity(root: string, opts: SupersedeOpts): SupersedeResult {
  syncAssertionProjection(root);
  const fromId = idOf(opts.from);
  const fromRow = projectedEntityRow(root, fromId);
  if (!fromRow) throw new Error(`entity-supersede: nothing live links ${opts.from} (${fromId})`);
  const from: AssertionEntity = { id: fromRow.id, label: fromRow.label };
  const intoId = idOf(opts.into);
  if (intoId === from.id) throw new Error(`entity-supersede: "${opts.into}" is the stub itself`);
  const intoRow = projectedEntityRow(root, intoId);
  const into: AssertionEntity = intoRow
    ? { id: intoRow.id, label: intoRow.label }
    : ENT_ID.test(opts.into)
      ? (() => { throw new Error(`entity-supersede: ${opts.into} is not in the record — name it by label`); })()
      : { id: intoId, label: opts.into.trim().replace(/\s+/g, " ") };

  const live = liveAssertionsForEntity(root, from.id);
  const wanted = opts.only ? new Set(opts.only) : undefined;
  const targets = wanted ? live.filter((event) => wanted.has(event.id)) : live;
  if (wanted) for (const id of wanted) if (!live.some((event) => event.id === id))
    throw new Error(`entity-supersede: ${id} is not a live assertion on ${from.label}`);
  const items: SupersedeItem[] = [];
  const sources = projectedSourcesById(root, targets.flatMap((event) => assertionSourceReferences(event).map((ref) => ref.insertion_id)));
  const now = opts.now ?? (() => new Date());
  const assertionPaths: string[] = [];
  const revocationPaths: string[] = [];
  for (const original of targets) {
    const corrected = correctedAssertion(original, from, into);
    const copy = createAssertionEvent({
      text: corrected.text,
      entities: corrected.entities,
      sources: assertionSourceReferences(original).map((ref) => ref.insertion_id),
      author: SUPERSEDE_AUTHOR,
      confidence: original.confidence,
      created_at: original.created_at,
      produced_by: { procedure: ENTITY_SUPERSEDE_PROCEDURE, version: ENTITY_SUPERSEDE_VERSION },
      supersedes: original.id,
    }, sources);
    const revocation = createRevocationEvent({
      assertion_id: original.id,
      superseded_by: copy.id,
      reason: `superseded: [[${from.label}]] → ${into.id} "${into.label}", by ${opts.operator}`,
      author: SUPERSEDE_AUTHOR,
      created_at: now().toISOString(),
      produced_by: { procedure: ENTITY_SUPERSEDE_PROCEDURE, version: ENTITY_SUPERSEDE_VERSION },
    });
    items.push({ original: original.id, copy: copy.id, text: corrected.text });
    if (opts.dryRun) continue;
    // Copy first, then the revocation that points at it — the order the
    // projection's sync replays in (assertions before revocations).
    assertionPaths.push(appendAndProjectAssertion(root, copy).path);
    revocationPaths.push(appendAndProjectRevocation(root, revocation).path);
  }
  if (!opts.dryRun && items.length) {
    commitAssertionEvents(root, assertionPaths, `supersede: ${items.length} assertion(s) [[${from.label}]] → ${into.label}`);
    commitRevocationEvents(root, revocationPaths, `supersede: revoke ${items.length} assertion(s) on [[${from.label}]]`);
  }
  return { from, into, items, left: live.length - targets.length, appended: opts.dryRun ? 0 : items.length };
}
