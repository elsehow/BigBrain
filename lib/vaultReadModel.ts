/** The shared, versioned read model. Only reconciliation reads event files;
 * consumers borrow a complete SQLite snapshot and reuse its decoded records.
 * Nothing here checks the filesystem: every engine write projects itself, and
 * notes come in through their door (assertionProjection.projectNotes). */
import type { AssertionId, EntityId, InsertionId } from "./ids";
import type { SourceSummary } from "./sourceSummary";
import { USER_IDENTITY_PROCEDURE, USER_IDENTITY_VERSION, userIdentityDeclarationsFromEvents } from "./userIdentityPolicy";
import type { ConnectionEvidence, DocumentLinkTargets, MarkdownDocument, MarkdownIdentity } from "./markdownGraph";
import { aliasDeclarationsIn, assertionDbPath, openAssertionProjectionReadonly, projectionRecovered, projectionRevision, syncAssertionProjection } from "./assertionProjection";
import { entityAliasResolution, type AliasDeclaration, type EntityAliasResolution } from "./entityAliasLog";
import type { Binding, Retraction } from "./assertionKinds";
import { assertionSourceReferences, type AssertionEvent } from "./assertionLog";
import { insertionEventRel, sourceMoment, type SourceInsertion, type SourceMetadata } from "./insertionLog";
import { withProjectionWrite } from "./projectionWriteLock";
import type { RecentEntry } from "./viewTypes";
import { threadsByInsertion, type SourceThread } from "./sourceThreads";
import { supersededInsertionIds, liveAssertionSql, liveSourceSql } from "./sourceSupersede";
import {
  copyCandidates, copyCutoff, CROWD, foldCopies, PROPOSE_FLOOR, sameTitle, sourceCopies, titleBuckets, titleForms,
  type CopyRecord, type CopyWhy, type SourceCopies, type TitleForms,
} from "./sourceCopies";
import { copyPairKey } from "./sourceCopyLog";
import { STUB_CHARS } from "./text";
import { aboutIds, VOICE_KINDS } from "./voiceFacts";
import type { CacheKey, Snapshot } from "./views/view";
import { Database } from "bun:sqlite";

/** Source summaries and settlement shared by feed and graph construction. */
export interface SourceRecord {
  revision: string;
  sources: Map<string, SourceSummary>;
  superseded: Set<string>;
  cited: Set<string>;
  declined: Set<string>;
  threads: Map<string, SourceThread<SourceSummary>>;
  threadByInsertion: Map<string, SourceThread<SourceSummary>>;
}
export interface VaultRecord extends SourceRecord {
  documents: MarkdownIdentity[];
  /** What each document's links name; their evidence is documentLinkTexts. */
  documentLinks: Map<string, DocumentLinkTargets>;
  rows: AssertionEvent[];
  aliases: EntityAliasResolution;
  /** The latest entity↔source declaration per pair (lib/entitySourceLog.ts),
   * oldest first; `bound: false` ones are unbindings. */
  entitySources: Binding[];
  /** Copies of one document (lib/sourceCopies.ts), by insertion id. */
  copies: Map<string, SourceCopies<SourceSummary>>;
  revoked: Map<string, Retraction>;
}
interface DecodedRevision {
  revision: string;
  record?: VaultRecord;
  sources?: SourceRecord;
  copies?: CopiesRecord;
  copyLinks?: CopyLinks;
  catalog?: { sources: SourceMetadata[]; threads: SourceThread<SourceMetadata>[] };
  memory?: { inss: SourceMetadata[]; asserted: AssertionEvent[]; voice: SourceInsertion[];
    revocations: Retraction[]; aliases: AliasDeclaration[] };
}
const records = new Map<string, DecodedRevision>();
function decodedRevision(root: string, revision: string): DecodedRevision {
  const held = records.get(root);
  if (held?.revision === revision) return held;
  // One bounded owner for decoded views; revision changes invalidate all of them.
  if (!records.has(root) && records.size >= 4) records.delete(records.keys().next().value!);
  const next = { revision }; records.set(root, next); return next;
}
const reading = new Map<string, { db: Database; revision: string }>();
export const currentReadRevision = (root: string): string | undefined => reading.get(root)?.revision;

/** Published content revision, or the revision borrowed by a nested reader.
 * This cheap probe does not reconcile or decode record content. */
export function readModelRevision(root: string): string {
  const current = currentReadRevision(root);
  if (current) return current;
  try {
    const db = openAssertionProjectionReadonly(root);
    try { return projectionRevision(root, db) ?? "incomplete"; }
    finally { db.close(); }
  } catch { return "missing"; }
}

/** One complete snapshot, at the revision every write so far has published.
 * It syncs only for what a snapshot cannot be read without: a projection
 * this process has not recovered, or sources not yet grouped into threads.
 * The callback is synchronous; nested readers borrow the same transaction. */
