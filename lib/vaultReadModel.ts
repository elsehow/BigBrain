/** The shared, versioned read model. Only reconciliation reads event files;
 * consumers borrow a complete SQLite snapshot and reuse its decoded records.
 * Filesystem notifications are hints; a periodic census repairs missed ones. */
import type { SourceSummary } from "./sourceSummary";
import { USER_IDENTITY_PROCEDURE, USER_IDENTITY_VERSION, userIdentityDeclarationsFromEvents } from "./userIdentityPolicy";
import type { MarkdownDocument, MarkdownIdentity, ParsedDocumentLinks } from "./markdownGraph";
import { assertionDbPath, openAssertionProjectionReadonly, projectionRevision, syncAssertionProjection } from "./assertionProjection";
import { entityAliasResolution, type EntityAliasEvent, type EntityAliasResolution } from "./entityAliasLog";
import { assertionSourceReferences, type AssertionEvent } from "./assertionLog";
import { latestEntitySourceDeclarations, type EntitySourceEvent } from "./entitySourceLog";
import { insertionEventRel, sourceMoment, type SourceInsertion, type SourceMetadata } from "./insertionLog";
import type { RevocationEvent } from "./revocationLog";
import { withProjectionWrite } from "./projectionWriteLock";
import type { RecentEntry } from "./viewTypes";
import { threadsByInsertion, type SourceThread } from "./sourceThreads";
import { supersededInsertionIds, liveAssertionSql, liveSourceSql } from "./sourceSupersede";
import { copyCandidates, copyCutoff, foldCopyEvents, PROPOSE_FLOOR, sourceCopies, type CopyWhy, type SourceCopies } from "./sourceCopies";
import { copyPairKey, type SourceCopyEvent } from "./sourceCopyLog";
import { STUB_CHARS } from "./text";
import { aboutIds, VOICE_KINDS } from "./voiceFacts";
import { markVaultChanged, vaultChangeVersion } from "./vaultChanges";
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
  documentLinks: Map<string, ParsedDocumentLinks>;
  rows: AssertionEvent[];
  aliases: EntityAliasResolution;
  /** The latest entity↔source declaration per pair (lib/entitySourceLog.ts),
   * oldest first; `bound: false` ones are unbindings. */
  entitySources: EntitySourceEvent[];
  /** Copies of one document (lib/sourceCopies.ts), by insertion id. */
  copies: Map<string, SourceCopies<SourceSummary>>;
  revoked: Map<string, RevocationEvent>;
}
const reconciled = new Map<string, { change: number; at: number }>();
interface DecodedRevision {
  revision: string;
  record?: VaultRecord;
  sources?: SourceRecord;
  copies?: CopiesRecord;
  catalog?: { sources: SourceMetadata[]; threads: SourceThread<SourceMetadata>[] };
  memory?: { inss: SourceMetadata[]; asserted: AssertionEvent[]; voice: SourceInsertion[];
    revocations: RevocationEvent[]; aliases: EntityAliasEvent[] };
}
const records = new Map<string, DecodedRevision>();
function decodedRevision(root: string, revision: string): DecodedRevision {
  const held = records.get(root);
  if (held?.revision === revision) return held;
  // One bounded owner for decoded views; revision changes invalidate all of them.
  if (!records.has(root) && records.size >= 4) { const oldest = records.keys().next().value!; records.delete(oldest); reconciled.delete(oldest); }
  const next = { revision }; records.set(root, next); return next;
}
const reading = new Map<string, { db: Database; revision: string }>();
export const currentReadRevision = (root: string): string | undefined => reading.get(root)?.revision;

export function invalidateVaultReadModel(root: string): void {
  markVaultChanged(root); // A pending background census must not consume this hint.
  reconciled.delete(root);
}

/** One fallback clock for synchronous readers and background preparation. */
export function vaultReconciliationDue(root: string): boolean {
  if (reading.has(root)) return false;
  const held = reconciled.get(root);
  return !held || held.change !== vaultChangeVersion(root) || Date.now() - held.at >= 1000;
}

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

/** A background census satisfies the same clock only if no local hint or
 * projection publication superseded it while it ran. */
export function acceptReadModelRevision(root: string, revision: string, change: number): boolean {
  if (change !== vaultChangeVersion(root) || revision !== readModelRevision(root)) return false;
  reconciled.set(root, { change, at: Date.now() });
  return true;
}

/** Local appends and watcher hints reconcile immediately. External writers
 * are also discovered without a working watcher, within one second. The
 * callback is synchronous; nested readers borrow the same transaction. */
