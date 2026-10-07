/** Append-only entity↔source bindings — "this entity IS that source".
 *
 * The gardener sometimes takes a document as its own subject: a paper the
 * owner dropped becomes `[[Its Title]]`, and every claim on it reads "Its
 * Title found …". The entity earns its place — which papers bear on a
 * project is what a graph is for — but it and the arrival are then two
 * objects for one thing, and opening the entity never reaches the paper. A
 * binding says they are one: the graph marks the pair (GraphNode `opens` /
 * `drawnAs`), the viewer draws one node, and opening it opens the source.
 *
 * Latest declaration per (entity, insertion) pair wins: `bound: false`
 * unbinds, a later `true` binds again, and both are ordinary appends. A
 * reader resolves the entity through the alias table, so a binding made
 * before a fold holds for the canonical. Host code constructs and
 * validates events — on extraction (lib/work.ts submitWire) and in bulk
 * (`bigbrain entity bind-sources`, lib/entitySourceSeed.ts); models never
 * write this log. Its own log directory, for declineLog.ts's reason. The
 * append/read/commit machinery is lib/eventLog.ts.
 */

import type { AssertionEntity, AssertionProduction } from "./assertionLog";
import { eventLog, type AppendResult } from "./eventLog";
import { sha256hex } from "./hash";
import { ENT_ID } from "./ids";
import { validEventAuthor, type EventAuthor } from "./insertionLog";

export const ENTITY_SOURCE_LOG_DIR = "log/entity-sources";

export interface EntitySourceEvent {
  event: "entity.source-bound";
  id: string;
  entity: AssertionEntity;
  /** The source insertion the entity is. */
  insertion_id: string;
  /** `false` unbinds an earlier binding of the same pair. */
  bound: boolean;
  author: EventAuthor;
  created_at: string;
  produced_by: AssertionProduction;
}

export interface EntitySourceInput {
  entity: AssertionEntity;
  insertion_id: string;
  bound: boolean;
  author: EventAuthor;
  created_at: string;
  produced_by: AssertionProduction;
}

export type EntitySourceAppendResult = AppendResult<EntitySourceEvent>;

const clean = (value: string): string => value.trim().replace(/\s+/g, " ");

export function validateEntitySourceEvent(event: EntitySourceEvent): void {
  if (event.event !== "entity.source-bound" || !/^esb_[a-f0-9]{24}$/u.test(event.id))
    throw new Error("entity-source-log: invalid event identity");
  if (!ENT_ID.test(event.entity?.id ?? "") || !event.entity.label?.trim() || event.entity.label !== clean(event.entity.label))
    throw new Error("entity-source-log: invalid entity");
  if (!event.insertion_id?.trim() || /\s/u.test(event.insertion_id))
    throw new Error("entity-source-log: invalid insertion id");
  if (typeof event.bound !== "boolean") throw new Error("entity-source-log: bound must be true or false");
  if (!validEventAuthor(event.author)) throw new Error("entity-source-log: invalid author");
  if (!event.created_at?.trim()) throw new Error("entity-source-log: created_at is required");
  if (!event.produced_by?.procedure?.trim() || !event.produced_by.version?.trim())
    throw new Error("entity-source-log: production procedure and version are required");
}

const log = eventLog<EntitySourceEvent>({
  name: "entity-source",
  dir: ENTITY_SOURCE_LOG_DIR,
  when: (event) => event.created_at,
  validate: validateEntitySourceEvent,
});

/** The identity INCLUDES `created_at`, as an alias event's does: a pair
 * bound again after an unbind is a new fact in time, and latest-wins needs
 * the two to be distinct events. */
export function createEntitySourceEvent(input: EntitySourceInput): EntitySourceEvent {
  const entity: AssertionEntity = { id: input.entity.id, label: clean(input.entity.label) };
  const identity = JSON.stringify({
    entity: entity.id, insertion_id: input.insertion_id, bound: input.bound,
    author: input.author, created_at: input.created_at, produced_by: input.produced_by,
  });
  const event: EntitySourceEvent = {
    event: "entity.source-bound",
    id: `esb_${sha256hex(identity).slice(0, 24)}`,
    entity,
    insertion_id: input.insertion_id,
    bound: input.bound,
    author: input.author,
    created_at: input.created_at,
    produced_by: input.produced_by,
  };
  validateEntitySourceEvent(event);
  return event;
}

export const appendEntitySourceEvent = log.append;
export const listEntitySourceEventFiles = log.listFiles;
export const readEntitySourceLog = log.read;
export const commitEntitySourceEvents = log.commit;

/** The key one pair has. */
export const bindingKey = (entityId: string, insertionId: string): string => `${entityId}|${insertionId}`;

/** The latest declaration per pair, oldest first — `bound` says which way
 * it went. A pair with any declaration at all has been decided, and the
 * bulk pass never re-decides it. */
export function latestEntitySourceDeclarations(events: readonly EntitySourceEvent[]): EntitySourceEvent[] {
  const latest = new Map<string, EntitySourceEvent>();
  const byTime = (a: EntitySourceEvent, b: EntitySourceEvent): number =>
    a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  for (const event of [...events].sort(byTime)) latest.set(bindingKey(event.entity.id, event.insertion_id), event);
  return [...latest.values()].sort(byTime);
}