export function withVaultSnapshot<T>(root: string, read: (db: Database, revision: string) => T): T {
  const active = reading.get(root);
  if (active) return read(active.db, active.revision);
  let db: Database;
  try { db = openAssertionProjectionReadonly(root); }
  catch { syncAssertionProjection(root); db = openAssertionProjectionReadonly(root); }
  try {
    db.run("BEGIN");
    const revision = projectionRevision(root, db);
    if (!revision || !projectionRecovered(root, revision.split(":")[0]!) || db.query("SELECT 1 FROM meta WHERE k = 'threads_dirty'").get()) {
      db.run("ROLLBACK");
      syncAssertionProjection(root);
      return withVaultSnapshot(root, read);
    }
    reading.set(root, { db, revision });
    try { return read(db, revision); } finally { reading.delete(root); }
  } finally { if (db.inTransaction) db.run("ROLLBACK"); db.close(); }
}

/** One snapshot, handed to a view (lib/views/view.ts). Its decodes are
 * cached per vault and revision, as the root-taking reads' are. */
export const withSnapshot = <T>(root: string, view: (snapshot: Snapshot) => T): T =>
  withVaultSnapshot(root, (db, revision) => view({ db, revision, cache: root as CacheKey }));

/** A feed miss needs neither assertion prose nor Markdown/link evidence.
 * The graph reuses these same objects when it needs the rest of the corpus. */
export const sourceRecord = (root: string): SourceRecord => withSnapshot(root, sourceRecordOf);
export function sourceRecordOf({ db, revision, cache }: Snapshot): SourceRecord {
  const held = decodedRevision(cache, revision);
  if (held.sources) return held.sources;
  const sources = summariesById(db.query(`SELECT ${SUMMARY} FROM sources s WHERE s.present = 1
    ORDER BY coalesce(s.received_at, s.occurred_at, ''), s.insertion_id`).all() as SummaryRow[]);
  const ids = (sql: string) => new Set((db.query(sql).all() as { insertion_id: string }[]).map(row => row.insertion_id));
  const declined = ids("SELECT DISTINCT insertion_id FROM declines WHERE retracted_by IS NULL");
  // Withdrawal alone never makes an arrival pending again. A decline wins
  // only when no live assertion cites that arrival (sourceSettlement tests).
  const cited = ids(`SELECT DISTINCT x.insertion_id FROM assertion_sources x
    JOIN assertions a ON a.id = x.assertion_id
    WHERE a.revoked_by IS NULL OR NOT EXISTS (SELECT 1 FROM declines d WHERE d.insertion_id = x.insertion_id AND d.retracted_by IS NULL)`);
  const grouped = threadsIn(db, sources);
  return held.sources = { revision, sources, cited, declined, superseded: supersededInsertionIds(sources.values()),
    threads: new Map(grouped.flatMap(t => [t.path, ...t.aliases].map(path => [path, t] as const))),
    threadByInsertion: threadsByInsertion(grouped) };
}

export const vaultRecord = (root: string): VaultRecord => withSnapshot(root, vaultRecordOf);
/** Everything the graph draws from, at one snapshot. */
export function vaultRecordOf(snapshot: Snapshot): VaultRecord {
  const { db, revision, cache } = snapshot;
  const held = decodedRevision(cache, revision);
  if (held.record) return held.record;
  const sources = sourceRecordOf(snapshot);
  const rows = decoded<AssertionEvent>(db, "SELECT event_json FROM assertions WHERE revoked_by IS NULL ORDER BY created_at, id");
  const revoked = new Map<string, Retraction>();
  for (const retraction of retractionsIn(db)) if (!revoked.has(retraction.retracts)) revoked.set(retraction.retracts, retraction);
  const aliases = aliasesIn(db);
  const entitySources = entitySourcesIn(db);
  const documents = (db.query("SELECT header_json AS document_json FROM markdown_documents ORDER BY path").all() as { document_json: string }[]).map(r => JSON.parse(r.document_json) as MarkdownIdentity);
  const documentLinks = new Map((db.query("SELECT path, links_json, citations_json FROM document_links").all() as { path: string; links_json: string; citations_json: string }[])
    .map(r => [r.path, { links: JSON.parse(r.links_json), citations: JSON.parse(r.citations_json) } as DocumentLinkTargets]));
  return held.record = { ...sources, documents, documentLinks, rows, aliases, entitySources, copies: copiesRecordOf(snapshot).groups, revoked };
}

/** The graph view's connections touching `ids`, each with its evidence, in
 * the order the build drew them (graph_evidence): an assertion's, oldest
 * first, then each document's — notes by path, then sources as they
 * arrived. A link's text is its paragraph (document_link_text); an
 * assertion's, its prose. */
export function graphEvidence(root: string, ids: readonly string[]): Array<{ from: string; to: string; evidence: ConnectionEvidence }> {
  // an assertion's run has no path; a document's runs come after them all
  return withVaultSnapshot(root, (db) => (db.query(`WITH hit AS (
      SELECT * FROM graph_evidence WHERE a IN (SELECT value FROM json_each(?1))
      UNION SELECT * FROM graph_evidence WHERE b IN (SELECT value FROM json_each(?1)))
    SELECT h.a, h.b, h.assertion, h.path, h.link,
      CASE WHEN h.link >= 0 THEN coalesce(json_extract(t.texts_json, '$[' || h.link || ']'), '') ELSE x.text END AS text
    FROM hit h
      LEFT JOIN assertions x ON h.link < 0 AND x.id = h.assertion
      LEFT JOIN document_link_text t ON h.link >= 0 AND t.path = h.grp
      LEFT JOIN sources s ON h.grp LIKE 'source:%' AND s.insertion_id = substr(h.grp, 8)
    ORDER BY h.path != '', CASE WHEN h.path = '' THEN x.created_at END,
      h.grp LIKE 'source:%', coalesce(s.received_at, s.occurred_at, ''), h.grp, h.pos`)
    .all(JSON.stringify(ids)) as Array<{ a: string; b: string; assertion: string; path: string; link: number; text: string | null }>)
    .map(({ a, b, assertion, path, link, text }) => ({ from: a, to: b, evidence:
      link >= 0 ? { path, text: text ?? "" } : path ? { assertion, path, text: text ?? "" } : { assertion, text: text ?? "" } })));
}