export function withVaultSnapshot<T>(root: string, read: (db: Database, revision: string) => T): T {
  const active = reading.get(root);
  if (active) return read(active.db, active.revision);
  if (vaultReconciliationDue(root)) {
    const change = vaultChangeVersion(root);
    syncAssertionProjection(root);
    reconciled.set(root, { change, at: Date.now() });
  }
  let db: Database;
  try { db = openAssertionProjectionReadonly(root); }
  catch { invalidateVaultReadModel(root); syncAssertionProjection(root); db = openAssertionProjectionReadonly(root); }
  try {
    db.run("BEGIN");
    const revision = projectionRevision(root, db);
    if (!revision || db.query("SELECT 1 FROM meta WHERE k = 'threads_dirty'").get()) {
      db.run("ROLLBACK");
      invalidateVaultReadModel(root);
      syncAssertionProjection(root);
      return withVaultSnapshot(root, read);
    }
    reading.set(root, { db, revision });
    try { return read(db, revision); } finally { reading.delete(root); }
  } finally { if (db.inTransaction) db.run("ROLLBACK"); db.close(); }
}

/** A feed miss needs neither assertion prose nor Markdown/link evidence.
 * The graph reuses these same objects when it needs the rest of the corpus. */
export function sourceRecord(root: string): SourceRecord {
  return withVaultSnapshot(root, (db, revision) => {
    const held = decodedRevision(root, revision);
    if (held.sources) return held.sources;
    const sources = new Map((db.query("SELECT header_json, excerpt, intake_priority FROM sources WHERE present = 1 ORDER BY coalesce(received_at, occurred_at, ''), insertion_id").all() as
      { header_json: string; excerpt: string; intake_priority: number | null }[]).map(row => {
        const source: SourceSummary = { ...JSON.parse(row.header_json), excerpt: row.excerpt, intakePriority: row.intake_priority };
        return [source.id, source];
      }));
    const ids = (sql: string) => new Set((db.query(sql).all() as { insertion_id: string }[]).map(row => row.insertion_id));
    const declined = ids("SELECT DISTINCT insertion_id FROM declines");
    // Withdrawal alone never makes an arrival pending again. A decline wins
    // only when no live assertion cites that arrival (sourceSettlement tests).
    const cited = ids(`SELECT DISTINCT x.insertion_id FROM assertion_sources x
      JOIN assertions a ON a.id = x.assertion_id
      WHERE a.revoked_by IS NULL OR NOT EXISTS (SELECT 1 FROM declines d WHERE d.insertion_id = x.insertion_id)`);
    const grouped = threadsIn(db, sources);
    return held.sources = { revision, sources, cited, declined, superseded: supersededInsertionIds(sources.values()),
      threads: new Map(grouped.flatMap(t => [t.path, ...t.aliases].map(path => [path, t] as const))),
      threadByInsertion: threadsByInsertion(grouped) };
  });
}

