/** `bigbrain migrate`: the retired logs become assertions
 * (docs/plans/2026-10-11-field-of-assertions.md, migrations 1, 2 and 4;
 * docs/design-principles.md §5).
 *
 * Each event in a retired log becomes the assertion that says what it said,
 * with its author, time and producer and the event's id in `migrated_from`.
 * A decline becomes a decline and a revocation a retraction. An alias, a
 * binding or a copy judgment was latest-wins in its log. So when a later
 * event replaces an earlier one (the same label declared again, a pair bound
 * or judged again), the earlier assertion is retracted at the later one's
 * time, and so is the standing one when a self-alias or an unbind withdraws
 * it. A self-alias or an unbind with nothing standing said nothing, and
 * becomes nothing. `log/attestations/` and `log/goal-assertions/`, which no
 * reader reads, are deleted.
 *
 * The run proves itself before it commits. What the old logs said — the
 * declined sources, the retracted assertions and their successors, the alias
 * table, the standing bindings, the copy judgments and declarations, the
 * refused folds — is folded by the old rules, and read again from the
 * projection rebuilt over the new record. The two must be equal. If they are
 * not, the vault is put back as it was. The retired logs wait in `.state/`
 * until the check passes, and the change is one commit.
 */

import { existsSync, mkdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  appendAssertionEvent, assertionEventRel, createDeclineAssertion, createIdentityAssertion, createRetraction,
  type AssertionSourceReference, type RecordedAssertion,
} from "./assertionLog";
import { assertionDbPath, openAssertionProjectionReadonly, rebuildAssertionProjection } from "./assertionProjection";
import { readDeclineLog, type DeclineEvent } from "./declineLog";
import { entityAliasResolution, isRetraction, readEntityAliasLog, type EntityAliasEvent } from "./entityAliasLog";
import { readEntityFoldRejectLog, type EntityFoldRejectEvent } from "./entityFoldLog";
import { bindingKey, latestEntitySourceDeclarations, readEntitySourceLog, type EntitySourceEvent } from "./entitySourceLog";
import { parseEventFile } from "./eventLog";
import { commitPathsOnly } from "./git";
import { listSourceInsertionEventFiles, validateSourceInsertion, type SourceInsertion } from "./insertionLog";
import { RETIRED_LOGS, UNREAD_LOGS, fileCount } from "./retiredLogs";
import { readRevocationLog, type RevocationEvent } from "./revocationLog";
import { foldCopyEvents } from "./sourceCopies";
import { copyPairKey, readSourceCopyLog, type SourceCopyEvent } from "./sourceCopyLog";


/** What the retired logs hold, read strictly: one unreadable event stops
 * the migration rather than being lost by it. */
interface Retired {
  declines: DeclineEvent[];
  revocations: RevocationEvent[];
  aliases: EntityAliasEvent[];
  bindings: EntitySourceEvent[];
  copies: SourceCopyEvent[];
  rejects: EntityFoldRejectEvent[];
}

function readRetired(root: string): Retired {
  const strict = { strict: true };
  return {
    declines: readDeclineLog(root, strict), revocations: readRevocationLog(root, strict),
    aliases: readEntityAliasLog(root, strict), bindings: readEntitySourceLog(root, strict),
    copies: readSourceCopyLog(root, strict), rejects: readEntityFoldRejectLog(root, strict),
  };
}

const byTime = <T extends { created_at: string; id: string }>(a: T, b: T): number =>
  a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

/** What every retired event carries, which its assertion keeps. */
type Said = Pick<DeclineEvent, "id" | "author" | "created_at" | "produced_by">;
const said = (e: Said) => ({ author: e.author, created_at: e.created_at, produced_by: e.produced_by, migrated_from: e.id });

/** A source map for the create functions from references already resolved. */
const resolved = (refs: readonly AssertionSourceReference[]): Map<string, SourceInsertion> =>
  new Map(refs.map((ref) => [ref.insertion_id, { source_id: ref.source_id } as SourceInsertion]));

/** The insertions named by id, read from the log (bindings and copies name
 * them by insertion alone). */
function insertionsById(root: string, ids: ReadonlySet<string>): Map<string, SourceInsertion> {
  const out = new Map<string, SourceInsertion>();
  for (const file of listSourceInsertionEventFiles(root))
    if (ids.has(file.id)) out.set(file.id, parseEventFile(file, validateSourceInsertion));
  return out;
}

export interface Conversion {
  assertions: RecordedAssertion[];
  /** Per retired log: its events, and the assertions they became. */
  counts: Record<string, { events: number; assertions: number }>;
  /** Events that said nothing standing: a self-alias or an unbind of nothing. */
  unsaid: string[];
}

/** The retired logs, as assertions. Pure over what was read: the same logs
 * convert to the same assertions, ids and all. */