/** A pair that might be one document, still to settle: asked of a person,
 * with the model's score once it has one. */
export interface CopyProposal { a: string; b: string; score?: number }

interface CopiesRecord {
  groups: Map<string, SourceCopies<SourceSummary>>;
  /** By insertion id: the proposals its document is part of. */
  proposals: Map<string, CopyProposal[]>;
  /** Candidates no model has scored and no person has settled. */
  unjudged: [string, string][];
}

/** What links copies besides their keys (lib/sourceCopies.ts), read whole
 * (these logs are small): an entity bound to each landing, a person's word
 * and a model's judgment per pair. `landing` names the live landing a
 * binding's insertion stands for: itself, or when a later landing of its
 * source superseded it, that one, as the graph follows it. */
interface CopyLinks {
  said: CopyRecord;
  joins: Map<string, string[]>;
  pairs: [string, string, CopyWhy][];
  apart: (a: string, b: string) => boolean;
}
function copyLinks(db: Database, landing: (insertionId: string) => string | undefined): CopyLinks {
  const canonical = db.query("SELECT entity_id FROM entity_aliases WHERE alias_id = ?");
  const joins = new Map<string, string[]>();
  for (const binding of entitySourcesIn(db)) {
    const id = landing(binding.insertion_id);
    const entity = (canonical.get(binding.entity.id) as { entity_id: string } | null)?.entity_id ?? binding.entity.id;
    if (id) joins.set(id, [...(joins.get(id) ?? []), `entity:${entity}`]);
  }
  const said = foldCopies((db.query(`SELECT id, says, a, b, score, author_id, created_at FROM identities
    WHERE says IN ('copy', 'not-copy') AND retracted_by IS NULL`).all() as
    { id: string; says: string; a: string; b: string; score: number | null; author_id: string; created_at: string }[])
    .map((r) => ({ id: r.id, pair: [r.a, r.b] as const, created_at: r.created_at,
      ...(r.score === null ? { same: r.says === "copy" } : { score: r.score, model: r.author_id }) })));
  const cutoff = copyCutoff(said);
  const pair = (key: string): [string, string] => key.split("|") as [string, string];
  const pairs: [string, string, CopyWhy][] = [];
  for (const [key, same] of said.declared) if (same) pairs.push([...pair(key), "you"]);
  for (const [key, j] of said.judged) if (j.score >= cutoff && !said.declared.has(key)) pairs.push([...pair(key), "judged"]);
  return { said, joins, pairs, apart: (a, b) => said.declared.get(copyPairKey(a, b)) === false };
}
/** A copy whose text the vault does not hold leads no group (lib/text.ts). */
function stubIn(db: Database): (source: SourceSummary) => boolean {
  const prose = db.query("SELECT prose_chars FROM sources WHERE insertion_id = ?");
  return (source) => ((prose.get(source.id) as { prose_chars: number } | null)?.prose_chars ?? 0) < STUB_CHARS;
}

/** Copies of one document (lib/sourceCopies.ts) over live arrivals outside
 * mail threads. Exact keys, an entity binding (a superseded landing followed
 * to its live one, as the graph does), a person's "same" and a judgment at or
 * above the cut-off link a pair; a person's "not the same" cuts it. The whole
 * record, for the graph and the judging pass; a note asks copyGroups. */
const copiesRecord = (root: string): CopiesRecord => withSnapshot(root, copiesRecordOf);
function copiesRecordOf(snapshot: Snapshot): CopiesRecord {
  const { db, revision, cache } = snapshot;
  const held = decodedRevision(cache, revision);
  if (held.copies) return held.copies;
  const { sources, superseded, threadByInsertion } = sourceRecordOf(snapshot);
  const live = new Map<string, string>();
  for (const source of sources.values()) if (!superseded.has(source.id)) live.set(source.source_id, source.id);
  const links = copyLinks(db, (id) => {
    const landed = sources.get(id);
    return landed && (superseded.has(landed.id) ? live.get(landed.source_id) : landed.id);
  });
  const { said } = links;
  const works = [...sources.values()].filter((s) => !superseded.has(s.id) && !threadByInsertion.has(s.id));
  const groups = sourceCopies(works, { ...links, stub: stubIn(db) });
  const proposals = new Map<string, CopyProposal[]>(), unjudged: [string, string][] = [];
  const members = (id: string): string[] => groups.get(id)?.members.map((m) => m.id) ?? [id];
  for (const [a, b] of copyCandidates(works)) {
    const key = copyPairKey(a, b), group = groups.get(a), judged = said.judged.get(key);
    if (said.declared.has(key) || (group && group === groups.get(b))) continue;
    if (!judged) unjudged.push([a, b]);
    else if (judged.score < PROPOSE_FLOOR) continue;
    const proposal: CopyProposal = { a, b, ...(judged ? { score: judged.score } : {}) };
    for (const id of [...members(a), ...members(b)]) {
      const held = proposals.get(id);
      if (held) held.push(proposal); else proposals.set(id, [proposal]);
    }
  }
  return held.copies = { groups, proposals, unjudged };
}

