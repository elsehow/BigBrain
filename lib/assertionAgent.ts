/**
 * assertionAgent.ts — the intake pass's HOST-SIDE primitives, shared by
 * every gardener door: the per-vault lock (single-flight for
 * `tend` and any interactive gardener beside it), the vault owner's
 * identity labels, and `canonicalizeAssertionLinks` — the validator that
 * resolves friendly `[[new entity]]` links and verifies explicit
 * `[[ent_…|display]]` links so the model never mints canonical ids.
 *
 * The pi loop that used to live here (proposal grammar, batch runner,
 * run/rejection journals) was deleted with #514: the one runner is
 * `claude -p` over the MCP server (lib/tend.ts), and host validation is
 * lib/work.ts `submitWork`. The pi era's journals under
 * `journal/assertions/` remain as history — lib/meter.ts still
 * normalizes them for telemetry.
 */

import { join } from "node:path";
import { ENT_ID, ENTITY_LINK } from "./ids";
import {
  assertionEntityId,
  type AssertionEntity,
} from "./assertionLog";
import {
  projectedAliasTarget,
  projectedEntityCandidates,
  projectedEntityRow,
  projectedLabelRows,
  retiredEntitySuccessor,
  type ProjectedAssertionEntity,
} from "./assertionProjection";
import { createLookalikeFinder, type Lookalike } from "./entityLookalikes";
import { ensureDir } from "./fsx";
import { isHeld, lockHolder, tryHold, type Hold } from "./sqliteLock";
import { latestUserIdentity } from "./userIdentity";

export const ASSERTION_AGENT_MAX_BATCH = 8;
export const ASSERTION_AGENT_TIMEOUT_MS = 30 * 60_000;

// ── the intake pass's own lock ──────────────────────────────────────────────
// A SQLite lock (lib/sqliteLock.ts, like the memory pass's), freed the
// moment its holder dies. Two intake runs on one vault would each
// select the same oldest unprocessed insertions — the handled set is only
// written at the end of a run — and append two models' worth of assertions
// for them. The scheduler never overlaps passes on one vault, but a second
// operator-invoked run beside a scheduled tend tick still could.

export const assertionLockFile = (root: string): string => join(root, ".state", "assertion.lock.sqlite");

/** The intake pass's hold, or null when another run has it. */
export function acquireAssertionLock(root: string): Hold | null {
  ensureDir(join(root, ".state"));
  return tryHold(assertionLockFile(root), { retired: join(root, ".state", "assertion.lock") });
}

/** The pid of the run holding the intake lock, as it recorded itself: for
 * a person to read, and for matching its progress to it. Whether anyone
 * holds the lock is intakeRunning's question, never this one's. */
export const intakeHolder = (root: string): number | null => lockHolder(assertionLockFile(root));

/** Is an intake round executing right now? Asks the lock itself, so a
 * crashed run never reads as running. The exact counterpart of
 * `memoryRunning` (lib/memory.ts), and what lets the queue view distinguish
 * "the gardener has this in hand" from "this is waiting for the next tick".
 * Before it existed, the queue head hardcoded `running: 0` and every intake row
 * said pending — including the ones a live round was working on. */
export function intakeRunning(root: string): boolean {
  return isHeld(assertionLockFile(root));
}

/** The owner's labels for the intake prompt's identity context, read from
 * the record the way the memory pass reads them (lib/memoryContext.ts): the
 * newest identity declaration's name and aliases (lib/userIdentity.ts — the
 * one answer a vault has to "who is this about", #683) plus the owner email
 * when the environment names it (BIGBRAIN_OWNER_EMAIL, the label the API
 * stamps arrivals with). Deduplicated, order-stable, never content-derived:
 * a name in a clipped page does not become the owner. */
export function ownerLabelsFor(
  root: string,
  env: Record<string, string | undefined> = process.env
): string[] {
  const labels: string[] = [];
  const me = latestUserIdentity(root);
  if (me) labels.push(me.name, ...me.aliases);
  const email = env["BIGBRAIN_OWNER_EMAIL"]?.trim();
  if (email) labels.push(email);
  return [...new Set(labels.map((label) => label.trim()).filter(Boolean))];
}

/** The refusal a would-be first-name stub gets: the entities that already
 * carry the word, most-cited first, and the two ways out. One line — it is
 * the item's `error` on the submit result, read by a model mid-run. */
export function stubMintRefusal(label: string, candidates: readonly ProjectedAssertionEntity[]): string {
  const list = candidates.map((c) => `${c.id} "${c.label}" (${c.assertions})`).join(", ");
  return `assertion-agent: [[${label}]] would mint a new entity beside ${list} — ` +
    `link one as [[${candidates[0]!.id}|${label}]], or write a fuller label if this is a different entity`;
}

/** The `new:` prefix a model puts on a label it has weighed against the
 * lookalikes and still means as its own thing: `[[new:Future of Life
 * Institute]]`. Stripped before the label is hashed, so the id is the
 * label's. */
export const NEW_LABEL_PREFIX = /^new:\s*/iu;

/** The refusal a lookalike gets (lib/entityLookalikes.ts): the two ways
 * out — link one, or insist with `new:` — and then the entities the label
 * resembles, most-cited first, each with the rule that matched. The ways
 * out come FIRST because the submit result clips an item's error at 2,000
 * characters (lib/work.ts) and eight long labels can pass that; the tail
 * that gets cut must be candidates, never the instruction. The model
 * chose right 110 times in 120 when this was replayed to it (2026-09-04),
 * so the insist path is real, not a formality. */
