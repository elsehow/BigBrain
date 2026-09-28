import type { ModelChoice } from "./modelChoice";
/**
 * entityFolds.ts — the memory pass's second job (#728): the labels in the
 * record that name ONE thing, proposed as groups for the operator to fold.
 *
 * An entity's id is hash(label) (lib/assertionLog.ts), so a project the
 * record met as "TrailAtlas", "Trail Map", "Trailmap" and "Route
 * planning dashboard" is four dossiers, and nothing says so. The intake
 * guard catches a one-word label that overlaps an existing one (#628) and
 * a label that looks like one — a spelling, an initialism, a surname
 * (lib/entityLookalikes.ts); a rename shares no letters. This is the
 * other half: a model reads the
 * census — every live canonical entity, its count, its span, one sample
 * claim — and names the groups. It PROPOSES. The alias event
 * (lib/entityAliasLog.ts) is the operator's: once an alias stands every
 * new assertion files under the canonical id, and retracting the alias
 * does not unfile them, so a false fold compounds daily while a missed
 * one is a split dossier anyone can see. Same asymmetry that rolled back
 * the seeded aliases (2026-08-30); identity stays operator-authored.
 *
 * ONE feeder, on the memory clock — after the sweep's gates, on its model
 * (lib/memoryRun.ts) — and `bigbrain entity folds --propose` on demand.
 * The clock asks about the DELTA: the entities that gained a claim since
 * the last proposal are the question, every other label the lookup, no
 * tools, one turn — the first full-census run cost $9.95 over eleven
 * verifying turns, a daily shape costs cents. Proposals accumulate until
 * settled. The output is DERIVED: `.state/entity-folds.json`, written by
 * this runner after validation and never by the model; the READ is
 * `liveFolds`, the file against today's record — a member folded or
 * retired since is gone, a pair the operator rejected
 * (lib/entityFoldLog.ts) never re-forms. Accept and reject are the routes
 * at the end, and stay the operator's.
 */

import type { PiSDK } from "./run/piSession";
type PiLoader = () => Promise<PiSDK>;
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { AssertionEntity } from "./assertionLog";
import {
  DATED_ASSERTIONS,
  appendAndProjectEntityAlias,
  openAssertionProjectionReadonly,
  projectedAssertionEntity,
  syncAssertionProjection,
} from "./assertionProjection";
import { ENGINE_ROOT } from "./engine";
import { ownerEmail } from "./env";
import { commitEntityAliasEvents, createEntityAliasEvent } from "./entityAliasLog";
import {
  appendEntityFoldRejectEvent,
  commitEntityFoldRejectEvents,
  createEntityFoldRejectEvent,
  pairKey,
  readEntityFoldRejectLog,
} from "./entityFoldLog";
import { writeAtomic } from "./fsx";
import { json, readBody, type Ctx, type Route } from "./httpx";
import { ENT_ID, ENTITY_LINK } from "./ids";
import type { EventAuthor } from "./insertionLog";
import type { Auth } from "./manifest";
import { MEMORY_ROLE } from "./memory";
import { runModel, type RunUsage } from "./run/model";
import { clip } from "./text";

/** One live canonical entity, as the model is shown it. */
export interface CensusRow {
  id: string;
  label: string;
  assertions: number;
  /** YYYY-MM bounds of the content dates its claims carry */
  first: string;
  last: string;
  /** `created_at` of its newest live claim — what "changed since" reads */
  latest: string;
  /** the newest live claim's display words, links flattened, clipped */
  sample: string;
}

/** A sample is a hint, not the dossier: one clause is enough to tell a
 * person from a project, and 600 of them must fit one prompt. */
export const SAMPLE_CHARS = 160;

/** A claim as a reader sees it: `[[ent_…|Nick]]` → Nick, `[[Label]]` → Label. */
export const displayWords = (text: string): string =>
  text
    .replace(ENTITY_LINK, (_whole, target: string, display?: string) => (display ?? target).trim())
    .replace(/\s+/g, " ")
    .trim();

/** Every live CANONICAL entity — an alias source is already folded and
 * has nothing to propose — with its newest live claim, alphabetical so
 * spelling variants sit together in the prompt. */