/** Copies of one document (lib/sourceCopies.ts), by insertion id. */
export const sourceCopiesRecord = (root: string): Map<string, SourceCopies<SourceSummary>> => copiesRecord(root).groups;

/** Candidates for the judging pass (lib/stages/copyJudge.ts). */
export const unjudgedCopies = (root: string): [string, string][] => copiesRecord(root).unjudged;

const SUMMARY = "s.header_json, s.excerpt, s.intake_priority, s.transcript_model";
type SummaryRow = { header_json: string; excerpt: string; intake_priority: number | null; transcript_model: string | null };
const summaryOf = (row: SummaryRow): SourceSummary =>
  ({ ...JSON.parse(row.header_json), excerpt: row.excerpt, intakePriority: row.intake_priority, transcriptModel: row.transcript_model });
const summariesById = (rows: readonly SummaryRow[]): Map<string, SourceSummary> =>
  new Map(rows.map((row) => { const source = summaryOf(row); return [source.id, source]; }));
/** What copiesRecord groups: a live arrival, outside any mail thread. */
const GROUPED = `s.present = 1 AND ${liveSourceSql("s")} AND NOT EXISTS (SELECT 1 FROM read_thread_members m
  JOIN read_thread_members o ON o.thread_id = m.thread_id AND o.insertion_id != m.insertion_id WHERE m.insertion_id = s.insertion_id)`;
const GROUPED_SOURCE = `SELECT ${SUMMARY} FROM sources s WHERE s.insertion_id = ? AND ${GROUPED}`;
const LANDING = `SELECT CASE WHEN ${liveSourceSql("s")} THEN s.insertion_id ELSE (SELECT t.insertion_id FROM sources t
    WHERE t.present = 1 AND t.source_id = s.source_id AND ${liveSourceSql("t")}
    ORDER BY coalesce(t.received_at, t.occurred_at, '') DESC, t.insertion_id DESC LIMIT 1) END AS id
  FROM sources s WHERE s.insertion_id = ? AND s.present = 1`;

/** copyLinks at this revision, with each landing looked up as copiesRecord
 * follows it: the latest live landing of a superseded one's source. Held
 * for the revision, so it keeps no statement of the snapshot's. */
function linksIn(db: Database, revision: string, root: string): CopyLinks {
  return decodedRevision(root, revision).copyLinks ??=
    copyLinks(db, (id) => (db.query(LANDING).get(id) as { id: string | null } | null)?.id ?? undefined);
}

/** The copy groups `ids` belong to, by insertion id, exactly as copiesRecord
 * groups the whole record: the arrivals reachable from them through a shared
 * key (source_copy_keys), a bound entity or a pair, grouped by the same rule.
 * Nothing outside that reach can join them. */
function copyGroupsIn(db: Database, ids: readonly string[], links: CopyLinks): Map<string, SourceCopies<SourceSummary>> {
  const add = (map: Map<string, string[]>, key: string, id: string): void => { const held = map.get(key); if (held) held.push(id); else map.set(key, [id]); };
  const byJoin = new Map<string, string[]>(), paired = new Map<string, string[]>();
  for (const [id, keys] of links.joins) for (const key of keys) add(byJoin, key, id);
  for (const [a, b] of links.pairs) { add(paired, a, b); add(paired, b, a); }
  const grouped = db.query(GROUPED_SOURCE);
  const keyed = db.query("SELECT DISTINCT o.insertion_id AS id FROM source_copy_keys k JOIN source_copy_keys o ON o.key = k.key WHERE k.insertion_id = ?");
  const seen = new Set<string>(), works: SourceSummary[] = [], next = [...ids];
  while (next.length) {
    const id = next.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const row = grouped.get(id) as SummaryRow | null;
    if (!row) continue;
    works.push(summaryOf(row));
    for (const mate of keyed.all(id) as { id: string }[]) next.push(mate.id);
    for (const key of links.joins.get(id) ?? []) next.push(...byJoin.get(key)!);
    next.push(...(paired.get(id) ?? []));
  }
  return sourceCopies(works, { ...links, stub: stubIn(db) });
}

/** The copy groups of these sources (lib/sourceCopies.ts), by insertion id:
 * a source with no other copy has none. */
export function copyGroups(root: string, ids: readonly string[]): Map<string, SourceCopies<SourceSummary>> {
  return withVaultSnapshot(root, (db, revision) => copyGroupsIn(db, ids, linksIn(db, revision, root)));
}

/** The pairs still to settle that a source's document is part of: each
 * candidate (lib/sourceCopies.ts copyCandidates) with one of its copies on
 * one side, found through the title buckets its copies sit in, as
 * copiesRecord finds them over the whole record. Pair order. */
