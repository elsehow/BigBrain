/** Bind entities that ARE a source (lib/entitySourceLog.ts) — as the
 * gardener mints them, and in bulk for the ones already in the record.
 *
 * On extraction (`bindMintedEntities`, from lib/work.ts submitWire): an
 * entity the claim just minted, whose label names a source the claim cites
 * (lib/entitySourceMatch.ts `title` or `head`), was made from that document
 * and binds to it.
 *
 * In bulk (`bigbrain entity bind-sources`): the same test over history,
 * where "just minted" becomes "its FIRST claim cites the source, and at
 * least half its claims do". A label that names a cited source but fails
 * that test, or only `near`-names one, is reported as unclear and left
 * unbound. A pair the log already declares either way — bound, or unbound
 * by a person — is never re-decided, so a second run binds nothing.
 */

import { assertionSourceReferences, type AssertionEntity } from "./assertionLog";
import { appendAndProjectEntitySource, openAssertionProjectionReadonly, syncAssertionProjection } from "./assertionProjection";
import { bindingKey, commitEntitySourceEvents, createEntitySourceEvent } from "./entitySourceLog";
import { sourceMatch, type SourceMatch } from "./entitySourceMatch";
import type { EventAuthor } from "./insertionLog";
import { assertionSuperseded } from "./sourceSupersede";
import { vaultRecord } from "./vaultReadModel";

export const ENTITY_SOURCE_BIND_PROCEDURE = "entity-source-bind";
export const ENTITY_SOURCE_SEED_PROCEDURE = "entity-source-seed";
export const ENTITY_SOURCE_VERSION = "1";

/** The host binds on extraction; the model that wrote the claim did not. */
const BIND_AUTHOR: EventAuthor = { kind: "system", id: ENTITY_SOURCE_BIND_PROCEDURE };

export interface SourceBinding {
  entity: AssertionEntity;
  insertion_id: string;
  /** The source's title, for the report. */
  title: string;
  match: SourceMatch;
  /** The entity's claims citing the source, of `claims`. */
  citing: number;
  claims: number;
  /** Whether the entity's first claim cites it. */
  first: boolean;
}

export interface SourceBindingPlan {
  bind: SourceBinding[];
  unclear: Array<SourceBinding & { reason: string }>;
}

/** What a bulk run would bind, and what it would report as unclear and why.
 * Reads the projection; writes nothing. */
export function planEntitySourceSeed(root: string): SourceBindingPlan {
  syncAssertionProjection(root);
  const record = vaultRecord(root, true);
  const { rows, superseded, sources, aliases } = record;
  const resolve = (entity: AssertionEntity) => aliases.canonical.get(entity.id) ?? entity;
  const decided = new Set(record.entitySources.flatMap((event) => [
    bindingKey(event.entity.id, event.insertion_id), bindingKey(resolve(event.entity).id, event.insertion_id),
  ]));

  // Each entity's live claims, oldest first (rows are), by the sources they cite.
  const claims = new Map<string, { entity: AssertionEntity; cites: Array<Set<string>> }>();
  for (const row of rows) {
    const refs = assertionSourceReferences(row).map((ref) => ref.insertion_id);
    if (assertionSuperseded(refs, superseded, (id) => sources.has(id))) continue;
    const cited = new Set(refs.filter((id) => sources.has(id)));
    for (const linked of new Map(row.entities.map((e) => [resolve(e).id, resolve(e)])).values()) {
      const held = claims.get(linked.id) ?? { entity: linked, cites: [] };
      held.cites.push(cited);
      claims.set(linked.id, held);
    }
  }

  const plan: SourceBindingPlan = { bind: [], unclear: [] };
  for (const { entity, cites } of claims.values()) {
    const labels = [entity.label, ...(aliases.labels.get(entity.id) ?? [])];
    for (const insertionId of new Set(cites.flatMap((set) => [...set]))) {
      if (decided.has(bindingKey(entity.id, insertionId))) continue;
      const source = sources.get(insertionId)!;
      const match = best(labels.map((label) => sourceMatch(label, { title: source.title, head: source.excerpt })));
      if (!match) continue;
      const citing = cites.filter((set) => set.has(insertionId)).length;
      const item: SourceBinding = {
        entity, insertion_id: insertionId, title: source.title, match,
        citing, claims: cites.length, first: cites[0]!.has(insertionId),
      };
      const reason = match === "near" ? "names it only in passing"
        : !item.first ? "its first claim cites another source"
        : citing * 2 < cites.length ? `only ${citing} of its ${cites.length} claims cite it`
        : undefined;
      if (reason) plan.unclear.push({ ...item, reason });
      else plan.bind.push(item);
    }
  }
  const order = (a: SourceBinding, b: SourceBinding) => a.entity.label.localeCompare(b.entity.label) || a.title.localeCompare(b.title);
  plan.bind.sort(order);
  plan.unclear.sort(order);
  return plan;
}