export function entityCensus(root: string, db?: Database): CensusRow[] {
  const handle = db ?? openAssertionProjectionReadonly(root);
  try {
    const rows = handle
      .query(`WITH d AS (${DATED_ASSERTIONS}),
        r AS (SELECT ae.entity_id AS entity_id, d.text AS text,
            ROW_NUMBER() OVER (PARTITION BY ae.entity_id ORDER BY d.date DESC, d.created_at DESC, d.id DESC) AS rn,
            COUNT(*) OVER (PARTITION BY ae.entity_id) AS n,
            MIN(d.date) OVER (PARTITION BY ae.entity_id) AS first,
            MAX(d.date) OVER (PARTITION BY ae.entity_id) AS last,
            MAX(d.created_at) OVER (PARTITION BY ae.entity_id) AS latest
          FROM assertion_entities ae JOIN d ON d.id = ae.assertion_id)
        SELECT e.id AS id, e.label AS label, r.n AS assertions,
          substr(r.first, 1, 7) AS first, substr(r.last, 1, 7) AS last, r.latest AS latest, r.text AS sample
        FROM r JOIN entities e ON e.id = r.entity_id
        WHERE r.rn = 1 AND e.id NOT IN (SELECT alias_id FROM entity_aliases)
        ORDER BY lower(e.label), e.id`)
      .all() as CensusRow[];
    return rows.map((r) => ({ ...r, sample: clip(displayWords(r.sample), SAMPLE_CHARS) }));
  } finally {
    if (!db) handle.close();
  }
}

const span = (r: CensusRow): string => (r.first === r.last ? r.first : `${r.first}..${r.last}`);
const fullLine = (r: CensusRow): string =>
  `${r.id} · ${r.label} · ${r.assertions} · ${span(r)} · ${JSON.stringify(r.sample)}`;
const bareLine = (r: CensusRow): string => `${r.id} · ${r.label} · ${r.assertions}`;

/** The rows that gained a claim after `since` — the clock's question. */
export const changedSince = (census: readonly CensusRow[], since: string): CensusRow[] =>
  census.filter((r) => r.latest > since);

/** The prompt: the engine's template, then the census. Whole — one line
 * per entity with its sample — when there is no `since`; otherwise the
 * changed rows in full as the question and every other row bare as the
 * lookup. Null when a delta has no question in it. */
export function renderFoldsPrompt(template: string, census: readonly CensusRow[], since?: string): string | null {
  const head = `${template.trimEnd()}\n\n## The census, today\n\n`;
  if (since === undefined)
    return `${head}${census.length} live entities, alphabetical — id · label · claims · span · newest claim\n\n${census.map(fullLine).join("\n")}\n`;
  const changed = changedSince(census, since);
  if (!changed.length) return null;
  const rest = census.filter((r) => r.latest <= since);
  return `${head}${census.length} live entities. ${changed.length} gained a claim since ${since.slice(0, 10)} — THOSE are the question: propose only groups that include at least one of them. The rest is the lookup.

### New or changed — id · label · claims · span · newest claim

${changed.map(fullLine).join("\n")}

### The rest — id · label · claims

${rest.map(bareLine).join("\n")}
`;
}