export function copyProposals(root: string, insertionId: string): CopyProposal[] {
  return withVaultSnapshot(root, (db, revision) => {
    const links = linksIn(db, revision, root);
    const group = copyGroupsIn(db, [insertionId], links).get(insertionId);
    const self = group ? undefined : db.query(GROUPED_SOURCE).get(insertionId) as SummaryRow | null;
    const members = group?.members ?? (self ? [summaryOf(self)] : []);
    const ours = new Set<string>(members.map((m) => m.id));
    const mates = db.query(`SELECT ${SUMMARY} FROM source_title_keys t JOIN sources s ON s.insertion_id = t.insertion_id
      WHERE t.bucket = ? AND ${GROUPED}`);
    const forms = new Map<string, TitleForms | undefined>();
    const formsOf = (source: SourceSummary): TitleForms | undefined => {
      if (!forms.has(source.id)) forms.set(source.id, titleForms(source));
      return forms.get(source.id);
    };
    const candidates = new Map<string, [string, string]>();
    for (const member of members) {
      const mine = formsOf(member);
      for (const bucket of mine ? titleBuckets(mine) : []) {
        const met = (mates.all(bucket) as SummaryRow[]).map(summaryOf);
        if (met.length < 2 || met.length > CROWD) continue;
        for (const other of met) {
          if (other.id === member.id || !sameTitle(mine!, formsOf(other)!)) continue;
          const pair: [string, string] = member.id < other.id ? [member.id, other.id] : [other.id, member.id];
          candidates.set(copyPairKey(...pair), pair);
        }
      }
    }
    const out: CopyProposal[] = [];
    for (const [key, [a, b]] of [...candidates].sort(([x], [y]) => x.localeCompare(y))) {
      const judged = links.said.judged.get(key);
      if (links.said.declared.has(key) || (ours.has(a) && ours.has(b))) continue;
      if (judged && judged.score < PROPOSE_FLOOR) continue;
      out.push({ a, b, ...(judged ? { score: judged.score } : {}) });
    }
    return out;
  });
}