const best = (matches: Array<SourceMatch | undefined>): SourceMatch | undefined =>
  matches.includes("title") ? "title" : matches.includes("head") ? "head" : matches.includes("near") ? "near" : undefined;

export interface SourceSeedOpts {
  author: EventAuthor;
  now?: () => Date;
  dryRun?: boolean;
}

/** Bind the plan: one event per binding, appended and projected, then
 * committed as one change. `dryRun` reports the plan. */
export function seedEntitySources(root: string, opts: SourceSeedOpts): SourceBindingPlan & { appended: number } {
  const plan = planEntitySourceSeed(root);
  if (opts.dryRun) return { ...plan, appended: 0 };
  const paths = bindAll(root, plan.bind, opts.author, ENTITY_SOURCE_SEED_PROCEDURE, opts.now);
  if (paths.length) commitEntitySourceEvents(root, paths, `entity sources: bind ${paths.length} entities to the sources they are`);
  return { ...plan, appended: paths.length };
}

/** On extraction: bind each entity a claim just minted to a source it
 * cites and names. Returns the appended event paths, committed. */
export function bindMintedEntities(
  root: string,
  minted: ReadonlyArray<{ entities: readonly AssertionEntity[]; insertion_ids: readonly string[] }>,
  now?: () => Date,
): string[] {
  const wanted = minted.filter((m) => m.entities.length && m.insertion_ids.length);
  if (!wanted.length) return [];
  const db = openAssertionProjectionReadonly(root);
  const bindings = new Map<string, Pick<SourceBinding, "entity" | "insertion_id">>();
  try {
    const query = db.query("SELECT title, excerpt FROM sources WHERE insertion_id = ? AND present = 1");
    for (const { entities, insertion_ids } of wanted)
      for (const insertionId of new Set(insertion_ids)) {
        const source = query.get(insertionId) as { title: string; excerpt: string } | null;
        if (!source) continue;
        for (const entity of entities) {
          const match = sourceMatch(entity.label, { title: source.title, head: source.excerpt });
          if (match === "title" || match === "head") bindings.set(bindingKey(entity.id, insertionId), { entity, insertion_id: insertionId });
        }
      }
  } finally { db.close(); }
  const paths = bindAll(root, [...bindings.values()], BIND_AUTHOR, ENTITY_SOURCE_BIND_PROCEDURE, now);
  if (paths.length) commitEntitySourceEvents(root, paths, `entity sources: bind ${paths.length} new entities to their sources`);
  return paths;
}

function bindAll(
  root: string,
  items: ReadonlyArray<Pick<SourceBinding, "entity" | "insertion_id">>,
  author: EventAuthor,
  procedure: string,
  now: () => Date = () => new Date(),
): string[] {
  return items.map((item) => appendAndProjectEntitySource(root, createEntitySourceEvent({
    entity: item.entity, insertion_id: item.insertion_id, bound: true, author,
    created_at: now().toISOString(), produced_by: { procedure, version: ENTITY_SOURCE_VERSION },
  })).path);
}
