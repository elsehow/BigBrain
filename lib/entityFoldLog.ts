/** Append-only entity fold REJECTS — "these two are not one thing" (#728).
 *
 * The memory pass proposes groups of labels that name one thing
 * (lib/entityFolds.ts); the operator settles each: an accept is an alias
 * event (lib/entityAliasLog.ts), and a reject is this. A reject is a
 * decision, so it is record, not derived state — the proposals file is
 * regenerable, the pass is not owed a second look at a pair the operator
 * has already refused. One event per pair, ids sorted so (a, b) and (b, a)
 * are one fact; readers resolve both sides through the alias table, so a
 * pair rejected before one side was folded still holds against its
 * canonical. Its own log directory, for declineLog.ts's reason.
 */

import type { AssertionEntity, AssertionProduction } from "./assertionLog";
import { eventLog, type AppendResult } from "./eventLog";
import { sha256hex } from "./hash";
import { ENT_ID } from "./ids";
import { validEventAuthor, type EventAuthor } from "./insertionLog";

export const ENTITY_FOLD_REJECT_LOG_DIR = "log/entity-fold-rejects";

export interface EntityFoldRejectEvent {
  event: "entity.fold-rejected";
  id: string;
  /** the two entities, ascending by id */
  pair: [AssertionEntity, AssertionEntity];
  author: EventAuthor;
  created_at: string;
  produced_by: AssertionProduction;
}

export interface EntityFoldRejectInput {
  a: AssertionEntity;
  b: AssertionEntity;
  author: EventAuthor;
  created_at: string;
  produced_by: AssertionProduction;
}

export type EntityFoldRejectAppendResult = AppendResult<EntityFoldRejectEvent>;

const clean = (value: string): string => value.trim().replace(/\s+/g, " ");

export function validateEntityFoldRejectEvent(event: EntityFoldRejectEvent): void {
  if (event.event !== "entity.fold-rejected" || !/^efr_[a-f0-9]{24}$/u.test(event.id))
    throw new Error("entity-fold-reject-log: invalid event identity");
  const [a, b] = event.pair ?? [];
  for (const side of [a, b])
    if (!ENT_ID.test(side?.id ?? "") || !side.label?.trim() || side.label !== clean(side.label))
      throw new Error("entity-fold-reject-log: invalid entity in pair");
  if (a.id >= b.id) throw new Error("entity-fold-reject-log: pair must be two entities, ascending by id");
  if (!validEventAuthor(event.author)) throw new Error("entity-fold-reject-log: invalid author");
  if (!event.created_at?.trim()) throw new Error("entity-fold-reject-log: created_at is required");
  if (!event.produced_by?.procedure?.trim() || !event.produced_by.version?.trim())
    throw new Error("entity-fold-reject-log: production procedure and version are required");
}

const log = eventLog<EntityFoldRejectEvent>({
  name: "entity-fold-reject",
  dir: ENTITY_FOLD_REJECT_LOG_DIR,
  when: (event) => event.created_at,
  validate: validateEntityFoldRejectEvent,
});

/** The identity is the pair, the author and the moment — like an alias
 * event's: a retry of one decision converges on one file, a later
 * re-decision of the same pair is its own event (both mean "not the same",
 * so readers need no latest-wins). */
export function createEntityFoldRejectEvent(input: EntityFoldRejectInput): EntityFoldRejectEvent {
  const norm = (e: AssertionEntity): AssertionEntity => ({ id: e.id, label: clean(e.label) });
  const [a, b] = [norm(input.a), norm(input.b)].sort((x, y) => x.id.localeCompare(y.id));
  const event: EntityFoldRejectEvent = {
    event: "entity.fold-rejected",
    id: `efr_${sha256hex(JSON.stringify([a!.id, b!.id, input.author, input.created_at, input.produced_by])).slice(0, 24)}`,
    pair: [a!, b!],
    author: input.author,
    created_at: input.created_at,
    produced_by: input.produced_by,
  };
  validateEntityFoldRejectEvent(event);
  return event;
}

export const appendEntityFoldRejectEvent = log.append;
export const readEntityFoldRejectLog = log.read;
export const commitEntityFoldRejectEvents = log.commit;

/** The key one pair has, whichever way round it is asked. */
export const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