export function convertRetired(retired: Retired, insertions: ReadonlyMap<string, SourceInsertion>): Conversion {
  const assertions: RecordedAssertion[] = [], unsaid: string[] = [];
  const counts: Conversion["counts"] = {};
  /** A log's events in time order, each converted, and the tally. */
  const each = <T extends Said>(log: string, events: readonly T[], convert: (event: T) => void): void => {
    const from = assertions.length;
    for (const event of [...events].sort(byTime)) convert(event);
    counts[log] = { events: events.length, assertions: assertions.length - from };
  };
  const sourceOf = (id: string): AssertionSourceReference => {
    const source = insertions.get(id);
    if (!source) throw new Error(`migrate: ${id} is not in log/insertions/`);
    return { insertion_id: id, source_id: source.source_id };
  };

  /** Latest-wins as retractions: each key's standing assertion is retracted
   * when a later event for the key replaces or withdraws it. */
  const standing = new Map<string, string>();
  const replace = (key: string, event: Said, reason: string, next?: RecordedAssertion): void => {
    const prior = standing.get(key);
    if (prior) {
      assertions.push(createRetraction({ retracts: prior, reason, ...said(event) }));
      standing.delete(key);
    } else if (!next) unsaid.push(event.id);
    if (next) { assertions.push(next); standing.set(key, next.id); }
  };

  each("log/declines", retired.declines, (d) => assertions.push(createDeclineAssertion({
    reason: d.reason, sources: d.insertions.map((i) => i.insertion_id), ...said(d),
  }, resolved(d.insertions))));
  each("log/revocations", retired.revocations, (r) => assertions.push(createRetraction({
    retracts: r.assertion_id, superseded_by: r.superseded_by, reason: r.reason, ...said(r),
  })));
  each("log/entity-aliases", retired.aliases, (a) => isRetraction(a)
    ? replace(`alias:${a.alias_id}`, a, "migrated: the label was made its own entity")
    : replace(`alias:${a.alias_id}`, a, "migrated: the label was declared again", createIdentityAssertion({
      identity: { says: "same", alias: { id: a.alias_id, label: a.alias }, entity: a.entity }, ...said(a),
    })));
  each("log/entity-sources", retired.bindings, (b) => {
    const key = `binding:${bindingKey(b.entity.id, b.insertion_id)}`;
    if (!b.bound) return replace(key, b, "migrated: unbound");
    replace(key, b, "migrated: bound again", createIdentityAssertion({
      identity: { says: "is-source", entity: b.entity }, sources: [b.insertion_id], ...said(b),
    }, resolved([sourceOf(b.insertion_id)])));
  });
  each("log/source-copies", retired.copies, (c) => {
    const identity = c.event === "source.copies-judged" ? { says: "copy" as const, score: c.score } : { says: c.same ? "copy" as const : "not-copy" as const };
    replace(`copy:${copyPairKey(...c.pair)}:${c.event}`, c, "migrated: judged or declared again",
      createIdentityAssertion({ identity, sources: [...c.pair], ...said(c) }, resolved(c.pair.map(sourceOf))));
  });
  each("log/entity-fold-rejects", retired.rejects, (r) => assertions.push(createIdentityAssertion({
    identity: { says: "distinct", entities: r.pair }, ...said(r),
  })));

  return { assertions, counts, unsaid };
}

/** What readers take from the retired logs, as sorted lines so two readings
 * compare and diff as text. */