/** The answer is the LAST ```folds block, wherever the working went. */
export function parseFolds(text: string): unknown {
  const blocks = [...text.matchAll(/```folds\s*\n([\s\S]*?)```/g)];
  const last = blocks[blocks.length - 1]?.[1];
  if (last === undefined) throw new Error("entity-folds: the model wrote no ```folds block");
  try {
    return JSON.parse(last);
  } catch (e) {
    throw new Error(`entity-folds: the folds block is not JSON — ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface FoldMember {
  id: string;
  label: string;
  assertions: number;
}

export interface FoldGroup {
  /** most-cited first */
  members: FoldMember[];
  /** a member's id — the label the operator is invited to keep */
  canonical: string;
  why: string;
}

/** "The operator said these two are not one thing." */
export type RejectedPair = (a: string, b: string) => boolean;

/** The reject log as a predicate, both sides resolved through the alias
 * table so a pair refused before one side was folded holds against the
 * canonical it folded into. */
export function rejectedPairs(root: string): RejectedPair {
  const keys = new Set<string>();
  const canon = new Map<string, string>();
  const resolve = (id: string): string => {
    let c = canon.get(id);
    if (c === undefined) {
      c = projectedAssertionEntity(root, id)?.id ?? id;
      canon.set(id, c);
    }
    return c;
  };
  for (const event of readEntityFoldRejectLog(root)) keys.add(pairKey(resolve(event.pair[0].id), resolve(event.pair[1].id)));
  return (a, b) => keys.has(pairKey(a, b));
}

/** A group as the model writes it — and as a standing group is fed back
 * through validation against a later census. */
export const rawGroup = (g: FoldGroup): { members: string[]; canonical: string; why: string } => ({
  members: g.members.map((m) => m.id),
  canonical: g.canonical,
  why: g.why,
});

const cited = (g: FoldGroup): number => g.members.reduce((n, m) => n + m.assertions, 0);

/** The model's groups against the census: what stands, and one line for
 * everything set aside — the operator's audit of the validation, kept
 * beside the proposals. */
export function validateFolds(
  raw: unknown,
  census: readonly CensusRow[],
  rejected: RejectedPair = () => false
): { groups: FoldGroup[]; dropped: string[] } {
  if (!Array.isArray(raw)) throw new Error("entity-folds: the folds block must be a JSON array of groups");
  const byId = new Map(census.map((r) => [r.id, r]));
  const taken = new Set<string>();
  const dropped: string[] = [];
  const groups: FoldGroup[] = [];
  raw.forEach((g: unknown, i: number) => {
    const tag = `group ${i + 1}`;
    const shape = g !== null && typeof g === "object" ? (g as { members?: unknown; canonical?: unknown; why?: unknown }) : undefined;
    if (!shape || !Array.isArray(shape.members)) {
      dropped.push(`${tag}: not an object with a members array`);
      return;
    }
    const members: FoldMember[] = [];
    for (const m of shape.members) {
      // a model has written "ent_c32a…2fe70" with a space in it — whitespace
      // is never part of an id, so it is dropped before the lookup
      const id = typeof m === "string" ? m.replace(/\s+/g, "") : "";
      const row = byId.get(id);
      if (!row) {
        dropped.push(`${tag}: ${id || JSON.stringify(m)} is not a live canonical entity`);
        continue;
      }
      if (members.some((held) => held.id === id)) continue;
      if (taken.has(id)) {
        dropped.push(`${tag}: ${id} "${row.label}" already sits in an earlier group`);
        continue;
      }
      members.push({ id, label: row.label, assertions: row.assertions });
    }
    members.sort((a, b) => b.assertions - a.assertions || a.label.localeCompare(b.label));
    // a rejected pair: the operator has spoken; the lesser-cited side leaves
    for (let i = 0; i < members.length; i++)
      for (let j = members.length - 1; j > i; j--)
        if (rejected(members[i]!.id, members[j]!.id)) {
          const [gone] = members.splice(j, 1);
          dropped.push(`${tag}: ${gone!.id} "${gone!.label}" was rejected against ${members[i]!.id} "${members[i]!.label}"`);
        }
    if (members.length < 2) {
      dropped.push(`${tag}: fewer than two live members`);
      return;
    }
    let canonical = typeof shape.canonical === "string" ? shape.canonical.replace(/\s+/g, "") : "";
    if (!members.some((m) => m.id === canonical)) {
      if (canonical) dropped.push(`${tag}: canonical ${canonical} is not a member — the most-cited member stands in`);
      canonical = members[0]!.id;
    }
    for (const m of members) taken.add(m.id);
    groups.push({ members, canonical, why: typeof shape.why === "string" ? shape.why.trim() : "" });
  });
  groups.sort((a, b) => cited(b) - cited(a));
  return { groups, dropped };
}

/** What `.state/entity-folds.json` holds: the standing proposals, whole. */
export interface EntityFolds {
  proposedAt: string;
  model: string;
  /** the Claude Code session the last proposal was — its transcript's name */
  sessionId?: string;
  /** live canonical entities the model was shown */
  census: number;
  groups: FoldGroup[];
  /** what validation set aside, one line each */
  dropped: string[];
  usage?: RunUsage;
  wallMs: number;
}

export const entityFoldsFile = (root: string): string => join(root, ".state", "entity-folds.json");

export function readEntityFolds(root: string): EntityFolds | undefined {
  const file = entityFoldsFile(root);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as EntityFolds;
  } catch {
    return undefined;
  }
}

export interface ProposeOpts {
  target: ModelChoice;
  auth: Auth;
  /** SDK loader — tests replace transport, keeping the production session path */
  loadPi?: PiLoader;
  /** the clock's shape: only entities with a claim after this are the
   * question, and standing proposals are kept. Absent: the whole census,
   * fresh — `--propose`, and a vault's first pass. */
  since?: string;
  rejected?: RejectedPair;
  now?: () => Date;
  /** the prompt template; the engine's prompts/entity-folds.md by default */
  template?: string;
}

export interface ProposeResult {
  folds: EntityFolds;
  /** the model ran — false when a delta had no question in it */
  ran: boolean;
  /** entities in the question */
  changed: number;
}

/** Run the feeder once: census → model → validated groups → the state
 * file. The model runs as the memory pass (its role, its runner). */
export async function proposeEntityFolds(root: string, opts: ProposeOpts): Promise<ProposeResult> {
  syncAssertionProjection(root);
  const census = entityCensus(root);
  const rejected = opts.rejected ?? rejectedPairs(root);
  const now = opts.now ?? (() => new Date());
  const standing = opts.since !== undefined ? readEntityFolds(root) : undefined;
  const changed = opts.since !== undefined ? changedSince(census, opts.since).length : census.length;
  // stamped when the census is READ, not when the model returns: the next
  // delta starts here, so a claim that lands during the run is in it
  const proposedAt = now().toISOString();
  const t0 = Date.now();
  const template = opts.template ?? readFileSync(join(ENGINE_ROOT, "prompts", "entity-folds.md"), "utf8");
  const prompt = census.length < 2 ? null : renderFoldsPrompt(template, census, opts.since);
  if (prompt === null) {
    // nothing to ask: the standing proposals, re-read against today, stand
    const kept = standing
      ? { ...standing, ...validateFolds(standing.groups.map(rawGroup), census, rejected) }
      : { proposedAt, model: opts.target.model, census: census.length, groups: [], dropped: [], wallMs: 0 };
    write(root, kept);
    return { folds: kept, ran: false, changed };
  }
  const run = await runModel(
    { prompt, root, target: opts.target, role: MEMORY_ROLE, auth: opts.auth, noTools: true },
    opts.loadPi
  );
  // standing groups first: a member already proposed is not re-proposed,
  // and a group settled or emptied since falls out here
  const { groups, dropped } = validateFolds(
    [...(standing?.groups ?? []).map(rawGroup), ...(parseFolds(run.text) as unknown[])],
    census,
    rejected
  );
  const folds: EntityFolds = {
    proposedAt,
    model: opts.target.model,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    census: census.length,
    groups,
    dropped,
    ...(run.usage ? { usage: run.usage } : {}),
    wallMs: Date.now() - t0,
  };
  write(root, folds);
  return { folds, ran: true, changed };
}

function write(root: string, folds: EntityFolds): void {
  mkdirSync(join(root, ".state"), { recursive: true });
  writeAtomic(entityFoldsFile(root), `${JSON.stringify(folds, null, 2)}\n`);
}

/** What the viewer shows: the standing proposals against TODAY's record —
 * a member aliased or retired since is gone, a rejected pair is split, a
 * group left with one member is nothing. */
export interface FoldsView {
  /** null: no pass has proposed yet */
  proposedAt: string | null;
  model?: string;
  groups: FoldGroup[];
}

export function liveFolds(root: string): FoldsView {
  const folds = readEntityFolds(root);
  if (!folds) return { proposedAt: null, groups: [] };
  syncAssertionProjection(root);
  const { groups } = validateFolds(folds.groups.map(rawGroup), entityCensus(root), rejectedPairs(root));
  return { proposedAt: folds.proposedAt, model: folds.model, groups };
}

/** The proposals for a terminal. */
export function describeFolds(f: EntityFolds, groups: FoldGroup[] = f.groups): string {
  const head =
    `proposed ${f.proposedAt} · ${f.model} · ${f.census} entities · ${groups.length} group(s)` +
    (f.usage ? ` · $${(f.usage.cost_usd?.toFixed(2) ?? "unavailable")}, ${f.usage.turns} turn(s)` : "") +
    (f.wallMs ? ` · ${Math.round(f.wallMs / 1000)}s` : "");
  const lines = [head];
  groups.forEach((g, i) => {
    const canon = g.members.find((m) => m.id === g.canonical)!;
    const rest = g.members.filter((m) => m.id !== g.canonical).map((m) => `${m.label} (${m.assertions})`);
    lines.push(`${i + 1}. ${canon.label} (${canon.assertions})  ← ${rest.join(", ")}`);
    lines.push(`   ${canon.id}${g.why ? ` · ${g.why}` : ""}`);
  });
  if (f.dropped.length) lines.push(`set aside:\n${f.dropped.map((d) => `  - ${d}`).join("\n")}`);
  return lines.join("\n");
}

// ── the operator's two acts ─────────────────────────────────────────────────

/** Who is deciding: the vault's owner, or the account running the engine. */
export const operatorAuthor = (): EventAuthor => ({ kind: "user", id: ownerEmail() ?? userInfo().username });

const ACCEPT = { procedure: "entity-folds-accept", version: "1" } as const;
const REJECT = { procedure: "entity-folds-reject", version: "1" } as const;

const liveEntity = (root: string, id: string): AssertionEntity => {
  if (!ENT_ID.test(id)) throw new Error(`entity-folds: ${JSON.stringify(id)} is not an entity id`);
  const e = projectedAssertionEntity(root, id);
  if (!e) throw new Error(`entity-folds: ${id} is not in the record`);
  return { id: e.id, label: e.label };
};

/** ACCEPT: every member's label becomes an alias of the canonical — the
 * alias log's ordinary event, authored by the operator. Returns what was
 * declared. */
export function acceptFold(
  root: string,
  input: { canonical: string; members: string[] },
  author: EventAuthor = operatorAuthor(),
  now: () => Date = () => new Date()
): { canonical: AssertionEntity; aliased: AssertionEntity[] } {
  syncAssertionProjection(root);
  const canonical = liveEntity(root, input.canonical);
  const members = [...new Set(input.members)].filter((id) => id !== canonical.id).map((id) => liveEntity(root, id));
  if (!members.length) throw new Error("entity-folds: nothing to fold — name at least one other member");
  const paths: string[] = [];
  for (const m of members) {
    const event = createEntityAliasEvent({
      alias: m.label, entity: canonical, author, created_at: now().toISOString(), produced_by: ACCEPT,
    });
    paths.push(appendAndProjectEntityAlias(root, event).path);
  }
  commitEntityAliasEvents(root, paths, `entity folds: ${members.map((m) => `"${m.label}"`).join(", ")} → ${canonical.label}`);
  return { canonical, aliased: members };
}

/** REJECT: `member` is not the same thing as any of `others` — one event
 * per pair, so the pass never proposes them together again. */
export function rejectFold(
  root: string,
  input: { member: string; others: string[] },
  author: EventAuthor = operatorAuthor(),
  now: () => Date = () => new Date()
): { member: AssertionEntity; against: AssertionEntity[] } {
  syncAssertionProjection(root);
  const member = liveEntity(root, input.member);
  const others = [...new Set(input.others)].filter((id) => id !== member.id).map((id) => liveEntity(root, id));
  if (!others.length) throw new Error("entity-folds: nothing to reject against");
  const paths: string[] = [];
  for (const o of others) {
    const event = createEntityFoldRejectEvent({ a: member, b: o, author, created_at: now().toISOString(), produced_by: REJECT });
    paths.push(appendEntityFoldRejectEvent(root, event).path);
  }
  commitEntityFoldRejectEvents(root, paths, `entity folds: "${member.label}" is not ${others.map((o) => `"${o.label}"`).join(", ")}`);
  return { member, against: others };
}

/** The viewer's door: what stands, and the two acts. */
export function foldsRoutes(root: string, author: () => EventAuthor = operatorAuthor): Route[] {
  const post = <T>({ req, res }: Ctx, act: (body: T) => unknown): void => {
    void (async () => {
      try {
        json(res, 200, await act(JSON.parse(await readBody(req)) as T));
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    })();
  };
  return [
    { method: "GET", path: "/api/entity/folds", handler: ({ res }) => json(res, 200, liveFolds(root)) },
    {
      method: "POST",
      path: "/api/entity/folds/accept",
      handler: (ctx) => post<{ canonical: string; members: string[] }>(ctx, (b) => acceptFold(root, b, author())),
    },
    {
      method: "POST",
      path: "/api/entity/folds/reject",
      handler: (ctx) => post<{ member: string; others: string[] }>(ctx, (b) => rejectFold(root, b, author())),
    },
  ];
}
