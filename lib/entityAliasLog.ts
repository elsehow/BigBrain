/** Append-only entity alias events — "this label names that entity".
 *
 * An assertion entity's id is a hash of its label (lib/assertionLog.ts
 * assertionEntityId), so `[[Evan]]` and `[[Evan Keller]]` are two entities
 * by construction, and nothing in the record could ever say they are one
 * person. Source transcripts can use first names where meeting metadata uses
 * full names. Once a first-name stub
 * exists the exact-title search hit hands it to every later mention.
 *
 * An alias event declares that one label's id resolves to another entity.
 * Readers apply it three ways: the projection answers every entity query
 * through the alias table (lib/assertionProjection.ts), the log readers
 * (entity view, graph) resolve ids through `entityAliasResolution`, and
 * intake canonicalizes `[[Evan]]` and `[[ent_<stub>|…]]` alike to the
 * canonical id before the assertion is ever written (lib/assertionAgent.ts).
 * Assertions already in the log keep their raw links — the log is immutable
 * — and resolve at read time.
 *
 * Latest declaration wins per alias id: re-aliasing a label moves it, and
 * aliasing a label to ITSELF (`alias_id === entity.id`) retracts it. Both
 * are ordinary appends, so the log stays append-only and a replay in any
 * order reproduces the same table (the projection compares `created_at`).
 *
 * Its own log directory (`log/entity-aliases/`), for declineLog.ts's
 * reason: the assertion log's readers validate that log strictly, and a
 * separate homogeneous log costs one directory where a mixed one costs a
 * guard in every reader forever. Host code constructs and validates
 * events; models never write this log directly. The append/read/commit
 * machinery is lib/eventLog.ts.
 */

import { assertionEntityId, type AssertionEntity, type AssertionProduction } from "./assertionLog";
import { eventLog, type AppendResult } from "./eventLog";
import { sha256hex } from "./hash";
import { ENT_ID } from "./ids";
import { validEventAuthor, type EventAuthor } from "./insertionLog";

export const ENTITY_ALIAS_LOG_DIR = "log/entity-aliases";

export interface EntityAliasEvent {
  event: "entity.aliased";
  id: string;
  /** The label being aliased, whitespace-normalized, case kept. */
  alias: string;
  /** assertionEntityId(alias) — the id that label hashes to, spelled out so
   * a reader resolves without the hash function. */
  alias_id: string;
  /** The entity the label now names. `entity.id === alias_id` retracts. */
  entity: AssertionEntity;
  author: EventAuthor;
  created_at: string;
  produced_by: AssertionProduction;
}

export interface EntityAliasInput {
  alias: string;
  entity: AssertionEntity;
  author: EventAuthor;
  created_at: string;
  produced_by: AssertionProduction;
}

export type EntityAliasAppendResult = AppendResult<EntityAliasEvent>;

const clean = (value: string): string => value.trim().replace(/\s+/g, " ");

export const isRetraction = (event: EntityAliasEvent): boolean => event.entity.id === event.alias_id;

export function validateEntityAliasEvent(event: EntityAliasEvent): void {
  if (event.event !== "entity.aliased" || !/^eal_[a-f0-9]{24}$/u.test(event.id))
    throw new Error("entity-alias-log: invalid event identity");
  if (!event.alias?.trim() || event.alias.length > 200 || /\n/u.test(event.alias))
    throw new Error("entity-alias-log: alias must be one 1-200 character line");
  if (event.alias !== clean(event.alias))
    throw new Error("entity-alias-log: alias is not whitespace-normalized");
  if (event.alias_id !== assertionEntityId(event.alias))
    throw new Error("entity-alias-log: alias_id does not hash from alias");
  if (!ENT_ID.test(event.entity?.id ?? "") || !event.entity.label?.trim())
    throw new Error("entity-alias-log: invalid entity declaration");
  if (event.entity.label !== clean(event.entity.label))
    throw new Error("entity-alias-log: entity label is not whitespace-normalized");
  if (!validEventAuthor(event.author)) throw new Error("entity-alias-log: invalid author");
  if (!event.created_at?.trim()) throw new Error("entity-alias-log: created_at is required");
  if (!event.produced_by?.procedure?.trim() || !event.produced_by.version?.trim())
    throw new Error("entity-alias-log: production procedure and version are required");
}