/** Present sources' summaries, by insertion id. */
export function sourceSummaries(root: string, ids: readonly string[]): Map<string, SourceSummary> {
  return withVaultSnapshot(root, (db) => summariesById(db.query(`SELECT ${SUMMARY} FROM sources s
    WHERE s.present = 1 AND s.insertion_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as SummaryRow[]));
}

/** A source's other copies, best first; none when it has none. */
export function otherCopies(root: string, insertionId: string): SourceSummary[] {
  return (copyGroups(root, [insertionId]).get(insertionId)?.members ?? []).filter((copy) => copy.id !== insertionId);
}

/** Publish derived rows only for the revision from which they were prepared.
 * Background workers can lose a race without overwriting newer data. */
export function publishReadModel(root: string, revision: string, write: (db: Database) => void): boolean {
  return withProjectionWrite(root, () => {
    const db = new Database(assertionDbPath(root));
    try {
      db.run("PRAGMA busy_timeout = 5000");
      return db.transaction(() => {
        if (projectionRevision(root, db) !== revision) return false;
        write(db);
        return true;
      })();
    } finally { db.close(); }
  });
}

function feedPageIn(db: Database, revision: string, start: number, size: number, source?: string) {
  if ((db.query("SELECT v FROM meta WHERE k = 'feed_revision'").get() as { v: string } | null)?.v !== revision) return;
  const where = source ? "WHERE source = ?" : "";
  const filter = source ? [source.toLowerCase()] : [];
  const total = (db.query(`SELECT count(*) AS n FROM read_feed ${where}`).get(...filter) as { n: number }).n;
  const recent = (db.query(`SELECT row_json FROM read_feed ${where} ORDER BY position LIMIT ? OFFSET ?`).all(...filter, size, start) as { row_json: string }[]).map(r => JSON.parse(r.row_json) as RecentEntry);
  return { recent, nextOffset: start + recent.length < total ? start + recent.length : null, total };
}

/** Read a published page without reconciling or preparing on the caller's thread.
 * Undefined is a cache miss; the async caller schedules the normal builder. */
export function preparedFeedPage(root: string, offset: number, limit: number, source?: string) {
  let db: Database;
  try { db = openAssertionProjectionReadonly(root); } catch { return; }
  try {
    db.run("BEGIN");
    const revision = projectionRevision(root, db);
    if (!revision || db.query("SELECT 1 FROM meta WHERE k = 'threads_dirty'").get()) return;
    return feedPageIn(db, revision, Math.max(0, Math.trunc(offset)), Math.max(1, Math.trunc(limit)), source);
  } finally { if (db.inTransaction) db.run("ROLLBACK"); db.close(); }
}

/** Feed pages read indexed, compact rows. Summaries/thread grouping are paid
 * once by the publisher, shared across processes, limits and offsets. */
export function readFeedPage(root: string, offset: number, limit: number, source: string | undefined,
  build: (record: SourceRecord) => RecentEntry[]) {
  const start = Math.max(0, Math.trunc(offset)), size = Math.max(1, Math.trunc(limit));
  for (;;) {
    const page = withVaultSnapshot(root, (db, revision) => feedPageIn(db, revision, start, size, source));
    if (page) return page;
    if (currentReadRevision(root)) throw new Error("Feed must be prepared before borrowing a read snapshot.");
    const record = sourceRecord(root), rows = build(record);
    publishReadModel(root, record.revision, db => {
      db.run("DELETE FROM read_feed");
      const insert = db.query("INSERT INTO read_feed(position, source, row_json) VALUES (?,?,?)");
      rows.forEach((row, i) => insert.run(i, row.source?.toLowerCase() ?? null, JSON.stringify(row)));
      db.query("INSERT OR REPLACE INTO meta(k,v) VALUES ('feed_revision',?)").run(record.revision);
    });
  }
}

/** Indexed note reads do not hydrate the graph's corpus. All joins, identity
 * policy and grounding sources are read inside the same SQLite transaction. */
function decoded<T>(db: Database, sql: string, ...params: string[]): T[] {
  return (db.query(sql).all(...params) as { event_json: string }[]).map(r => JSON.parse(r.event_json));
}
function aliasesIn(db: Database): EntityAliasResolution {
  return entityAliasResolution(aliasDeclarationsIn(db));
}
/** Every retraction, oldest first. */
function retractionsIn(db: Database): Retraction[] {
  return (db.query("SELECT id, retracts, superseded_by, reason, created_at FROM retractions ORDER BY created_at, id").all() as
    { id: AssertionId; retracts: AssertionId; superseded_by: AssertionId | null; reason: string; created_at: string }[])
    .map(({ superseded_by, ...r }) => ({ ...r, ...(superseded_by ? { superseded_by } : {}) }));
}
/** The is-source identities, oldest first; `standing` passes over the retracted. */
function bindingsIn(db: Database, standing: boolean): Binding[] {
  return (db.query(`SELECT id, entity_id, entity_label, a AS insertion_id, created_at FROM identities
    WHERE says = 'is-source'${standing ? " AND retracted_by IS NULL" : ""} ORDER BY created_at, id`).all() as
    { id: AssertionId; entity_id: EntityId; entity_label: string; insertion_id: InsertionId; created_at: string }[])
    .map((r) => ({ id: r.id, entity: { id: r.entity_id, label: r.entity_label }, insertion_id: r.insertion_id, created_at: r.created_at }));
}
/** Each entity's standing bindings, one per pair: the latest. */
function entitySourcesIn(db: Database): Binding[] {
  const latest = new Map<string, Binding>();
  for (const binding of bindingsIn(db, true)) { const key = `${binding.entity.id}\u0000${binding.insertion_id}`; latest.delete(key); latest.set(key, binding); }
  return [...latest.values()];
}
/** Every binding ever declared, retracted ones too: a pair the bulk pass
 * never decides again (lib/entitySourceSeed.ts). */
export function declaredEntitySources(root: string): Binding[] {
  return withVaultSnapshot(root, (db) => bindingsIn(db, false));
}
function sourcesFor(db: Database, rows: readonly AssertionEvent[]): Map<string, SourceMetadata> {
  const ids = [...new Set(rows.flatMap(row => assertionSourceReferences(row).map(ref => ref.insertion_id)))];
  return new Map(decoded<SourceMetadata>(db, "SELECT header_json AS event_json FROM sources WHERE present = 1 AND insertion_id IN (SELECT value FROM json_each(?))", JSON.stringify(ids)).map(s => [s.id, s]));
}
export function entityReadModel(root: string, asked: string) {
  return withVaultSnapshot(root, (db, revision) => {
    const aliases = aliasesIn(db), id = aliases.canonical.get(asked)?.id ?? asked;
    const ids = [id, ...[...aliases.canonical].filter(([, entity]) => entity.id === id).map(([alias]) => alias)];
    const rows = decoded<AssertionEvent>(db, `SELECT DISTINCT a.event_json, a.created_at, a.id
      FROM assertion_entities ae JOIN assertions a ON a.id = ae.assertion_id
      WHERE ae.entity_id IN (SELECT value FROM json_each(?)) AND a.revoked_by IS NULL AND ${liveAssertionSql("a")}
      ORDER BY a.created_at, a.id`, JSON.stringify(ids));
    const declarations = identityAssertions(db);
    const sources = sourcesFor(db, [...rows, ...declarations]);
    const bound = boundSources(db, ids);
    // the copies the bound sources belong to, best first, an unbound copy included
    const groups = copyGroupsIn(db, bound.map((source) => source.id), linksIn(db, revision, root));
    const documents = bound.map((source) => groups.get(source.id)).find((c) => c)?.members ?? bound;
    return { revision, id, aliases, rows, sources, bound: documents, owner: userIdentityDeclarationsFromEvents(declarations, sources).at(-1) };
  });
}
/** The sources an entity IS (lib/entitySourceLog.ts), bound under any of its
 * ids, newest first, as the graph's `opens` orders them. A binding to a
 * superseded landing follows its source's live one. */
function boundSources(db: Database, ids: readonly string[]): SourceMetadata[] {
  const bound = entitySourcesIn(db).filter(event => ids.includes(event.entity.id)).map(event => event.insertion_id);
  if (!bound.length) return [];
  return decoded<SourceMetadata>(db, `SELECT DISTINCT s.header_json AS event_json FROM sources b
    JOIN sources s ON s.present = 1 AND s.source_id = b.source_id
    WHERE b.present = 1 AND b.insertion_id IN (SELECT value FROM json_each(?)) AND ${liveSourceSql("s")}
      AND (s.insertion_id = b.insertion_id OR NOT ${liveSourceSql("b")})`, JSON.stringify(bound))
    .sort((a, b) => sourceMoment(b).localeCompare(sourceMoment(a)) || a.id.localeCompare(b.id));
}
export function sourceAssertionReadModel(root: string, ids: readonly string[]) {
  return withVaultSnapshot(root, db => {
    const rows = decoded<AssertionEvent>(db,
    `SELECT DISTINCT a.event_json, a.created_at, a.id FROM assertion_sources x JOIN assertions a ON a.id = x.assertion_id
      WHERE x.insertion_id IN (SELECT value FROM json_each(?)) AND a.revoked_by IS NULL ORDER BY a.created_at, a.id`, JSON.stringify(ids));
    return { aliases: aliasesIn(db), rows, sources: sourcesFor(db, rows) };
  });
}
export function projectedSource(root: string, id: string): SourceInsertion | undefined {
  return withVaultSnapshot(root, db => decoded<SourceInsertion>(db, "SELECT event_json FROM sources JOIN source_documents USING (insertion_id) WHERE present = 1 AND insertion_id = ?", id)[0]);
}

/** A note as the notes door projected it, with when it last changed there
 * (its stamp's mtime): what a read serves instead of the file. */
export function projectedMarkdownContent(root: string, path: string): { raw: string; mtimeMs: number } | undefined {
  return withVaultSnapshot(root, db => {
    const row = db.query("SELECT b.document_json, d.stamp FROM markdown_bodies b JOIN markdown_documents d USING (path) WHERE b.path = ?")
      .get(path) as { document_json: string; stamp: string } | null;
    if (!row) return undefined;
    const mtimeNs = Number(row.stamp.split(":").at(-2));
    return { raw: (JSON.parse(row.document_json) as MarkdownDocument).body, mtimeMs: Number.isFinite(mtimeNs) ? mtimeNs / 1e6 : 0 };
  });
}

/** The notes the projection holds under these trees, by path. */
export function projectedMarkdownPaths(root: string, trees: readonly string[]): string[] {
  return withVaultSnapshot(root, db => (db.query(`SELECT path FROM markdown_documents
    WHERE ${trees.map(() => "path LIKE ? || '/%'").join(" OR ") || "0"} ORDER BY path`).all(...trees) as { path: string }[]).map((r) => r.path));
}

/** Whether a landing is in the log as the projection last saw it. */
export const projectedSourcePresent = (root: string, id: string): boolean =>
  withVaultSnapshot(root, db => !!db.query("SELECT 1 FROM sources WHERE insertion_id = ? AND present = 1").get(id));

export function projectedMarkdown(root: string, path: string): string | undefined {
  return withVaultSnapshot(root, db => {
    const row = db.query("SELECT document_json FROM markdown_bodies WHERE path = ?").get(path) as { document_json: string } | null;
    return row ? (JSON.parse(row.document_json) as MarkdownDocument).body : undefined;
  });
}

/** Membership order and aliases are published with source metadata. Hydrate
 * from the caller's existing metadata map, without opening source bodies. */
function threadsIn<T extends SourceMetadata>(db: Database, sources: ReadonlyMap<string, T>): SourceThread<T>[] {
  const threads = decoded<Omit<SourceThread<T>, "members">>(db, "SELECT thread_json AS event_json FROM read_threads ORDER BY rowid");
  const members = new Map<string, T[]>();
  for (const row of db.query("SELECT thread_id, insertion_id FROM read_thread_members ORDER BY thread_id, position").all() as { thread_id: string; insertion_id: string }[]) {
    const source = sources.get(row.insertion_id);
    if (source) { const items = members.get(row.thread_id) ?? []; items.push(source); members.set(row.thread_id, items); }
  }
  return threads.map(t => ({ ...t, members: members.get(t.id) ?? [] }));
}
function threadIn<T extends SourceMetadata>(db: Database, key: string, byInsertion: boolean, bodies: boolean): SourceThread<T> | undefined {
  const lookup = byInsertion ? "read_thread_members WHERE insertion_id" : "read_thread_paths WHERE path";
  const thread = decoded<Omit<SourceThread<T>, "members">>(db,
    `SELECT thread_json AS event_json FROM read_threads WHERE id = (SELECT thread_id FROM ${lookup} = ?)`, key)[0];
  if (!thread) return;
  const members = decoded<T>(db, `SELECT ${bodies ? "d.event_json" : "s.header_json"} AS event_json FROM read_thread_members m
    JOIN sources s ON s.insertion_id = m.insertion_id
    ${bodies ? "JOIN source_documents d ON d.insertion_id = m.insertion_id" : ""} WHERE m.thread_id = ? ORDER BY m.position`, thread.id);
  if (byInsertion && members.length < 2) return;
  return { ...thread, members };
}
export function threadReadModel(root: string, key: string, byInsertion = false): SourceThread | undefined {
  return withVaultSnapshot(root, db => threadIn<SourceInsertion>(db, key, byInsertion, true));
}
export function sourceCatalog(root: string) {
  return withVaultSnapshot(root, (db, revision) => {
    const held = decodedRevision(root, revision);
    if (held.catalog) return held.catalog;
    const sources = decoded<SourceMetadata>(db, `SELECT header_json AS event_json FROM sources s
      WHERE present = 1 AND ${liveSourceSql("s")} ORDER BY coalesce(received_at, occurred_at, ''), insertion_id`);
    return held.catalog = { sources, threads: threadsIn(db, new Map(sources.map(s => [s.id, s]))) };
  });
}
/** Small mutations resolve only their selected paths, before any provider call. */
export function sourceReadTargets(root: string, paths: readonly string[]): Map<string, SourceMetadata[]> {
  return withVaultSnapshot(root, db => new Map(paths.flatMap(path => {
    const thread = threadIn<SourceMetadata>(db, path, false, false);
    if (thread) return [[path, thread.members] as const];
    const id = path.slice(path.lastIndexOf("/") + 1, -5);
    const source = decoded<SourceMetadata>(db, `SELECT header_json AS event_json FROM sources s
      WHERE insertion_id = ? AND present = 1 AND ${liveSourceSql("s")}`, id)[0];
    return source && insertionEventRel(source) === path ? [[path, [source]] as const] : [];
  })));
}
export function entityExists(root: string, asked: string): boolean {
  return withVaultSnapshot(root, db => {
    const id = (db.query("SELECT entity_id FROM entity_aliases WHERE alias_id = ?").get(asked) as { entity_id: string } | null)?.entity_id ?? asked;
    return Boolean(db.query(`SELECT 1 FROM assertion_entities ae JOIN assertions a ON a.id = ae.assertion_id
      WHERE ae.entity_id IN (SELECT ? UNION ALL SELECT alias_id FROM entity_aliases WHERE entity_id = ?)
        AND a.revoked_by IS NULL AND ${liveAssertionSql("a")} LIMIT 1`).get(id, id));
  });
}

function identityAssertions(db: Database): AssertionEvent[] {
  return decoded<AssertionEvent>(db, `SELECT event_json FROM assertions WHERE author_kind = 'user' AND revoked_by IS NULL
    AND json_extract(production_json, '$.procedure') = ? AND json_extract(production_json, '$.version') = ?
    ORDER BY created_at, id`, USER_IDENTITY_PROCEDURE, USER_IDENTITY_VERSION);
}
/** The owner's identity declarations, at a snapshot. */
export function userIdentityOf({ db }: Snapshot) {
  const rows = identityAssertions(db);
  return userIdentityDeclarationsFromEvents(rows, sourcesFor(db, rows));
}
export function identityReadModel(root: string) {
  return withSnapshot(root, userIdentityOf);
}
const voiceWhere = "present = 1 AND envelope_kind IN (SELECT value FROM json_each(?))";
export function voiceReadModel(root: string, keys: ReadonlySet<string>) {
  return withVaultSnapshot(root, db => {
    const headers = decoded<SourceMetadata>(db, `SELECT header_json AS event_json FROM sources WHERE ${voiceWhere}`, JSON.stringify(VOICE_KINDS));
    const ids = headers.filter(s => aboutIds(s.envelope).some(id => keys.has(id))).map(s => s.id);
    const voice = decoded<SourceInsertion>(db, `SELECT event_json FROM sources JOIN source_documents USING (insertion_id) WHERE insertion_id IN (SELECT value FROM json_each(?))
      ORDER BY coalesce(received_at, occurred_at, ''), insertion_id`, JSON.stringify(ids));
    const settled = new Map<string, string>();
    for (const event of voice) {
      if (db.query("SELECT 1 FROM assertion_sources WHERE insertion_id = ? LIMIT 1").get(event.id)) settled.set(event.id, "absorbed");
      else if (db.query("SELECT 1 FROM declines WHERE insertion_id = ? AND retracted_by IS NULL LIMIT 1").get(event.id)) settled.set(event.id, "declined");
    }
    return { voice, settled };
  });
}
/** A run needs every event id, but source bodies only for the user's voice.
 * All four input kinds and their checkpoint come from this one revision. */
export function memoryReadModel(root: string) {
  return withVaultSnapshot(root, (db, revision) => {
    const held = decodedRevision(root, revision);
    return held.memory ??= {
      inss: decoded<SourceMetadata>(db, "SELECT header_json AS event_json FROM sources WHERE present = 1 ORDER BY coalesce(received_at, occurred_at, ''), insertion_id"),
      asserted: decoded<AssertionEvent>(db, "SELECT event_json FROM assertions ORDER BY created_at, id"),
      voice: decoded<SourceInsertion>(db, `SELECT event_json FROM sources JOIN source_documents USING (insertion_id) WHERE ${voiceWhere} ORDER BY coalesce(received_at, occurred_at, ''), insertion_id`, JSON.stringify(VOICE_KINDS)),
      revocations: retractionsIn(db),
      aliases: aliasDeclarationsIn(db),
    };
  });
}
