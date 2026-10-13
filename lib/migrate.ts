/** `bigbrain migrate`: the retired logs become assertions and the trees from
 * before the insertion log become sources
 * (docs/plans/2026-10-11-field-of-assertions.md, migrations 1–4;
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
 * `references/`, `inbox/` and `requests/` held arrivals before #496 wrote
 * each one to `log/insertions/` instead. A file a source already holds (by
 * its path, its id or its content) is left to that source; any other is
 * imported as one, as the importer at the #496 flip did. `entities/` held
 * the retired editor's dossiers, whose alias lists were seeded into the
 * record (#642). All four trees are deleted.
 *
 * The run proves itself before it commits. What the old logs said — the
 * declined sources, the retracted assertions and their successors, the alias
 * table, the standing bindings, the copy judgments and declarations, the
 * refused folds — is folded by the old rules, and read again from the
 * projection rebuilt over the new record. The two must be equal. If they are
 * not, the vault is put back as it was. So it is if any file in the retired
 * trees is held by no source. What is removed waits in `.state/` until the
 * checks pass, and the change is one commit. A removed directory holding
 * files git never tracked (`inbox/*.md` is ignored) stays there, since no
 * commit can give them back.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  appendAssertionEvent, assertionEventRel, createDeclineAssertion, createIdentityAssertion, createRetraction,
  type AssertionSourceReference, type RecordedAssertion,
} from "./assertionLog";
import {
  assertionDbPath, openAssertionProjectionReadonly, rebuildAssertionProjection, recoverAssertionProjection,
} from "./assertionProjection";
import { readDeclineLog, type DeclineEvent } from "./declineLog";
import { entityAliasResolution, isRetraction, readEntityAliasLog, type EntityAliasEvent } from "./entityAliasLog";
import { parseEnvelope, type AttachmentRef } from "./envelope";
import { readEntityFoldRejectLog, type EntityFoldRejectEvent } from "./entityFoldLog";
import { bindingKey, latestEntitySourceDeclarations, readEntitySourceLog, type EntitySourceEvent } from "./entitySourceLog";
import { parseEventFile } from "./eventLog";
import { commitPathsOnly, gitLines } from "./git";
import { sha256hex } from "./hash";
import {
  appendSourceInsertionEvent, insertionEventRel, listSourceInsertionEventFiles, readSourceInsertionLog, sourceInsertion,
  validateSourceInsertion, type SourceInsertion,
} from "./insertionLog";
import { RETIRED_LOGS, RETIRED_TREES, UNREAD_LOGS, fileCount } from "./retiredLogs";
import { readRevocationLog, type RevocationEvent } from "./revocationLog";
import { foldCopies, type CopySaid } from "./sourceCopies";
import { copyPairKey, readSourceCopyLog, type SourceCopyEvent } from "./sourceCopyLog";
import { walkMarkdown } from "./vaultRead";


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
const copyLines = (said: readonly CopySaid[]): string[] => {
  const { declared, judged } = foldCopies(said);
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
    copies: copyLines(retired.copies.map((e) => e.event === "source.copies-judged"
      ? { id: e.id, pair: e.pair, created_at: e.created_at, score: e.score, model: e.author.id }
      : { id: e.id, pair: e.pair, created_at: e.created_at, same: e.same })),
    rejects: sorted(retired.rejects.map((r) => `${r.pair[0].id}|${r.pair[1].id}`)),
  };
}

/** The reading the projection gives readers now. */
export function readingOfProjection(root: string): RecordReading {
  const db = openAssertionProjectionReadonly(root);
  try {
    const column = <T>(sql: string): T[] => db.query(sql).all() as T[];
    const identities = (says: string) => column<{ id: string; says: string; entity_id: string; a: string; b: string; score: number | null; author_id: string; created_at: string }>(
      `SELECT id, says, entity_id, a, b, score, author_id, created_at FROM identities WHERE says IN (${says}) AND retracted_by IS NULL`);
    return {
      declined: sorted(column<{ id: string }>("SELECT insertion_id AS id FROM declines WHERE retracted_by IS NULL").map((r) => r.id)),
      retracted: sorted(column<{ id: string; next: string | null }>("SELECT id, superseded_by AS next FROM assertions WHERE revoked_by IS NOT NULL")
        .map((r) => `${r.id} > ${r.next ?? ""}`)),
      aliases: sorted(column<{ a: string; e: string }>("SELECT alias_id AS a, entity_id AS e FROM entity_aliases").map((r) => `${r.a} > ${r.e}`)),
      bindings: sorted(identities("'is-source'").map((b) => bindingKey(b.entity_id, b.a))),
      copies: copyLines(identities("'copy', 'not-copy'").map((r) => ({ id: r.id, pair: [r.a, r.b] as const, created_at: r.created_at,
        ...(r.score === null ? { same: r.says === "copy" } : { score: r.score, model: r.author_id }) }))),
      rejects: sorted(identities("'distinct'").map((r) => `${r.a}|${r.b}`)),
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

/** What a source holds besides its envelope: its body and its attachments. */
const contentKey = (body: string, envelope: Record<string, unknown>): string => {
  const attachments = Array.isArray(envelope.attachments) ? envelope.attachments as AttachmentRef[] : [];
  return sha256hex(`${body}\u0000${attachments.map((a) => a.sha256).sort().join(",")}`);
};

/** The importer at the #496 flip wrote every source it imported as this. */
const IMPORTER = { kind: "service", id: "import" } as const;

/** A retired tree's markdown files: held by a source already, repeating one's
 * content, or imported as a new one. */
export interface TreeTally { files: number; held: number; repeats: number; imported: number }

export interface TreeImport {
  trees: Partial<Record<(typeof RETIRED_TREES)[number], TreeTally>>;
  imports: SourceInsertion[];
}

/** The arrivals in the retired trees under `base` that `insertions` do not
 * hold, as the sources that would. A file is held when a source was imported
 * from its path or carries its id. One whose body and attachments a source
 * already has repeats it, and lands nothing. A dossier is not an arrival. */
export function importTrees(base: string, insertions: readonly SourceInsertion[]): TreeImport {
  const paths = new Set(insertions.flatMap((i) => i.imported_path ? [i.imported_path] : []));
  const ids = new Set(insertions.map((i) => i.source_id));
  const contents = new Set(insertions.map((i) => contentKey(i.body, i.envelope)));
  const out: TreeImport = { trees: {}, imports: [] };
  for (const tree of RETIRED_TREES) {
    if (!existsSync(join(base, tree))) continue;
    const files = walkMarkdown(base, [tree]).sort();
    const tally = out.trees[tree] = { files: files.length, held: 0, repeats: 0, imported: 0 };
    if (tree === "entities") continue;
    for (const rel of files) {
      const { envelope, body } = parseEnvelope(readFileSync(join(base, rel), "utf8"));
      const named = typeof envelope.id === "string" && envelope.id ? envelope.id : undefined;
      if (paths.has(rel) || (named && ids.has(named))) { tally.held++; continue; }
      const key = contentKey(body, envelope);
      if (contents.has(key)) { tally.repeats++; continue; }
      const id = named ?? `import-${sha256hex(rel).slice(0, 16)}`;
      out.imports.push({ ...sourceInsertion({ ...envelope, id }, body), author: IMPORTER, imported_path: rel });
      contents.add(key);
      ids.add(id);
      tally.imported++;
    }
  }
  return out;
}

export interface MigrationPlan extends Conversion {
  before: RecordReading;
  /** Logs nothing reads, by how many files each holds. */
  unread: Record<string, number>;
  trees: TreeImport;
}

/** Every directory `bigbrain migrate` removes. */
const REMOVED = [...RETIRED_LOGS, ...UNREAD_LOGS, ...RETIRED_TREES];

const holdsRetiredLogs = (root: string): boolean => RETIRED_LOGS.some((dir) => fileCount(root, dir) > 0);

/** What `bigbrain migrate` would do. Writes nothing but the disposable
 * projection, which a vault without retired logs reads its record from. */
export function planMigration(root: string): MigrationPlan {
  const retired = readRetired(root);
  const named = new Set([...retired.bindings.map((b) => b.insertion_id), ...retired.copies.flatMap((c) => c.pair)]);
  const conversion = convertRetired(retired, insertionsById(root, named));
  const unread = Object.fromEntries(UNREAD_LOGS.map((dir) => [dir, fileCount(root, dir)]).filter(([, n]) => n));
  const before = holdsRetiredLogs(root) ? readingOfRetired(retired) : (recoverAssertionProjection(root), readingOfProjection(root));
  return { ...conversion, before, unread, trees: importTrees(root, readSourceInsertionLog(root, { strict: true })) };
}

/** Whether the vault holds anything `bigbrain migrate` converts or deletes. */
export const needsMigration = (root: string): boolean => REMOVED.some((dir) => fileCount(root, dir) > 0);

export interface MigrationResult {
  written: number;
  imported: number;
  committed: boolean;
  /** Where the removed directories holding untracked files were kept, and how many such files. */
  kept?: { path: string; files: number };
}

/** Convert, prove, commit. On a reading that differs, the vault is restored
 * and the difference thrown. */
export function migrateVault(root: string, plan: MigrationPlan = planMigration(root)): MigrationResult {
  const moved = REMOVED.filter((dir) => existsSync(join(root, dir)));
  const tracked = existsSync(join(root, ".git"));
  // A pathspec git knows no file under fails the commit, so only directories it tracks are named.
  const inGit = tracked ? moved.filter((dir) => gitLines(root, ["ls-files", "--", dir]).length) : [];
  const untracked = tracked ? gitLines(root, ["ls-files", "--others", "--", ...moved]) : [];
  // What no commit can give back stays: everything, in a vault without git.
  const keep = tracked ? moved.filter((dir) => untracked.some((rel) => rel.startsWith(`${dir}/`))) : moved;
  const stamp = `migrate-${new Date().toISOString().replace(/[:.]/g, "-")}`, held = join(root, ".state", stamp);
  const written: string[] = [], imported: string[] = [];
  let committed = false;
  try {
    for (const assertion of plan.assertions) if (!appendAssertionEvent(root, assertion).deduped) written.push(assertionEventRel(assertion));
    // No wake: the gardener finds the imported sources at its next tick,
    // not while the record is half moved.
    for (const source of plan.trees.imports)
      if (!appendSourceInsertionEvent(root, source, { wake: false }).deduped) imported.push(insertionEventRel(source));
    for (const dir of moved) {
      mkdirSync(dirname(join(held, dir)), { recursive: true });
      renameSync(join(root, dir), join(held, dir));
    }
    rebuildAssertionProjection(root);
    const diff = readingDiff(plan.before, readingOfProjection(root));
    if (diff.length) throw new Error(`migrate: the new record reads differently from the old logs:\n${diff.slice(0, 40).join("\n")}`);
    const lost = importTrees(held, readSourceInsertionLog(root, { strict: true })).imports.map((s) => s.imported_path);
    if (lost.length) throw new Error(`migrate: no source holds ${lost.length} files of the retired trees:\n${lost.slice(0, 40).join("\n")}`);
    const what = [
      written.length && `${written.length} assertions from the retired logs`,
      imported.length && `${imported.length} sources from the retired trees`,
      `${moved.join(", ")} removed`,
    ].filter(Boolean);
    committed = tracked && commitPathsOnly(root, "migrate", `Migrate: ${what.join("; ")}`, [...written, ...imported, ...inGit]);
  } catch (error) {
    for (const rel of [...written, ...imported]) try { unlinkSync(join(root, rel)); } catch { /* already gone */ }
    for (const dir of moved) if (existsSync(join(held, dir))) renameSync(join(held, dir), join(root, dir));
    rmSync(held, { recursive: true, force: true });
    // The projection read the record the vault did not keep. It is
    // disposable; the next migration builds it again.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(assertionDbPath(root) + suffix, { force: true });
    throw error;
  }
  for (const dir of moved) if (!keep.includes(dir)) rmSync(join(held, dir), { recursive: true, force: true });
  if (!keep.length) rmSync(held, { recursive: true, force: true });
  const files = tracked ? untracked.length : keep.reduce((n, dir) => n + fileCount(held, dir), 0);
  return { written: written.length, imported: imported.length, committed, ...(keep.length ? { kept: { path: `.state/${stamp}`, files } } : {}) };
}