export interface RecordReading {
  declined: string[];
  retracted: string[];
  aliases: string[];
  bindings: string[];
  copies: string[];
  rejects: string[];
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();
const copyLines = (events: readonly SourceCopyEvent[]): string[] => {
  const { declared, judged } = foldCopyEvents(events);
  return sorted([...[...declared].map(([key, same]) => `${key} declared ${same}`), ...[...judged].map(([key, j]) => `${key} judged ${j.score}`)]);
};

/** The reading the old rules gave: each log folded as its readers folded it. */
export function readingOfRetired(retired: Retired): RecordReading {
  const winner = new Map<string, RevocationEvent>();
  for (const r of [...retired.revocations].sort(byTime)) if (!winner.has(r.assertion_id)) winner.set(r.assertion_id, r);
  return {
    declined: sorted(retired.declines.flatMap((d) => d.insertions.map((i) => i.insertion_id))),
    retracted: sorted([...winner.values()].map((r) => `${r.assertion_id} > ${r.superseded_by ?? ""}`)),
    aliases: sorted([...entityAliasResolution(retired.aliases).canonical].map(([alias, entity]) => `${alias} > ${entity.id}`)),
    bindings: sorted(latestEntitySourceDeclarations(retired.bindings).filter((b) => b.bound).map((b) => bindingKey(b.entity.id, b.insertion_id))),
    copies: copyLines(retired.copies),
    rejects: sorted(retired.rejects.map((r) => `${r.pair[0].id}|${r.pair[1].id}`)),
  };
}

/** The reading the projection gives readers now. */
export function readingOfProjection(root: string): RecordReading {
  const db = openAssertionProjectionReadonly(root);
  try {
    const column = <T>(sql: string): T[] => db.query(sql).all() as T[];
    const events = <T>(table: string): T[] =>
      column<{ event_json: string }>(`SELECT event_json FROM ${table} WHERE retracted_by IS NULL`).map((r) => JSON.parse(r.event_json) as T);
    return {
      declined: sorted(column<{ id: string }>("SELECT insertion_id AS id FROM declines WHERE retracted_by IS NULL").map((r) => r.id)),
      retracted: sorted(column<{ id: string; next: string | null }>("SELECT id, superseded_by AS next FROM assertions WHERE revoked_by IS NOT NULL")
        .map((r) => `${r.id} > ${r.next ?? ""}`)),
      aliases: sorted(column<{ a: string; e: string }>("SELECT alias_id AS a, entity_id AS e FROM entity_aliases").map((r) => `${r.a} > ${r.e}`)),
      bindings: sorted(latestEntitySourceDeclarations(events<EntitySourceEvent>("entity_source_events")).filter((b) => b.bound)
        .map((b) => bindingKey(b.entity.id, b.insertion_id))),
      copies: copyLines(events<SourceCopyEvent>("source_copy_events")),
      rejects: sorted(column<{ a: string; b: string }>("SELECT a, b FROM entity_fold_rejects WHERE retracted_by IS NULL").map((r) => `${r.a}|${r.b}`)),
    };
  } finally { db.close(); }
}

/** The lines on which two readings disagree, each marked with the side that
 * has it. Empty when they agree. */
export function readingDiff(before: RecordReading, after: RecordReading): string[] {
  const out: string[] = [];
  for (const part of Object.keys(before) as (keyof RecordReading)[]) {
    const was = new Set(before[part]), now = new Set(after[part]);
    for (const line of was) if (!now.has(line)) out.push(`${part}: only before: ${line}`);
    for (const line of now) if (!was.has(line)) out.push(`${part}: only after: ${line}`);
  }
  return out;
}


export interface MigrationPlan extends Conversion {
  before: RecordReading;
  /** Logs nothing reads, by how many files each holds. */
  unread: Record<string, number>;
}

/** What `bigbrain migrate` would do. Reads only. */
export function planMigration(root: string): MigrationPlan {
  const retired = readRetired(root);
  const named = new Set([...retired.bindings.map((b) => b.insertion_id), ...retired.copies.flatMap((c) => c.pair)]);
  const conversion = convertRetired(retired, insertionsById(root, named));
  const unread = Object.fromEntries(UNREAD_LOGS.map((dir) => [dir, fileCount(root, dir)]).filter(([, n]) => n));
  return { ...conversion, before: readingOfRetired(retired), unread };
}

/** Whether the vault holds anything `bigbrain migrate` converts or deletes. */
export const needsMigration = (root: string): boolean =>
  [...RETIRED_LOGS, ...UNREAD_LOGS].some((dir) => fileCount(root, dir) > 0);

/** Convert, prove, commit. On a reading that differs, the vault is restored
 * and the difference thrown. */
export function migrateVault(root: string, plan: MigrationPlan = planMigration(root)): { written: number; committed: boolean } {
  const moved = [...RETIRED_LOGS, ...UNREAD_LOGS].filter((dir) => existsSync(join(root, dir)));
  const held = join(root, ".state", `migrate-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const written: string[] = [];
  try {
    for (const assertion of plan.assertions) if (!appendAssertionEvent(root, assertion).deduped) written.push(assertionEventRel(assertion));
    for (const dir of moved) {
      mkdirSync(dirname(join(held, dir)), { recursive: true });
      renameSync(join(root, dir), join(held, dir));
    }
    rebuildAssertionProjection(root);
    const diff = readingDiff(plan.before, readingOfProjection(root));
    if (diff.length) throw new Error(`migrate: the new record reads differently from the old logs:\n${diff.slice(0, 40).join("\n")}`);
  } catch (error) {
    for (const rel of written) try { unlinkSync(join(root, rel)); } catch { /* already gone */ }
    for (const dir of moved) if (existsSync(join(held, dir))) renameSync(join(held, dir), join(root, dir));
    rmSync(held, { recursive: true, force: true });
    // The projection read the record the vault did not keep. It is
    // disposable; the next migration builds it again.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(assertionDbPath(root) + suffix, { force: true });
    throw error;
  }
  const committed = existsSync(join(root, ".git")) && commitPathsOnly(root, "migrate",
    `Migrate: ${plan.assertions.length} assertions from the retired logs; ${moved.join(", ")} removed`,
    ["log/assertions", ...moved]);
  rmSync(held, { recursive: true, force: true });
  return { written: written.length, committed };
}