export function lookalikeRefusal(label: string, candidates: readonly Lookalike[]): string {
  const list = candidates.map((c) => `${c.id} "${c.label}" (${c.assertions}, ${c.via === c.label ? c.rule : `${c.rule} via "${c.via}"`})`).join(", ");
  return `assertion-agent: [[${label}]] would mint a new entity beside ${candidates.length} it resembles — ` +
    `link one as [[${candidates[0]!.id}|${label}]] if it is the same thing, or write [[new:${label}]] if it is a different entity from every candidate: ${list}`;
}

/** Resolve friendly `[[new entity]]` links and verify explicit projected
 * `[[ent_...|display]]` links. The model never mints canonical IDs.
 *
 * An agent links the CANONICAL thing, always (#628). A label resolves only
 * when it IS an entity's own label; an explicit id only when it is an
 * entity the record holds live. Neither form ever follows the alias table
 * — that is read-side (search, dossiers, the graph): "every [[Evan]] so far
 * meant Keller" is a fact about past assertions, not a rule for the next
 * one, and a new Evan must be refused, not swallowed. So a label or id that
 * is an alias is refused naming the canonical; a retired id (emptied by
 * supersession, #629) is refused naming where its assertions went; a
 * never-linked ONE-WORD label an existing entity carries is refused with
 * the candidates, so ambiguous first names require deliberate resolution;
 * and a never-linked label that LOOKS LIKE an existing one — a spelling,
 * an initialism, a shared surname, a stub's fuller form
 * (lib/entityLookalikes.ts) — is refused with the candidates and the
 * `new:` way out. The one-word rule has no way out but a fuller label: a
 * first-name stub is never the right entity. */
export function canonicalizeAssertionLinks(
  root: string,
  text: string
): CanonicalLinks {
  return createAssertionLinkCanonicalizer(root)(text);
}

/** An assertion's links, canonical; `minted` names the entities no claim
 * linked before this one (lib/entitySourceSeed.ts binds those that are a
 * source they cite). */
export interface CanonicalLinks { text: string; entities: AssertionEntity[]; minted: AssertionEntity[] }

/** Scoped to the validation phase: submitWire validates all links before it
 * appends any events. A later submission must build a fresh inventory. */
export function createAssertionLinkCanonicalizer(root: string): (text: string) => CanonicalLinks {
  let find: ReturnType<typeof createLookalikeFinder> | undefined;
  return text => canonicalizeLinks(root, text, label => (find ??= createLookalikeFinder(projectedLabelRows(root)))(label));
}

function canonicalizeLinks(root: string, text: string, candidates: (label: string) => Lookalike[]): CanonicalLinks {
  const entities = new Map<string, AssertionEntity>();
  const minted = new Map<string, AssertionEntity>();
  const link = (entity: AssertionEntity, display: string): string => {
    entities.set(entity.id, { id: entity.id, label: entity.label });
    return `[[${entity.id}|${display}]]`;
  };
  const canonical = text.replace(ENTITY_LINK, (_whole, rawTarget: string, rawDisplay?: string) => {
    const insisted = NEW_LABEL_PREFIX.test(rawTarget.trim());
    const target = rawTarget.trim().replace(NEW_LABEL_PREFIX, "").trim();
    const display = rawDisplay?.trim();
    if (ENT_ID.test(target)) {
      if (insisted) throw new Error(`assertion-agent: new: is for a label, not an id — link [[${target}|…]] or write [[new:label]]`);
      if (!display) throw new Error(`assertion-agent: existing entity link ${target} needs display text`);
      const alias = projectedAliasTarget(root, target);
      if (alias)
        throw new Error(`assertion-agent: ${target} is an alias of ${alias.id} "${alias.label}" — link [[${alias.id}|${display}]]`);
      const row = projectedEntityRow(root, target);
      if (row) return link(row, display);
      const successor = retiredEntitySuccessor(root, target);
      throw new Error(successor
        ? `assertion-agent: ${target} is retired — its assertions were superseded into ${successor.id} "${successor.label}": link [[${successor.id}|${display}]]`
        : `assertion-agent: unknown projected entity ${target}`);
    }
    if (display) throw new Error("assertion-agent: new entity links cannot supply an id/display pair");
    if (!target || target.length > 200) throw new Error("assertion-agent: invalid new entity label");
    const label = target.replace(/\s+/g, " ");
    const id = assertionEntityId(label);
    const alias = projectedAliasTarget(root, id);
    if (alias)
      throw new Error(`assertion-agent: "${label}" is an alias of ${alias.id} "${alias.label}" — link [[${alias.id}|${label}]]`);
    const row = projectedEntityRow(root, id);
    if (row) return link(row, label);
    if (!/\s/u.test(label)) {
      const candidates = projectedEntityCandidates(root, label);
      if (candidates.length) throw new Error(stubMintRefusal(label, candidates));
    }
    const successor = retiredEntitySuccessor(root, id);
    if (successor)
      throw new Error(`assertion-agent: "${label}" was superseded into ${successor.id} "${successor.label}" — link [[${successor.id}|${label}]], or write a fuller label if this is a different entity`);
    if (!insisted) {
      const alike = candidates(label);
      if (alike.length) throw new Error(lookalikeRefusal(label, alike));
    }
    minted.set(id, { id, label });
    return link({ id, label }, label);
  });
  if (!entities.size) throw new Error("assertion-agent: every assertion must link at least one entity");
  return { text: canonical, entities: [...entities.values()], minted: [...minted.values()] };
}
