/** Seed alias declarations from the legacy `entities/*.md` dossiers.
 *
 * The reference-era dossiers already carry the join table the assertion
 * scheme lacks — `entities/evan-keller.md` says `aliases: [Evan Keller,
 * Evan, evan.keller@example.com]` — and nothing read it once entity identity
 * became a label hash. This turns each dossier's alias list into
 * `entity.aliased` events for its projected entity (lib/entityAliasLog.ts),
 * which both repairs the first-name splits already in the record and makes
 * every later `[[Evan]]` resolve at intake.
 *
 * Conservative on purpose: an alias two dossiers claim, or one that is
 * another dossier's title, is ambiguous and is reported, not declared; an
 * alias some other declaration already owns is left alone. Idempotent — a
 * second run declares nothing.
 */

import { norm } from "./ids";
import { assertionEntityId, type AssertionEntity } from "./assertionLog";
import {
  appendAndProjectEntityAlias,
  projectedAssertionEntity,
  projectedEntityCandidates,
  syncAssertionProjection,
} from "./assertionProjection";
import { commitEntityAliasEvents, createEntityAliasEvent } from "./entityAliasLog";
import { legacyDossiers, type LegacyDossier } from "./entityDossiers";
import type { EventAuthor } from "./insertionLog";

export const ENTITY_ALIAS_SEED_PROCEDURE = "entity-alias-seed";
export const ENTITY_ALIAS_SEED_VERSION = "1";

const tokens = (value: string): number => norm(value).split(" ").length;
/** An email, handle or domain is never the name an entity shows. */
const handleish = (value: string): boolean => /@/u.test(value) || /^[\w-]+(\.[\w-]+)+$/u.test(value.trim());

export interface SeedDeclaration {
  alias: string;
  alias_id: string;
  /** Assertions already linking the alias's OWN id — a stub's evidence, 0
   * when nothing has linked the label. Shown so a declaration that folds a
   * real entity into another is visible before it is made. */
  alias_assertions: number;
  entity: AssertionEntity;
  dossier: string;
}

export interface SeedSkip {
  alias: string;
  dossier: string;
  reason: string;
}

export interface SeedPlan {
  declare: SeedDeclaration[];
  skipped: SeedSkip[];
}

/** Prefer the most-cited label, among multi-word names for a person.
 * A longer alias must not relabel a more frequently cited full name.
 * Ties prefer a person's longest name, then the dossier's title.
 * Emails and handles are never the displayed name. */
function canonicalOf(root: string, d: LegacyDossier, labels: readonly string[]): AssertionEntity {
  const names = labels.filter((label) => !handleish(label));
  const full = d.person ? names.filter((label) => tokens(label) > 1) : [];
  const candidates = (full.length ? full : names.length ? names : [d.title]).map((label) => ({
    label, projected: projectedAssertionEntity(root, assertionEntityId(label)),
  }));
  const best = candidates.reduce((held, c) => {
    const cited = c.projected?.assertions ?? 0, heldCited = held.projected?.assertions ?? 0;
    if (cited !== heldCited) return cited > heldCited ? c : held;
    if (d.person && tokens(c.label) !== tokens(held.label)) return tokens(c.label) > tokens(held.label) ? c : held;
    return held; // earlier wins: the title is first
  });
  return best.projected
    ? { id: best.projected.id, label: best.projected.label }
    : { id: assertionEntityId(best.label), label: best.label };
}

/** What a seed run would declare, and what it would leave alone and why.
 * Reads the projection; writes nothing. */
export function planEntityAliasSeed(root: string): SeedPlan {
  syncAssertionProjection(root);
  const dossiers = legacyDossiers(root);
  // Every label each dossier carries (title included): a label two dossiers
  // hold is ambiguous whichever side of either it sits on — "Josh" is
  // josh.md's title and josh-connor.md's alias, and names neither.
  const holders = new Map<string, Set<string>>();
  for (const d of dossiers)
    for (const label of [d.title, ...d.aliases])
      holders.set(norm(label), new Set([...(holders.get(norm(label)) ?? []), d.path]));
  // Not `declare`: a statement that begins with that word is an ambient
  // declaration to the TypeScript grammar, and the transpiler erases it.
  const planned = new Map<string, SeedDeclaration>();
  const skipped: SeedSkip[] = [];
  for (const d of dossiers) {
    const labels = [...new Map([d.title, ...d.aliases].map((label) => [norm(label), label])).values()];
    const canonical = canonicalOf(root, d, labels);
    const others = labels.filter((label) => assertionEntityId(label) !== canonical.id);
    // Nothing in the record under any of its labels: nothing to repair.
    if (!projectedAssertionEntity(root, canonical.id) &&
        !others.some((label) => projectedAssertionEntity(root, assertionEntityId(label)))) {
      for (const a of others) skipped.push({ alias: a, dossier: d.path, reason: `no projected entity for "${d.title}"` });
      continue;
    }
    const own = new Set(labels.map(norm));
    for (const a of others) {
      const aliasId = assertionEntityId(a);
      const held = [...(holders.get(norm(a)) ?? [])];
      if (held.length > 1) {
        skipped.push({ alias: a, dossier: d.path, reason: `held by ${held.length} dossiers: ${held.join(", ")}` });
        continue;
      }
      // A bare first name the record knows under other surnames is not this
      // dossier's to claim: "Jordan" beside Jordan Cole and Jordan (team) stays
      // the operator's call.
      if (tokens(a) === 1) {
        const rivals = projectedEntityCandidates(root, a, 6)
          .filter((c) => c.id !== canonical.id && c.id !== aliasId && !own.has(norm(c.label)));
        if (rivals.length) {
          skipped.push({
            alias: a, dossier: d.path,
            reason: `the record also knows ${rivals.map((c) => `${c.label} (${c.assertions})`).join(", ")}`,
          });
          continue;
        }
      }
      const existing = projectedAssertionEntity(root, aliasId);
      if (existing && existing.id === canonical.id) continue; // already resolves here
      if (existing && existing.id !== aliasId) {
        skipped.push({ alias: a, dossier: d.path, reason: `already an alias of ${existing.id} "${existing.label}"` });
        continue;
      }
      planned.set(aliasId, {
        alias: a, alias_id: aliasId, alias_assertions: existing?.assertions ?? 0,
        entity: canonical, dossier: d.path,
      });
    }
  }
  return { declare: [...planned.values()], skipped };
}

export interface SeedOpts {
  author: EventAuthor;
  now?: () => Date;
  dryRun?: boolean;
}

export interface SeedResult extends SeedPlan {
  appended: number;
}

/** Declare the plan: one alias event per declaration, appended and
 * projected, then committed as one change. `dryRun` reports the plan. */
export function seedEntityAliases(root: string, opts: SeedOpts): SeedResult {
  const plan = planEntityAliasSeed(root);
  if (opts.dryRun) return { ...plan, appended: 0 };
  const now = opts.now ?? (() => new Date());
  const paths: string[] = [];
  for (const item of plan.declare) {
    const event = createEntityAliasEvent({
      alias: item.alias, entity: item.entity, author: opts.author, created_at: now().toISOString(),
      produced_by: { procedure: ENTITY_ALIAS_SEED_PROCEDURE, version: ENTITY_ALIAS_SEED_VERSION },
    });
    paths.push(appendAndProjectEntityAlias(root, event).path);
  }
  if (paths.length)
    commitEntityAliasEvents(root, paths, `entity aliases: seed ${paths.length} from entities/ dossiers`);
  return { ...plan, appended: paths.length };
}