const log = eventLog<EntityAliasEvent>({
  name: "entity-alias",
  dir: ENTITY_ALIAS_LOG_DIR,
  when: (event) => event.created_at,
  validate: validateEntityAliasEvent,
});

/** Construct an immutable alias event. Unlike assertions, the identity hash
 * INCLUDES `created_at`: an alias re-declared after a retraction is a new
 * fact in time, not a retry of the old one, and latest-wins needs the two
 * to be distinct events. */
export function createEntityAliasEvent(input: EntityAliasInput): EntityAliasEvent {
  const alias = clean(input.alias);
  const entity: AssertionEntity = { id: input.entity.id, label: clean(input.entity.label) };
  const alias_id = alias ? assertionEntityId(alias) : "";
  const identity = JSON.stringify({
    alias_id, entity, author: input.author, created_at: input.created_at, produced_by: input.produced_by,
  });
  const event: EntityAliasEvent = {
    event: "entity.aliased",
    id: `eal_${sha256hex(identity).slice(0, 24)}`,
    alias,
    alias_id,
    entity,
    author: input.author,
    created_at: input.created_at,
    produced_by: input.produced_by,
  };
  validateEntityAliasEvent(event);
  return event;
}

export const entityAliasEventRel = log.rel;

export const appendEntityAliasEvent = log.append;

export const listEntityAliasEventFiles = log.listFiles;

export const readEntityAliasLog = log.read;

export const commitEntityAliasEvents = log.commit;

// ── resolution ──────────────────────────────────────────────────────────────

export interface EntityAliasResolution {
  /** alias id → the canonical entity it names. Flat: chains are followed at
   * build time, so one lookup is the whole answer. */
  canonical: Map<string, AssertionEntity>;
  /** canonical id → every alias label naming it, in declaration order. */
  labels: Map<string, string[]>;
}

/** Fold the log into the current alias table: the latest declaration per
 * alias id wins, a self-alias retracts, a cycle is broken by dropping its
 * OLDEST declaration (repeat until none), and chains flatten so one lookup
 * is the whole answer. Pure — the projection's insert path implements the
 * same rules incrementally in SQL; this is what the log readers (entity
 * view, graph) use. */
export function entityAliasResolution(events: readonly EntityAliasEvent[]): EntityAliasResolution {
  const byTime = (a: EntityAliasEvent, b: EntityAliasEvent): number =>
    a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  const latest = new Map<string, EntityAliasEvent>();
  for (const event of [...events].sort(byTime)) latest.set(event.alias_id, event);
  const target = new Map<string, EntityAliasEvent>();
  for (const event of latest.values()) if (!isRetraction(event)) target.set(event.alias_id, event);

  // Break cycles, oldest declaration first, until every chain ends.
  for (let broke = true; broke;) {
    broke = false;
    for (const start of target.keys()) {
      const path: string[] = [];
      const at = new Map<string, number>();
      let id = start;
      while (target.has(id) && !at.has(id)) {
        at.set(id, path.length);
        path.push(id);
        id = target.get(id)!.entity.id;
      }
      if (!target.has(id)) continue; // ended at a canonical entity
      const cycle = path.slice(at.get(id)!).map((member) => target.get(member)!);
      target.delete(cycle.sort(byTime)[0]!.alias_id);
      broke = true;
    }
  }

  const canonical = new Map<string, AssertionEntity>();
  const labels = new Map<string, string[]>();
  for (const event of [...target.values()].sort(byTime)) {
    let to = event.entity;
    while (target.has(to.id)) to = target.get(to.id)!.entity;
    canonical.set(event.alias_id, to);
    const held = labels.get(to.id) ?? [];
    if (!held.includes(event.alias)) held.push(event.alias);
    labels.set(to.id, held);
  }
  return { canonical, labels };
}

/** The read-side resolver over a vault's alias log: an entity as an
 * assertion links it → the entity every reader should show. */
export function entityAliasResolver(root: string): (entity: AssertionEntity) => AssertionEntity {
  const { canonical } = entityAliasResolution(log.read(root, { strict: true }));
  return (entity) => canonical.get(entity.id) ?? entity;
}