export function vaultRecord(root: string, reconcile = false): VaultRecord {
  if (reconcile) invalidateVaultReadModel(root);
  return withVaultSnapshot(root, (db, revision) => {
    const held = decodedRevision(root, revision);
    if (held.record) return held.record;
    const sources = sourceRecord(root);
    const rows = decoded<AssertionEvent>(db, "SELECT event_json FROM assertions WHERE revoked_by IS NULL ORDER BY created_at, id");
    const revoked = new Map<string, RevocationEvent>();
    for (const event of decoded<RevocationEvent>(db, "SELECT event_json FROM revocations ORDER BY created_at, id"))
      if (!revoked.has(event.assertion_id)) revoked.set(event.assertion_id, event);
    const aliases = aliasesIn(db);
    const entitySources = entitySourcesIn(db);
    const documents = (db.query("SELECT header_json AS document_json FROM markdown_documents ORDER BY path").all() as { document_json: string }[]).map(r => JSON.parse(r.document_json) as MarkdownIdentity);
    const documentLinks = new Map((db.query("SELECT path, links_json, citations_json FROM document_links").all() as { path: string; links_json: string; citations_json: string }[])
      .map(r => [r.path, { links: JSON.parse(r.links_json), citations: JSON.parse(r.citations_json) } as ParsedDocumentLinks]));
    return held.record = { ...sources, documents, documentLinks, rows, aliases, entitySources, copies: sourceCopiesRecord(root), revoked };
  });
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

/** Copies of one document (lib/sourceCopies.ts) over live arrivals outside
 * mail threads. Exact keys, an entity binding (a superseded landing followed
 * to its live one, as the graph does), a person's "same" and a judgment at or
 * above the cut-off link a pair; a person's "not the same" cuts it. */
function copiesRecord(root: string): CopiesRecord {
  return withVaultSnapshot(root, (db, revision) => {
    const held = decodedRevision(root, revision);
    if (held.copies) return held.copies;
    const { sources, superseded, threadByInsertion } = sourceRecord(root);
    const aliases = aliasesIn(db);
    const live = new Map<string, string>();
    for (const source of sources.values()) if (!superseded.has(source.id)) live.set(source.source_id, source.id);
    const joins = new Map<string, string[]>();
    for (const binding of entitySourcesIn(db)) {
      const landed = binding.bound ? sources.get(binding.insertion_id) : undefined;
      const id = landed && (superseded.has(landed.id) ? live.get(landed.source_id) : landed.id);
      if (id) joins.set(id, [...(joins.get(id) ?? []), `entity:${(aliases.canonical.get(binding.entity.id) ?? binding.entity).id}`]);
    }
    const said = foldCopyEvents(decoded<SourceCopyEvent>(db, "SELECT event_json FROM source_copy_events"));
    const cutoff = copyCutoff(said);
    const pair = (key: string): [string, string] => key.split("|") as [string, string];
    const pairs: [string, string, CopyWhy][] = [];
    for (const [key, same] of said.declared) if (same) pairs.push([...pair(key), "you"]);
    for (const [key, j] of said.judged) if (j.score >= cutoff && !said.declared.has(key)) pairs.push([...pair(key), "judged"]);
    const prose = db.query("SELECT prose_chars FROM sources WHERE insertion_id = ?");
    const works = [...sources.values()].filter((s) => !superseded.has(s.id) && !threadByInsertion.has(s.id));
    const groups = sourceCopies(works, {
      joins, pairs, apart: (a, b) => said.declared.get(copyPairKey(a, b)) === false,
      stub: (source) => ((prose.get(source.id) as { prose_chars: number } | null)?.prose_chars ?? 0) < STUB_CHARS,
    });
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
  });
}

/** Copies of one document (lib/sourceCopies.ts), by insertion id. */
export const sourceCopiesRecord = (root: string): Map<string, SourceCopies<SourceSummary>> => copiesRecord(root).groups;

/** The pairs still to settle that a source's document is part of. */
export const copyProposals = (root: string, insertionId: string): CopyProposal[] => copiesRecord(root).proposals.get(insertionId) ?? [];

/** Candidates for the judging pass (lib/sourceCopyJudge.ts). */
export const unjudgedCopies = (root: string): [string, string][] => copiesRecord(root).unjudged;

/** A source's other copies, best first; none when it has none. */
export function otherCopies(root: string, insertionId: string): SourceSummary[] {
  return (sourceCopiesRecord(root).get(insertionId)?.members ?? []).filter((copy) => copy.id !== insertionId);
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
  return entityAliasResolution(decoded<EntityAliasEvent>(db, "SELECT event_json FROM entity_alias_events"));
}
function entitySourcesIn(db: Database): EntitySourceEvent[] {
  return latestEntitySourceDeclarations(decoded<EntitySourceEvent>(db, "SELECT event_json FROM entity_source_events"));
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
    const documents = bound.map((source) => sourceCopiesRecord(root).get(source.id)).find((c) => c)?.members ?? bound;
    return { revision, id, aliases, rows, sources, bound: documents, owner: userIdentityDeclarationsFromEvents(declarations, sources).at(-1) };
  });
}
/** The sources an entity IS (lib/entitySourceLog.ts), bound under any of its
 * ids, newest first, as the graph's `opens` orders them. A binding to a
 * superseded landing follows its source's live one. */
function boundSources(db: Database, ids: readonly string[]): SourceMetadata[] {
  const bound = entitySourcesIn(db).filter(event => event.bound && ids.includes(event.entity.id)).map(event => event.insertion_id);
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
export function identityReadModel(root: string) {
  return withVaultSnapshot(root, db => {
    const rows = identityAssertions(db);
    return userIdentityDeclarationsFromEvents(rows, sourcesFor(db, rows));
  });
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
      else if (db.query("SELECT 1 FROM declines WHERE insertion_id = ? LIMIT 1").get(event.id)) settled.set(event.id, "declined");
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
      revocations: decoded<RevocationEvent>(db, "SELECT event_json FROM revocations ORDER BY created_at, id"),
      aliases: decoded<EntityAliasEvent>(db, "SELECT event_json FROM entity_alias_events ORDER BY json_extract(event_json, '$.created_at'), id"),
    };
  });
}
