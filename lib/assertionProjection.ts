/** Disposable incremental SQLite projection over insertion + assertion logs. */
import { sourceSummary } from "./sourceSummary";
import { markdownInventory, markdownDocument, readMarkdownNote, parseDocumentLinks, type ParsedDocumentLinks } from "./markdownGraph";
import { savedClaudeModel } from "./sourceModel";

import { Database } from "bun:sqlite";
import { searchMatch as matchQuery, searchAlternatives, searchTerms as matchTerms } from "./searchQuery";
import { searchNames } from "./searchNames";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { parseEventFile, type EventFile } from "./eventLog";
import { sha256hex } from "./hash";
import { proseChars } from "./text";
import { norm } from "./ids";
import { classifyIntake } from "./intakeClass";
import {
  appendAssertionEvent,
  assertionSourceReferences,
  listAssertionEventFiles,
  validateAssertionEvent,
  validateAssertionEvidence,
  type AssertionEntity,
  type AssertionEvent,
  type AssertionSourceReference,
} from "./assertionLog";
import {
  listSourceInsertionEventFiles,
  validateSourceInsertion,
  type SourceInsertion,
} from "./insertionLog";
import { liveAssertionSql, liveSourceSql, supersedesOf } from "./sourceSupersede";
import {
  appendDeclineEvent,
  listDeclineEventFiles,
  validateDeclineEvent,
  type DeclineEvent,
} from "./declineLog";
import {
  appendEntityAliasEvent,
  entityAliasResolution,
  listEntityAliasEventFiles,
  validateEntityAliasEvent,
  type EntityAliasEvent,
} from "./entityAliasLog";
import {
  appendEntitySourceEvent,
  listEntitySourceEventFiles,
  validateEntitySourceEvent,
  type EntitySourceEvent,
} from "./entitySourceLog";
import {
  appendSourceCopyEvent,
  listSourceCopyEventFiles,
  validateSourceCopyEvent,
  type SourceCopyEvent,
} from "./sourceCopyLog";
import type { LabelRow } from "./entityLookalikes";
import { assertionDb } from "./env";
import {
  appendRevocationEvent,
  listRevocationEventFiles,
  validateRevocationEvent,
  type RevocationEvent,
} from "./revocationLog";
import { sourceThreads } from "./sourceThreads";
import type { SourceMetadata } from "./insertionLog";
import { withProjectionWrite } from "./projectionWriteLock";

// 7: sources.supersedes (lib/sourceSupersede.ts) — the read-side supersede.
// 8: deterministic revocation winners and indexed intake classification.
// 9 (2026-09-06): intake_priority ranks a transcript's owner's side
// (lib/intakeClass.ts intakePriority); the rebuild is what puts the
// already-landed sessions on the gardener's list.
// 10: materialized source headers keep search off the full event JSON.
// 15: atomic generations, shared feed rows, Markdown/link spans and source presence.
// 16: compact source metadata and transactionally published thread membership.
// 17: compact graph/feed summaries and link evidence; canonical Markdown titles.
// 18: entity↔source bindings (lib/entitySourceLog.ts).
// 19: judged and declared copies of one document (lib/sourceCopyLog.ts).
// 20: narrow apart from wide — source headers and arrival identity in
//     `sources`, each whole event once in `source_documents`; Markdown
//     headers in `markdown_documents`, documents in `markdown_bodies`.
// 21: the change log — what each revision changed, written in its commit
//     (docs/plans/2026-10-10-change-log.md).
// 22: saved views — read models kept by the viewer, each with its revision.
const SCHEMA_VERSION = "23";

export interface AssertionSearchHit {
  id: string;
  text: string;
  confidence: AssertionEvent["confidence"];
  created_at: string;
  score: number;
}

export interface AssertionEntityHit {
  id: string;
  label: string;
  assertions: number;
  score: number;
  /** The alias label the query met, when the entity's OWN label did not
   * match — "Ridgeways" for a hit that reads Auto-MAP (#728: a fold must
   * show it knows). Null when the label itself matched. */
  alias: string | null;
}

export interface ProjectedAssertionEntity {
  id: string;
  label: string;
  assertions: number;
  /** Labels the alias table folds into this entity (lib/entityAliasLog.ts). */
  aliases?: string[];
}

export interface AssertionSourceHit {
  insertion_id: string;
  source_id: string;
  title: string;
  score: number;
  // No snippet here: the window around the match is cut by sourceMatchWindows
  // for only the hits that reach a response. FTS5's snippet() in this select
  // ran for EVERY matching row under ORDER BY … LIMIT, re-tokenizing whole
  // transcripts — the omnibox's entire cost (2.1s for a one-letter prefix).
}

export interface AssertionProjectionStats {
  sources: number;
  assertions: number;
  entities: number;
  source_links: number;
}

export function assertionDbPath(root: string): string {
  return assertionDb() ?? join(root, ".state", "assertions.db");
}

function schema(db: Database): void {
  db.run("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  // What moved each revision, written in the same transaction that moved it:
  // the projection's commits as one ordered stream, for readers that want
  // what changed rather than that something did.
  // Read models the viewer keeps (lib/maintainedGraph.ts), each saved with the
  // revision it reflects, so a start serves the last one without a build.
  db.run("CREATE TABLE IF NOT EXISTS views (name TEXT PRIMARY KEY, revision TEXT NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL)");
  db.run(`CREATE TABLE IF NOT EXISTS changes (
    revision INTEGER NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, op TEXT NOT NULL,
    PRIMARY KEY (revision, kind, id)
  ) WITHOUT ROWID`);
  db.run("CREATE TABLE IF NOT EXISTS read_feed (position INTEGER PRIMARY KEY, source TEXT, row_json TEXT NOT NULL)");
  db.run("CREATE INDEX IF NOT EXISTS read_feed_source ON read_feed(source, position)");
  // Narrow apart from wide (schema 20): a header read never walks a body.
  // SQLite reads a row's columns in order through its overflow pages, so a
  // header stored beside a transcript costs the transcript; and a table of
  // headers alone stays small enough to read cold in one sequential pass.
  db.run("CREATE TABLE IF NOT EXISTS markdown_documents (path TEXT PRIMARY KEY, stamp TEXT NOT NULL, header_json TEXT NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS markdown_bodies (path TEXT PRIMARY KEY, document_json TEXT NOT NULL)");
  // A document's links, narrow: what each names, which the graph resolves at
  // every revision. The paragraph around each, its evidence, is wide (tens of
  // MB on a vault of mail) and read only by evidence builds (schema 23).
  db.run("CREATE TABLE IF NOT EXISTS document_links (path TEXT PRIMARY KEY, hash TEXT NOT NULL, links_json TEXT NOT NULL, citations_json TEXT NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS document_link_text (path TEXT PRIMARY KEY, texts_json TEXT NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS read_threads (id TEXT PRIMARY KEY, thread_json TEXT NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS read_thread_paths (path TEXT PRIMARY KEY, thread_id TEXT NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS read_thread_members (insertion_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, position INTEGER NOT NULL)");
  db.run("CREATE INDEX IF NOT EXISTS read_thread_order ON read_thread_members(thread_id, position)");
  db.run(`CREATE TABLE IF NOT EXISTS sources (
    insertion_id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    title TEXT NOT NULL,
    occurred_at TEXT,
    received_at TEXT,
    content_sha256 TEXT NOT NULL,
    header_json TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    present INTEGER NOT NULL DEFAULT 1,
    -- The envelope fields readers filter on — kind and source for search's
    -- candidates, the arrival identity (sha256, stream/key/seq) for dedup
    -- and revisions — materialized from the event once, at insert. No
    -- affinity: preserve json_extract's types for malformed envelopes too.
    envelope_kind,
    envelope_source,
    envelope_sha256,
    envelope_stream,
    envelope_key,
    envelope_seq,
    -- proseChars(body), so a stub test never reads the body (lib/text.ts).
    prose_chars INTEGER NOT NULL,
    -- The model a Claude Code conversation's attached transcript names
    -- (lib/sourceModel.ts), read from its blob once, here, rather than by
    -- every process that files the row (schema 23).
    transcript_model TEXT,
    supersedes TEXT,
    intake_class TEXT NOT NULL,
    intake_priority INTEGER,
    intake_at TEXT NOT NULL
  )`);
  // The whole insertion event, body included, stored once: what a note read,
  // an evidence check or a snippet opens, by id.
  db.run("CREATE TABLE IF NOT EXISTS source_documents (insertion_id TEXT PRIMARY KEY, event_json TEXT NOT NULL)");
  db.run("CREATE INDEX IF NOT EXISTS sources_kind ON sources(envelope_kind)");
  db.run("CREATE INDEX IF NOT EXISTS sources_source_id ON sources(source_id)");
  db.run(`CREATE INDEX IF NOT EXISTS sources_headers ON sources
    (insertion_id, source_id, title, occurred_at, received_at, envelope_kind, envelope_source)`);
  db.run("CREATE INDEX IF NOT EXISTS sources_intake ON sources(intake_priority, intake_at, insertion_id)");
  db.run("CREATE INDEX IF NOT EXISTS sources_sha256 ON sources(envelope_sha256)");
  db.run("CREATE INDEX IF NOT EXISTS sources_stream ON sources(envelope_stream, envelope_key)");
  // The read-side supersede (lib/sourceSupersede.ts): a later landing of the
  // same source naming this row hides it from every reader. Indexed because
  // the liveness predicate runs per candidate row on the search paths.
  db.run("CREATE INDEX IF NOT EXISTS sources_supersedes ON sources(supersedes)");
  // prefix='2 3': the omnibox prefix-matches every term ("re"*), and without
  // a prefix index a two-letter term walks the whole vocabulary — ~20ms over
  // 1,200 sources, 2ms with one. One-letter terms never reach this table
  // (searchCore gates body search at two letters), so no length-1 index.
  // Costs about half the table again on disk; schema 4 rebuilds for it.
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(
    insertion_id UNINDEXED, source_id, title, body, tokenize='unicode61', prefix='2 3'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS assertions (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    author_kind TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_invocation_id TEXT,
    confidence TEXT NOT NULL,
    created_at TEXT NOT NULL,
    production_json TEXT NOT NULL,
    event_json TEXT NOT NULL,
    supersedes TEXT,
    revoked_by TEXT,
    superseded_by TEXT
  )`);
  db.run("CREATE INDEX IF NOT EXISTS assertions_procedure ON assertions(author_kind, json_extract(production_json, '$.procedure'), json_extract(production_json, '$.version'))");
  db.run(`CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    normalized_label TEXT NOT NULL UNIQUE
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS assertion_entities (
    assertion_id TEXT NOT NULL REFERENCES assertions(id),
    entity_id TEXT NOT NULL REFERENCES entities(id),
    PRIMARY KEY(assertion_id, entity_id)
  )`);
  db.run("CREATE INDEX IF NOT EXISTS assertion_entities_entity ON assertion_entities(entity_id)");
  db.run(`CREATE TABLE IF NOT EXISTS assertion_sources (
    assertion_id TEXT NOT NULL REFERENCES assertions(id),
    insertion_id TEXT NOT NULL REFERENCES sources(insertion_id),
    source_id TEXT NOT NULL,
    PRIMARY KEY(assertion_id, insertion_id)
  )`);
  db.run("CREATE INDEX IF NOT EXISTS assertion_sources_source ON assertion_sources(source_id)");
  db.run("CREATE INDEX IF NOT EXISTS assertion_sources_insertion ON assertion_sources(insertion_id)");
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS assertion_fts USING fts5(
    id UNINDEXED, text, entity_labels, source_ids, tokenize='unicode61'
  )`);
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS entity_fts USING fts5(
    id UNINDEXED, label, tokenize='unicode61'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS declines (
    decline_id TEXT NOT NULL,
    insertion_id TEXT NOT NULL REFERENCES sources(insertion_id),
    source_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    event_json TEXT NOT NULL,
    PRIMARY KEY(decline_id, insertion_id)
  )`);
  db.run("CREATE INDEX IF NOT EXISTS declines_insertion ON declines(insertion_id)");
  // Entity aliases (lib/entityAliasLog.ts): the event census sync diffs
  // against, the FLAT resolved table one lookup answers through (every
  // entity_id in it is canonical), and an FTS over alias labels so "Evan"
  // still finds Evan Keller. Both derived tables are rewritten from the
  // census on every alias event — the fold is the one rule set.
  db.run(`CREATE TABLE IF NOT EXISTS entity_alias_events (
    id TEXT PRIMARY KEY,
    event_json TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS entity_aliases (
    alias_id TEXT PRIMARY KEY,
    alias TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    entity_label TEXT NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS entity_aliases_entity ON entity_aliases(entity_id)");
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS entity_alias_fts USING fts5(
    alias_id UNINDEXED, alias, tokenize='unicode61'
  )`);
  // Entity↔source bindings (lib/entitySourceLog.ts): the census alone. The
  // graph folds it (latest per pair) when it builds; there is no resolved
  // table to keep in step.
  db.run(`CREATE TABLE IF NOT EXISTS entity_source_events (
    id TEXT PRIMARY KEY,
    event_json TEXT NOT NULL
  )`);
  // Copies judged and declared (lib/sourceCopyLog.ts): the census alone,
  // folded latest-per-pair on read (lib/sourceCopyReview.ts).
  db.run(`CREATE TABLE IF NOT EXISTS source_copy_events (
    id TEXT PRIMARY KEY,
    event_json TEXT NOT NULL
  )`);
  // Revocations (lib/revocationLog.ts, #629): the census sync diffs against.
  // A revoked assertion keeps its `assertions` row — flagged, so its old id
  // still redirects — and loses its entity and FTS edges; its evidence
  // edges stay, so the insertions it settled stay settled.
  db.run(`CREATE TABLE IF NOT EXISTS revocations (
    id TEXT PRIMARY KEY,
    assertion_id TEXT NOT NULL,
    superseded_by TEXT,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    event_json TEXT NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS revocations_assertion ON revocations(assertion_id, created_at, id)");
}

/** Keep the database inode stable: readers in WAL transactions retain the
 * previous complete generation while schema replacement/replay commits. */
function open(root: string): Database {
  const path = assertionDbPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    const hasMeta = db.query("SELECT 1 FROM sqlite_master WHERE name = 'meta'").get();
    const current = hasMeta ? (db.query("SELECT v FROM meta WHERE k = 'schema'").get() as { v: string } | null)?.v : undefined;
    if (current !== SCHEMA_VERSION) db.transaction(() => {
      resetProjection(db);
      schema(db);
      db.query("INSERT INTO meta(k,v) VALUES ('schema',?), ('generation',?), ('revision','0')").run(SCHEMA_VERSION, crypto.randomUUID());
      // A schema upgrade publishes the replacement only after a full replay.
      if (current) reconcile(db, root);
    })();
    return db;
  } catch (error) { db.close(); throw error; }
}

function resetProjection(db: Database): void {
  db.run("PRAGMA defer_foreign_keys = ON");
  const tables = db.query("SELECT name FROM pragma_table_list WHERE schema = 'main' AND type IN ('table','virtual') AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  for (const { name } of tables) db.run(`DROP TABLE "${name.replaceAll('"', '""')}"`);
}

/** Query paths must remain usable inside a model's read-only sandbox. Schema
 * creation and WAL configuration belong to project/sync, never to reads. */
function openReadonly(root: string): Database {
  const path = assertionDbPath(root);
  if (!existsSync(path)) throw new Error("assertion-projection: projection is not built");
  const db = new Database(path, { readonly: true });
  db.run("PRAGMA busy_timeout = 5000");
  return db;
}

const encoded = (value: unknown): string => JSON.stringify(value);

/** What a revision changed: an event projected (`add`), a source retracted or
 * restored by hand (`remove`/`add`), a note created, edited or deleted, or a
 * run journal written (projectJournal). */
export type ChangeKind = "source" | "assertion" | "decline" | "revocation" | "alias" | "entity_source" | "copy" | "markdown" | "journal";
export interface ProjectionChange { revision: number; kind: ChangeKind; id: string; op: "add" | "edit" | "remove" }

/** Advance the revision and log what advanced it, in the caller's
 * transaction — the only way the revision moves, so the log is the commit
 * order: one revision per commit, every row of it named. */
function commitChanges(db: Database, changes: ReadonlyArray<Omit<ProjectionChange, "revision">>): void {
  if (!changes.length) return;
  db.run("UPDATE meta SET v = CAST(v AS INTEGER) + 1 WHERE k = 'revision'");
  const row = db.query("INSERT INTO changes(revision, kind, id, op) SELECT CAST(v AS INTEGER), ?, ?, ? FROM meta WHERE k = 'revision'");
  for (const { kind, id, op } of changes) row.run(kind, id, op);
}

/** Project one event exactly once, in a transaction. Every kind is the same
 * shape: the event's own table already holds its id or it does not; holding a
 * DIFFERENT event under an id already projected is a collision, because these
 * events are immutable; holding the same one is a replay and does nothing.
 * `insert` runs only for a genuinely new event and owns whatever else that
 * event implies — a decline's row per insertion, a revocation's edge sweep,
 * an alias refold. Returns whether the event was new. */
function insertOnce<T>(
  db: Database,
  kind: ChangeKind,
  table: string,
  idColumn: string,
  id: string,
  event: T,
  insert: (eventJson: string) => void
): boolean {
  const eventJson = encoded(event);
  let inserted = false;
  db.transaction(() => {
    const prior = db.query(`SELECT event_json FROM ${table} WHERE ${idColumn} = ? LIMIT 1`).get(id) as
      { event_json: string } | null;
    if (prior) {
      if (prior.event_json !== eventJson)
        throw new Error(`assertion-projection: immutable ${table} collision: ${id}`);
      return;
    }
    insert(eventJson);
    commitChanges(db, [{ kind, id, op: "add" }]);
    inserted = true;
  })();
  return inserted;
}

/** A document's links: what each names, narrow, and their evidence, wide. */
function writeDocumentLinks(db: Database, path: string, hash: string, parsed: ParsedDocumentLinks): void {
  db.query("INSERT OR REPLACE INTO document_links(path, hash, links_json, citations_json) VALUES (?,?,?,?)")
    .run(path, hash, JSON.stringify(parsed.links.map(({ target, markdown }) => ({ target, markdown }))), JSON.stringify(parsed.citations));
  db.query("INSERT OR REPLACE INTO document_link_text(path, texts_json) VALUES (?,?)").run(path, JSON.stringify(parsed.links.map((l) => l.text)));
}

function insertSourceRow(db: Database, source: SourceInsertion, root: string): boolean {
  const field = (key: string): string | undefined => typeof source.envelope[key] === "string" ? source.envelope[key] : undefined;
  const facts = { kind: field("kind"), type: field("type"), source: field("source") };
  const klass = classifyIntake(facts);
  // null is a record — the feed's word for the same row (lib/sourceFeed.ts)
  const { excerpt, intakePriority: priority, ...metadata } = sourceSummary(source);
  return insertOnce(db, "source", "source_documents", "insertion_id", source.id, source, (eventJson) => {
    db.query("INSERT INTO source_documents(insertion_id, event_json) VALUES (?, ?)").run(source.id, eventJson);
    db.query(`INSERT INTO sources(
      insertion_id, source_id, title, occurred_at, received_at, content_sha256, header_json, excerpt, prose_chars,
      supersedes, intake_class, intake_priority, intake_at, transcript_model,
      envelope_kind, envelope_source, envelope_sha256, envelope_stream, envelope_key, envelope_seq
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?15,
      json_extract(?14, '$.envelope.kind'), json_extract(?14, '$.envelope.source'), json_extract(?14, '$.envelope.sha256'),
      json_extract(?14, '$.envelope.stream'), json_extract(?14, '$.envelope.key'), json_extract(?14, '$.envelope.seq'))`).run(
      source.id, source.source_id, source.title, source.occurred_at ?? null, source.received_at ?? null,
      source.content_sha256, JSON.stringify(metadata), excerpt, proseChars(source.body),
      supersedesOf(source) ?? null, klass, priority, source.received_at ?? source.occurred_at ?? "", eventJson,
      source.envelope.source === "agent-chat" ? savedClaudeModel(root, source.envelope.attachments) ?? null : null
    );
    db.run("INSERT OR REPLACE INTO meta(k,v) VALUES ('threads_dirty','1')");
    db.query("INSERT INTO source_fts(insertion_id, source_id, title, body) VALUES (?, ?, ?, ?)")
      .run(source.id, source.source_id, source.title, source.body);
    writeDocumentLinks(db, `source:${source.id}`, source.content_sha256,
      parseDocumentLinks({ id: source.id, path: "", title: source.title, body: source.body }));
  });
}

/** Incrementally add one immutable lake insertion. No log walk or rebuild. */
export function projectSourceInsertion(root: string, source: SourceInsertion): boolean {
  return withProjectionWrite(root, () => {
    const db = open(root);
    try { return insertSourceRow(db, source, root); }
    finally { db.close(); }
  });
}

function referencedSources(db: Database, event: AssertionEvent): Map<string, SourceInsertion> {
  const sources = new Map<string, SourceInsertion>();
  for (const insertionId of new Set(assertionSourceReferences(event).map((ref) => ref.insertion_id))) {
    const row = db.query("SELECT event_json FROM source_documents WHERE insertion_id = ?").get(insertionId) as { event_json: string } | null;
    if (!row) throw new Error(`assertion-projection: cited insertion is not projected: ${insertionId}`);
    sources.set(insertionId, JSON.parse(row.event_json) as SourceInsertion);
  }
  return sources;
}

function insertAssertionRow(db: Database, event: AssertionEvent): boolean {
  validateAssertionEvidence(event, referencedSources(db, event));
  return insertOnce(db, "assertion", "assertions", "id", event.id, event, (eventJson) => {
    db.query(`INSERT INTO assertions(
      id, text, author_kind, author_id, author_invocation_id, confidence, created_at, production_json, event_json,
      supersedes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      event.id, event.text, event.author.kind, event.author.id,
      event.author.kind === "model" ? event.author.invocation_id ?? null : null,
      event.confidence, event.created_at, encoded(event.produced_by), eventJson, event.supersedes ?? null
    );
    for (const entity of event.entities) {
      const normalized = norm(entity.label);
      const prior = db.query("SELECT label, normalized_label FROM entities WHERE id = ?").get(entity.id) as
        { label: string; normalized_label: string } | null;
      if (prior && prior.normalized_label !== normalized)
        throw new Error(`assertion-projection: entity label collision: ${entity.id}`);
      if (!prior) {
        db.query("INSERT INTO entities(id, label, normalized_label) VALUES (?, ?, ?)")
          .run(entity.id, entity.label, normalized);
        db.query("INSERT INTO entity_fts(id, label) VALUES (?, ?)").run(entity.id, entity.label);
      }
      db.query("INSERT INTO assertion_entities(assertion_id, entity_id) VALUES (?, ?)").run(event.id, entity.id);
    }
    const refs = assertionSourceReferences(event);
    for (const ref of new Map(refs.map((value) => [value.insertion_id, value])).values()) {
      db.query(`INSERT INTO assertion_sources(assertion_id, insertion_id, source_id)
        VALUES (?, ?, ?)`).run(event.id, ref.insertion_id, ref.source_id);
    }
    db.query("INSERT INTO assertion_fts(id, text, entity_labels, source_ids) VALUES (?, ?, ?, ?)").run(
      event.id, event.text, event.entities.map((entity) => entity.label).join(" "),
      refs.map((ref) => ref.source_id).join(" ")
    );
  });
}

function insertDeclineRow(db: Database, event: DeclineEvent): boolean {
  validateDeclineEvent(event);
  for (const ref of event.insertions) {
    const held = db.query("SELECT insertion_id FROM sources WHERE insertion_id = ?").get(ref.insertion_id);
    if (!held) throw new Error(`assertion-projection: declined insertion is not projected: ${ref.insertion_id}`);
  }
  return insertOnce(db, "decline", "declines", "decline_id", event.id, event, (eventJson) => {
    for (const ref of event.insertions) {
      db.query(`INSERT INTO declines(decline_id, insertion_id, source_id, reason, created_at, event_json)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        event.id, ref.insertion_id, ref.source_id, event.reason, event.created_at, eventJson
      );
    }
  });
}

// ── revocations ─────────────────────────────────────────────────────────────

function insertRevocationRow(db: Database, event: RevocationEvent): boolean {
  validateRevocationEvent(event);
  const target = db.query("SELECT revoked_by FROM assertions WHERE id = ?").get(event.assertion_id) as
    { revoked_by: string | null } | null;
  if (!target) throw new Error(`assertion-projection: revoked assertion is not projected: ${event.assertion_id}`);
  if (event.superseded_by && !db.query("SELECT 1 FROM assertions WHERE id = ?").get(event.superseded_by))
    throw new Error(`assertion-projection: superseding assertion is not projected: ${event.superseded_by}`);
  return insertOnce(db, "revocation", "revocations", "id", event.id, event, (eventJson) => {
    db.query(`INSERT INTO revocations(id, assertion_id, superseded_by, reason, created_at, event_json)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      event.id, event.assertion_id, event.superseded_by ?? null, event.reason, event.created_at, eventJson
    );
    // Earliest event time, then id: the log reader's rule, independent of
    // arrival order or the filename order used by a rebuild.
    const winner = db.query(`SELECT id, superseded_by FROM revocations
      WHERE assertion_id = ? ORDER BY created_at, id LIMIT 1`).get(event.assertion_id) as
      { id: string; superseded_by: string | null };
    db.query("UPDATE assertions SET revoked_by = ?, superseded_by = ? WHERE id = ?")
      .run(winner.id, winner.superseded_by, event.assertion_id);
    if (target.revoked_by) return; // the evidence edges were already removed
    const linked = (db.query("SELECT entity_id FROM assertion_entities WHERE assertion_id = ?")
      .all(event.assertion_id) as { entity_id: string }[]).map((row) => row.entity_id);
    db.query("DELETE FROM assertion_entities WHERE assertion_id = ?").run(event.assertion_id);
    db.query("DELETE FROM assertion_fts WHERE id = ?").run(event.assertion_id);
    // An entity nothing live links any more is gone from the record: its
    // label is unclaimed again (the intake guard owns it, #628), it leaves
    // search, and a re-mint under the same label starts it afresh.
    for (const entityId of linked) {
      const live = db.query("SELECT 1 FROM assertion_entities WHERE entity_id = ? LIMIT 1").get(entityId);
      if (live) continue;
      db.query("DELETE FROM entities WHERE id = ?").run(entityId);
      db.query("DELETE FROM entity_fts WHERE id = ?").run(entityId);
    }
  });
}

/** The assertion that stands for an id today: itself, or — following
 * `superseded_by` — the correction that replaced it (#629). The redirect
 * every door that opens an assertion by id applies. */
export function resolveAssertionId(root: string, id: string, db?: Database): string {
  return reading(root, db, (handle) => {
    const seen = new Set<string>();
    let at = id;
    while (!seen.has(at)) {
      seen.add(at);
      const row = handle.query("SELECT superseded_by FROM assertions WHERE id = ?").get(at) as
        { superseded_by: string | null } | null;
      if (!row?.superseded_by) return at;
      at = row.superseded_by;
    }
    return at;
  });
}

/** Live assertion EVENTS on one raw entity id, log order — what a
 * correction operates on (lib/entitySupersede.ts). */
export function liveAssertionsForEntity(root: string, entityId: string, db?: Database): AssertionEvent[] {
  return reading(root, db, (handle) =>
    (handle.query(`SELECT a.event_json FROM assertion_entities ae JOIN assertions a ON a.id = ae.assertion_id
      WHERE ae.entity_id = ? AND a.revoked_by IS NULL ORDER BY a.created_at, a.id`).all(entityId) as
      { event_json: string }[]).map((row) => JSON.parse(row.event_json) as AssertionEvent));
}

// ── entity aliases ──────────────────────────────────────────────────────────

/** Rewrite the resolved alias table and its FTS from the event census. The
 * census is tiny (an operator declares aliases by the dozen, not the
 * thousand), and re-folding it on every event keeps the projection's rules
 * literally entityAliasLog.ts's — latest per alias wins, self-alias
 * retracts, cycles drop their oldest, chains flatten — with no incremental
 * twin to drift. */
function refoldEntityAliases(db: Database): void {
  const events = (db.query("SELECT event_json FROM entity_alias_events").all() as { event_json: string }[])
    .map((row) => JSON.parse(row.event_json) as EntityAliasEvent);
  const { canonical } = entityAliasResolution(events);
  const aliasLabel = new Map<string, string>();
  for (const event of events) aliasLabel.set(event.alias_id, event.alias);
  db.run("DELETE FROM entity_aliases");
  db.run("DELETE FROM entity_alias_fts");
  for (const [aliasId, entity] of canonical) {
    const alias = aliasLabel.get(aliasId) ?? aliasId;
    db.query("INSERT INTO entity_aliases(alias_id, alias, entity_id, entity_label) VALUES (?, ?, ?, ?)")
      .run(aliasId, alias, entity.id, entity.label);
    db.query("INSERT INTO entity_alias_fts(alias_id, alias) VALUES (?, ?)").run(aliasId, alias);
  }
}

function insertEntityAliasRow(db: Database, event: EntityAliasEvent): boolean {
  validateEntityAliasEvent(event);
  return insertOnce(db, "alias", "entity_alias_events", "id", event.id, event, (eventJson) => {
    db.query("INSERT INTO entity_alias_events(id, event_json) VALUES (?, ?)").run(event.id, eventJson);
    refoldEntityAliases(db);
  });
}

function insertEntitySourceRow(db: Database, event: EntitySourceEvent): boolean {
  validateEntitySourceEvent(event);
  return insertOnce(db, "entity_source", "entity_source_events", "id", event.id, event, (eventJson) => {
    db.query("INSERT INTO entity_source_events(id, event_json) VALUES (?, ?)").run(event.id, eventJson);
  });
}

function insertSourceCopyRow(db: Database, event: SourceCopyEvent): boolean {
  validateSourceCopyEvent(event);
  return insertOnce(db, "copy", "source_copy_events", "id", event.id, event, (eventJson) => {
    db.query("INSERT INTO source_copy_events(id, event_json) VALUES (?, ?)").run(event.id, eventJson);
  });
}

/** Durable append first, disposable projection second. A projection failure
 * leaves the event safe in its log, where sync and rebuild deterministically
 * heal it — the discipline every kind follows, so it is written once. The
 * only thing that varies is which log appends and which table inserts. */
function appendAndProject<T, R>(
  append: (root: string, event: T) => R,
  insert: (db: Database, event: T) => boolean
): (root: string, event: T) => R {
  return (root, event) => {
    return withProjectionWrite(root, () => {
      const result = append(root, event);
      const db = open(root);
      try { insert(db, event); }
      finally { db.close(); }
      return result;
    });
  };
}

export const appendAndProjectAssertion = appendAndProject(appendAssertionEvent, insertAssertionRow);
export const appendAndProjectDecline = appendAndProject(appendDeclineEvent, insertDeclineRow);
export const appendAndProjectEntityAlias = appendAndProject(appendEntityAliasEvent, insertEntityAliasRow);
export const appendAndProjectEntitySource = appendAndProject(appendEntitySourceEvent, insertEntitySourceRow);
export const appendAndProjectSourceCopy = appendAndProject(appendSourceCopyEvent, insertSourceCopyRow);
// Last of its kind on purpose: a revocation needs its assertion — and, when
// it supersedes, that successor — already projected.
export const appendAndProjectRevocation = appendAndProject(appendRevocationEvent, insertRevocationRow);

/** The canonical entity a raw id resolves to through the alias table, or
 * undefined when the id is its own canonical. */
function aliasTargetOf(db: Database, id: string): { id: string; label: string } | undefined {
  const row = db.query("SELECT entity_id AS id, entity_label AS label FROM entity_aliases WHERE alias_id = ?")
    .get(id) as { id: string; label: string } | null;
  return row ?? undefined;
}

/** The alias table's answer for one raw id, read-side (#628: intake asks
 * this to REFUSE a link through an alias, never to follow it). */
export function projectedAliasTarget(root: string, id: string, db?: Database): AssertionEntity | undefined {
  return reading(root, db, (handle) => aliasTargetOf(handle, id));
}

/** One entity row as the record holds it — its OWN id, label and live
 * count, no alias resolution. Undefined when nothing live links the id:
 * never minted, or emptied by supersession (#629). The intake grammar's
 * notion of "exists". */
export function projectedEntityRow(root: string, id: string, db?: Database): ProjectedAssertionEntity | undefined {
  return reading(root, db, (handle) =>
    (handle.query(`SELECT e.id, e.label,
        (SELECT count(*) FROM assertion_entities ae WHERE ae.entity_id = e.id) AS assertions
      FROM entities e WHERE e.id = ?`).get(id) as ProjectedAssertionEntity | null) ?? undefined);
}

/** Where an entity's assertions went when they were superseded away: the
 * entity the corrections link most, so a link to a retired stub can be
 * refused with the right id in hand (#628). Undefined when no revocation
 * with a successor ever touched the id. */
export function retiredEntitySuccessor(root: string, id: string, db?: Database): AssertionEntity | undefined {
  return reading(root, db, (handle) => {
    const successors = handle.query(`SELECT DISTINCT r.superseded_by AS id
      FROM revocations r JOIN assertions a ON a.id = r.assertion_id, json_each(a.event_json, '$.entities') je
      WHERE r.superseded_by IS NOT NULL AND json_extract(je.value, '$.id') = ?`).all(id) as { id: string }[];
    const votes = new Map<string, { entity: AssertionEntity; n: number }>();
    for (const { id: successorId } of successors) {
      const row = handle.query("SELECT event_json FROM assertions WHERE id = ?").get(successorId) as
        { event_json: string } | null;
      if (!row) continue;
      for (const entity of (JSON.parse(row.event_json) as AssertionEvent).entities) {
        if (entity.id === id) continue;
        const held = votes.get(entity.id) ?? { entity, n: 0 };
        held.n++;
        votes.set(entity.id, held);
      }
    }
    return [...votes.values()].sort((a, b) => b.n - a.n)[0]?.entity;
  });
}

/** SQL for the raw ids that fold into one canonical entity: itself plus
 * every alias id pointing at it. Bind the canonical id TWICE. Each id in
 * the set hits assertion_entities_entity, where a coalesce over a joined
 * alias table would scan the join table per query — on the omnibox path. */
const RAW_IDS_OF = "(SELECT ? AS id UNION ALL SELECT alias_id AS id FROM entity_aliases WHERE entity_id = ?)";

/** Alias labels the table folds into a canonical entity, in table order. */
export function projectedEntityAliases(root: string, id: string, db?: Database): string[] {
  return reading(root, db, (handle) =>
    (handle.query("SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY alias").all(id) as
      { alias: string }[]).map((row) => row.alias));
}

/** One event kind's moving parts, so the incremental sync loop is written
 * once instead of five times. `held` names the ids the projection already
 * holds; `listFiles` is the log's cheap census (the filename IS the event id,
 * #456); `project` reads and inserts one file the projection is missing.
 *
 * The ORDER of the table below is the sync order, and it is load-bearing: an
 * assertion's cited insertions must be projected before the assertion, a
 * decline's insertions before the decline, and a revocation's assertion —
 * with its successor, when it supersedes — before the revocation. */
interface ProjectionKind {
  held: string;
  listFiles: (root: string) => EventFile[];
  project: (db: Database, file: EventFile, root: string) => void;
}

const projectionKind = <T extends { id: string }>(spec: {
  held: string;
  listFiles: (root: string) => EventFile[];
  validate: (event: T) => void;
  insert: (db: Database, event: T, root: string) => boolean;
}): ProjectionKind => ({
  held: spec.held,
  listFiles: spec.listFiles,
  project: (db, file, root) => {
    let event: T;
    try {
      event = parseEventFile(file, spec.validate);
    } catch (error) {
      throw new Error(`assertion-projection: unreadable event ${file.abs}: ${error}`);
    }
    spec.insert(db, event, root);
  },
});

const KINDS: readonly ProjectionKind[] = [
  projectionKind<SourceInsertion>({
    held: "SELECT insertion_id AS id FROM sources",
    listFiles: listSourceInsertionEventFiles,
    validate: validateSourceInsertion,
    insert: insertSourceRow,
  }),
  projectionKind<AssertionEvent>({
    held: "SELECT id FROM assertions",
    listFiles: listAssertionEventFiles,
    validate: validateAssertionEvent,
    insert: insertAssertionRow,
  }),
  projectionKind<DeclineEvent>({
    // A decline holds one row per insertion it settles, so its id repeats.
    held: "SELECT DISTINCT decline_id AS id FROM declines",
    listFiles: listDeclineEventFiles,
    validate: validateDeclineEvent,
    insert: insertDeclineRow,
  }),
  projectionKind<EntityAliasEvent>({
    held: "SELECT id FROM entity_alias_events",
    listFiles: listEntityAliasEventFiles,
    validate: validateEntityAliasEvent,
    insert: insertEntityAliasRow,
  }),
  projectionKind<EntitySourceEvent>({
    held: "SELECT id FROM entity_source_events",
    listFiles: listEntitySourceEventFiles,
    validate: validateEntitySourceEvent,
    insert: insertEntitySourceRow,
  }),
  projectionKind<SourceCopyEvent>({
    held: "SELECT id FROM source_copy_events",
    listFiles: listSourceCopyEventFiles,
    validate: validateSourceCopyEvent,
    insert: insertSourceCopyRow,
  }),
  projectionKind<RevocationEvent>({
    held: "SELECT id FROM revocations",
    listFiles: listRevocationEventFiles,
    validate: validateRevocationEvent,
    insert: insertRevocationRow,
  }),
];

const heldIds = (db: Database, sql: string): Set<string> =>
  new Set((db.query(sql).all() as { id: string }[]).map((row) => row.id));

interface Probe { generation: string; pending: boolean }

/** What reconciliation would have to do, read on a READONLY connection —
 * never a write transaction. The census — a directory listing and id scans
 * per log kind, and Markdown's metadata stamps, without body reads — runs
 * only when `census` asks for it: recovery does, a read never does.
 * `undefined` when there is no projection to compare against: absent,
 * damaged, or built by another schema — the write path rebuilds. */
function probe(root: string, census: boolean): Probe | undefined {
  let db: Database;
  try { db = openReadonly(root); } catch { return undefined; }
  try {
    const meta = Object.fromEntries((db.query("SELECT k, v FROM meta WHERE k IN ('schema','complete','generation','threads_dirty')").all() as { k: string; v: string }[]).map(r => [r.k, r.v]));
    if (meta.schema !== SCHEMA_VERSION || !meta.complete || !meta.generation) return undefined;
    let pending = Boolean(meta.threads_dirty);
    if (census) for (const kind of KINDS) {
      const held = heldIds(db, kind.held), files = new Set(kind.listFiles(root).map(file => file.id));
      if ([...files].some(id => !held.has(id))) pending = true;
      if (kind.listFiles === listSourceInsertionEventFiles) {
        const present = heldIds(db, "SELECT insertion_id AS id FROM sources WHERE present = 1");
        if (present.size !== files.size || [...present].some(id => !files.has(id))) pending = true;
      }
    }
    return { generation: meta.generation, pending: pending || (census && markdownChanged(db, root)) };
  } catch {
    return undefined;
  } finally { db.close(); }
}

function markdownChanged(db: Database, root: string): boolean {
  const docs = new Map((db.query("SELECT path, stamp FROM markdown_documents").all() as { path: string; stamp: string }[]).map(d => [d.path, d.stamp]));
  const files = markdownInventory(root);
  return files.size !== docs.size || [...files].some(([path, stamp]) => docs.get(path) !== stamp);
}

/** Mutable Markdown belongs to the same published revision as its parsed
 * relationships. A changed/deleted file cannot leave stale links behind.
 * `under` limits it to those paths — a note, or a folder of them. */
function reconcileMarkdown(db: Database, root: string, under?: readonly string[]): void {
  const files = markdownInventory(root, under);
  const scoped = (path: string) => !under || under.some((u) => u.endsWith(".md") ? path === u : path.startsWith(`${u}/`));
  const held = new Map((db.query("SELECT path, stamp FROM markdown_documents").all() as { path: string; stamp: string }[])
    .filter(d => scoped(d.path)).map(d => [d.path, d.stamp]));
  const moved: Omit<ProjectionChange, "revision">[] = [];
  for (const [path, stamp] of files) {
    if (held.get(path) === stamp) continue;
    const body = readMarkdownNote(root, path);
    if (body === undefined) throw new Error(`projection: Markdown disappeared during reconciliation: ${path}`);
    const doc = markdownDocument(path, body), links = parseDocumentLinks(doc);
    db.query("INSERT OR REPLACE INTO markdown_documents(path,stamp,header_json) VALUES (?,?,?)").run(path, stamp, JSON.stringify({ ...doc, body: undefined }));
    db.query("INSERT OR REPLACE INTO markdown_bodies(path,document_json) VALUES (?,?)").run(path, JSON.stringify(doc));
    writeDocumentLinks(db, `markdown:${path}`, stamp, links);
    moved.push({ kind: "markdown", id: path, op: held.has(path) ? "edit" : "add" });
  }
  for (const path of held.keys()) if (!files.has(path)) {
    db.query("DELETE FROM markdown_documents WHERE path = ?").run(path);
    db.query("DELETE FROM markdown_bodies WHERE path = ?").run(path);
    db.query("DELETE FROM document_links WHERE path = ?").run(`markdown:${path}`);
    db.query("DELETE FROM document_link_text WHERE path = ?").run(`markdown:${path}`);
    moved.push({ kind: "markdown", id: path, op: "remove" });
  }
  commitChanges(db, moved);
}

/** Group compact metadata once per source batch, in the same transaction as
 * the sources. A single append only marks dirty; shared snapshots reconcile
 * before borrowing, so they cannot mix old membership with new arrivals. */
function reconcileThreads(db: Database): void {
  if (!db.query("SELECT 1 FROM meta WHERE k = 'threads_dirty'").get()) return;
  const sources = (db.query("SELECT header_json FROM sources WHERE present = 1 ORDER BY coalesce(received_at, occurred_at, ''), insertion_id").all() as { header_json: string }[])
    .map(row => JSON.parse(row.header_json) as SourceMetadata);
  db.run("DELETE FROM read_threads");
  db.run("DELETE FROM read_thread_paths");
  db.run("DELETE FROM read_thread_members");
  const threadRow = db.query("INSERT INTO read_threads(id,thread_json) VALUES (?,?)");
  const pathRow = db.query("INSERT INTO read_thread_paths(path,thread_id) VALUES (?,?)");
  const memberRow = db.query("INSERT INTO read_thread_members(insertion_id,thread_id,position) VALUES (?,?,?)");
  for (const { members, ...thread } of sourceThreads(sources)) {
    threadRow.run(thread.id, JSON.stringify(thread));
    for (const path of [thread.path, ...thread.aliases]) pathRow.run(path, thread.id);
    members.forEach((source, position) => memberRow.run(source.id, thread.id, position));
  }
  db.run("DELETE FROM meta WHERE k = 'threads_dirty'");
}

/** All event kinds and the completion marker share one transaction. A bad
 * event leaves the previously published revision untouched. */
function reconcile(db: Database, root: string): AssertionProjectionStats {
  for (const kind of KINDS) {
    const held = heldIds(db, kind.held);
    const files = kind.listFiles(root);
    for (const file of files) if (!held.has(file.id)) kind.project(db, file, root);
    if (kind.listFiles === listSourceInsertionEventFiles) {
      // Retractions hide openable sources, but retain validated evidence for
      // assertions already projected. Replaying would reject those assertions.
      const ids = JSON.stringify(files.map(file => file.id));
      const flipped = db.query(`UPDATE sources SET present = insertion_id IN (SELECT value FROM json_each(?))
        WHERE present != (insertion_id IN (SELECT value FROM json_each(?))) RETURNING insertion_id AS id, present`)
        .all(ids, ids) as { id: string; present: number }[];
      if (flipped.length) {
        commitChanges(db, flipped.map(f => ({ kind: "source", id: f.id, op: f.present ? "add" : "remove" })));
        db.run("INSERT OR REPLACE INTO meta(k,v) VALUES ('threads_dirty','1')");
      }
    }
  }
  reconcileMarkdown(db, root);
  reconcileThreads(db);
  db.run("INSERT OR REPLACE INTO meta(k,v) VALUES ('complete','1')");
  return statsOf(db);
}

/** The projection generation this process has reconciled against the logs,
 * by root. A rebuild mints a new generation, so it is recovered afresh. */
const recovered = new Map<string, string>();
function generationOf(root: string): string | undefined {
  try {
    const db = openReadonly(root);
    try { return (db.query("SELECT v FROM meta WHERE k = 'generation'").get() as { v: string } | null)?.v; }
    finally { db.close(); }
  } catch { return undefined; }
}
/** Whether this process has recovered `generation` of the projection at `root`. */
export function projectionRecovered(root: string, generation: string): boolean {
  return recovered.get(resolve(root)) === generation;
}

/** The projection as this process has recovered it. A process that has not
 * recovers first, which reconciles everything: undefined then. */
function recoveredProbe(root: string): Probe | undefined {
  const ahead = probe(root, false);
  if (ahead && projectionRecovered(root, ahead.generation)) return ahead;
  recoverAssertionProjection(root);
  return undefined;
}

/** Count the current generation as recovered; undefined without a projection. */
function markRecovered(root: string): string | undefined {
  const generation = generationOf(root);
  if (generation) recovered.set(resolve(root), generation);
  return generation;
}

/** Bring the projection up to date for a read. Every engine write projects
 * itself as it appends (appendAndProject*, projectSourceInsertion), and a
 * reader's snapshot carries the revision those writes advanced — so another
 * process's write is visible here with no census at all. Markdown, which
 * people edit outside the engine, comes in through its own door (projectNotes).
 * What remains is grouping a batch of sources into threads. A current
 * projection takes no lock. The first call per root and generation in a
 * process recovers instead (recoverAssertionProjection), which is where
 * notes edited while no process watched them are found. */
export function syncAssertionProjection(root: string): void {
  if (!recoveredProbe(root)?.pending) return;
  withProjectionWrite(root, () => {
    const db = open(root);
    try { db.transaction(() => reconcileThreads(db))(); }
    finally { db.close(); }
  });
}

/** The door for Markdown, the one input people edit outside the engine:
 * project notes as they stand now, one commit with a change row for each note
 * created, edited or deleted. `paths` (vault-relative: a note, or a folder of
 * them) limits it to what changed — the viewer's watcher passes what it saw,
 * and an engine pass what it wrote; without them, every note. */
export function projectNotes(root: string, paths?: Iterable<string>): void {
  const under = paths && [...new Set([...paths].map((p) => p.split(sep).join("/")))];
  if ((under && !under.length) || !recoveredProbe(root)) return;
  withProjectionWrite(root, () => {
    const db = open(root);
    try { db.transaction(() => reconcileMarkdown(db, root, under))(); }
    finally { db.close(); }
  });
}

/** Heal what the write path could not: a process that died between its
 * append and its projection, a landing that swallowed a projection error, a
 * file put in `log/` by hand. Runs once per root and generation in every
 * process, and again whenever the viewer's watcher sees `log/` change — off
 * the request path there (lib/liveEvents.ts).
 *
 * Incremental by filename (#456): the log filename IS the event id, so the
 * only files ever parsed are the ones the projection does not hold yet — one
 * connection for the whole pass, never one per event. An already-projected
 * file is never reread: the projection holds the copy it validated at insert
 * time, and the append path owns immutability collisions. */
export function recoverAssertionProjection(root: string): AssertionProjectionStats {
  const stats = withProjectionWrite(root, () => {
    const ahead = probe(root, true);
    if (ahead && !ahead.pending) return assertionProjectionStats(root);
    const db = open(root);
    try { return db.transaction(() => reconcile(db, root))(); }
    finally { db.close(); }
  });
  markRecovered(root);
  return stats;
}

/** Count this process's recovery of `root` as done without running it here:
 * the viewer hands the census to a worker, and every worker it spawns serves
 * the viewer's projection. The returned function withdraws the claim, for a
 * recovery that failed. No-op without a projection, which a read must build. */
export function claimProjectionRecovery(root: string): () => void {
  const generation = markRecovered(root), key = resolve(root);
  return () => { if (generation && recovered.get(key) === generation) recovered.delete(key); };
}

export function rebuildAssertionProjection(root: string): AssertionProjectionStats {
  const stats = withProjectionWrite(root, () => {
    const db = open(root);
    try {
      return db.transaction(() => {
        resetProjection(db);
        schema(db);
        db.query("INSERT INTO meta(k,v) VALUES ('schema',?), ('generation',?), ('revision','0')").run(SCHEMA_VERSION, crypto.randomUUID());
        return reconcile(db, root);
      })();
    } finally { db.close(); }
  });
  markRecovered(root);
  return stats;
}

/** What the projection committed after `since` (a `generation:revision`, as
 * projectionRevision names one), in commit order, with the coordinate it reads
 * up to. Undefined when `since` is another generation, ahead of this one, or
 * older than the rows kept: the reader starts again from a snapshot. */
export function projectionChangesSince(root: string, since: string, db?: Database): { revision: string; changes: ProjectionChange[] } | undefined {
  return reading(root, db, (handle) => {
    const at = projectionRevision(root, handle);
    if (!at) return undefined;
    const [generation, revision] = at.split(":"), [sinceGeneration, sinceRevision] = since.split(":");
    const from = Number(sinceRevision), to = Number(revision);
    if (sinceGeneration !== generation || !Number.isSafeInteger(from) || from > to) return undefined;
    const oldest = (handle.query("SELECT min(revision) AS r FROM changes").get() as { r: number | null }).r;
    if (from < to && (oldest === null || oldest > from + 1)) return undefined;
    const changes = handle.query("SELECT revision, kind, id, op FROM changes WHERE revision > ? AND revision <= ? ORDER BY revision, kind, id")
      .all(from, to) as ProjectionChange[];
    return { revision: at, changes };
  });
}

/** A journal file the viewer reads (tend's runs, the feed stage's items) was
 * written: log it, so a view built from journals moves with the record. The
 * file is the truth and was written first; a row lost to a crash costs that
 * view its freshness until the next commit, never data. */
export function projectJournal(root: string, rel: string): void {
  try {
    withProjectionWrite(root, () => {
      const db = open(root);
      try { db.transaction(() => commitChanges(db, [{ kind: "journal", id: rel, op: "add" }]))(); }
      finally { db.close(); }
    });
  } catch { /* the next commit carries the view forward */ }
}

/** The projection's coordinate, with the coordinate of its last commit that
 * logged a row outside `except`: what a view that ignores those kinds last
 * depended on. One snapshot; undefined without a projection. */
export function lastChangeExcept(root: string, except: readonly ChangeKind[], db?: Database): { at: string; last: string } | undefined {
  return reading(root, db, (handle) => handle.transaction(() => {
    const at = projectionRevision(root, handle);
    if (!at) return undefined;
    const row = handle.query(`SELECT revision FROM changes WHERE kind NOT IN (${except.map(() => "?").join(", ")})
      ORDER BY revision DESC LIMIT 1`).get(...except) as { revision: number } | null;
    return { at, last: `${at.split(":")[0]}:${row?.revision ?? 0}` };
  })());
}

/** A saved view: the revision it reflects, a hash of its body (its stamp and
 * ETag), and the body as served. */
export interface ProjectionView { revision: string; hash: string; body: string }

/** A saved view, as its maintainer last saved it; its revision says how
 * current it is. Undefined before the first save, or without a projection. */
export function projectionView(root: string, name: string): ProjectionView | undefined {
  try {
    const db = openReadonly(root);
    try { return (db.query("SELECT revision, hash, body FROM views WHERE name = ?").get(name) as ProjectionView | null) ?? undefined; }
    finally { db.close(); }
  } catch { return undefined; }
}

/** Save a view with the revision it reflects. Derived and disposable like the
 * rest: a projection that cannot take it (another schema, read-only) keeps
 * the viewer serving from memory and building again next start. */
export function saveProjectionView(root: string, name: string, view: ProjectionView): void {
  try {
    const db = new Database(assertionDbPath(root));
    try {
      db.run("PRAGMA busy_timeout = 5000");
      db.query("INSERT OR REPLACE INTO views(name, revision, hash, body) VALUES (?, ?, ?, ?)").run(name, view.revision, view.hash, view.body);
    } finally { db.close(); }
  } catch { /* the view stays in memory */ }
}

/** A generation changes on rebuild; revision advances for record/content changes.
 * Undefined means a partial/uninitialized projection, never an empty vault. */
export function projectionRevision(root: string, db?: Database): string | undefined {
  return reading(root, db, handle => {
    const meta = Object.fromEntries((handle.query("SELECT k,v FROM meta WHERE k IN ('generation','revision','complete')").all() as { k: string; v: string }[]).map(r => [r.k, r.v]));
    return meta.complete && meta.generation ? `${meta.generation}:${meta.revision}` : undefined;
  });
}

/** One request, one connection (#456): searchCore opens this once per scan
 * and passes it to every read below, instead of each call paying its own
 * open/close against the same file. */
export function openAssertionProjectionReadonly(root: string): Database {
  return openReadonly(root);
}

/** Run `fn` on a borrowed connection when the caller holds one, else on a
 * connection scoped to this call. */
function reading<T>(root: string, db: Database | undefined, fn: (handle: Database) => T): T {
  if (db) return fn(db);
  const handle = openReadonly(root);
  try {
    return fn(handle);
  } finally { handle.close(); }
}

export function searchAssertionProjection(
  root: string,
  query: string,
  limit = 12,
  mode: "all" | "any" = "all",
  db?: Database
): AssertionSearchHit[] {
  const match = matchQuery(query, mode);
  if (!match || limit < 1) return [];
  return reading(root, db, (handle) =>
    handle.query(`SELECT a.id, a.text, a.confidence, a.created_at, bm25(assertion_fts) AS score
      FROM assertion_fts JOIN assertions a ON a.id = assertion_fts.id
      WHERE assertion_fts MATCH ? AND ${liveAssertionSql("a")}
      ORDER BY score LIMIT ?`).all(match, limit) as AssertionSearchHit[]);
}

export function searchAssertionSources(
  root: string,
  query: string,
  limit = 12,
  mode: "all" | "any" = "all",
  db?: Database,
  filters: { source?: string; after?: string; before?: string } = {}
): AssertionSourceHit[] {
  const match = matchQuery(query, mode);
  if (!match || limit < 1) return [];
  return reading(root, db, (handle) => {
    const rows = handle.query(`SELECT s.insertion_id, s.source_id, s.title, bm25(source_fts) AS score
      FROM source_fts JOIN sources s INDEXED BY sources_headers ON s.insertion_id = source_fts.insertion_id
      WHERE source_fts MATCH ? AND ${liveSourceSql("s")}
        AND (? IS NULL OR lower(s.envelope_source) = ?)
        AND (? IS NULL OR substr(coalesce(s.received_at, s.occurred_at, ''), 1, 10) >= ?)
        AND (? IS NULL OR substr(coalesce(s.received_at, s.occurred_at, ''), 1, 10) <= ?)
      ORDER BY CASE WHEN s.envelope_kind IN ('agent-chat', 'pilot-chat', 'handoff-answer')
          OR s.envelope_source IN ('pilot', 'agent-chat') THEN 1 ELSE 0 END,
        score LIMIT ?`).all(match, filters.source ?? null, filters.source ?? null,
        filters.after ?? null, filters.after ?? null, filters.before ?? null, filters.before ?? null, limit) as AssertionSourceHit[];
    const names = searchAlternatives(query).flatMap(terms => searchNames(assertionDbPath(root), terms.join(" "), "source", mode, rows.length === 0));
    const named = handle.query(`SELECT s.insertion_id, s.source_id, s.title, json_extract(h.value, '$.score') AS score
      FROM json_each(?) h JOIN sources s INDEXED BY sources_headers ON s.insertion_id = json_extract(h.value, '$.id')
      WHERE ${liveSourceSql("s")}
        AND (? IS NULL OR lower(s.envelope_source) = ?)
        AND (? IS NULL OR substr(coalesce(s.received_at, s.occurred_at, ''), 1, 10) >= ?)
        AND (? IS NULL OR substr(coalesce(s.received_at, s.occurred_at, ''), 1, 10) <= ?)`)
      .all(JSON.stringify(names), filters.source ?? null, filters.source ?? null, filters.after ?? null, filters.after ?? null, filters.before ?? null, filters.before ?? null) as AssertionSourceHit[];
    const heads = projectedSourceHeads(root, [...rows, ...named].map(row => row.insertion_id), handle);
    const agent = (row: AssertionSourceHit) => {
      const head = heads.get(row.insertion_id);
      return Number(["agent-chat", "pilot-chat", "handoff-answer"].includes(head?.kind ?? "") || ["pilot", "agent-chat"].includes(head?.source ?? ""));
    };
    const merged = new Map<string, AssertionSourceHit>();
    for (const row of [...named, ...rows].sort((a, b) => agent(a) - agent(b) || a.score - b.score))
      if (!merged.has(row.insertion_id)) merged.set(row.insertion_id, row);
    return [...merged.values()].slice(0, limit);
  });
}

/** A body hit's snippet: up to 240 characters of the body starting 100
 * before the first query term it contains, cut in SQL for exactly the rows
 * asked for. This replaces FTS5's snippet() in the ranking query, which
 * re-tokenizes the whole column per row and — under ORDER BY … LIMIT — ran
 * for every row the prefix matched, not the pool: a one-letter prefix over
 * 55MB of transcripts cost 2.1s per keystroke (2026-08-29), and the server
 * is synchronous, so the query typed next waited behind it. instr/substr
 * over the ≤100 rows a response holds is single-digit milliseconds. Terms
 * are tried in query order; a body holding none of them (the match was in
 * the title, or a term lower() cannot fold) yields its opening. */
export function sourceMatchWindows(
  root: string,
  ids: readonly string[],
  query: string,
  db?: Database
): Map<string, string> {
  const out = new Map<string, string>();
  const terms = searchAlternatives(query).flat().slice(0, 8);
  if (!ids.length || !terms.length) return out;
  const first = terms.map(() => "nullif(instr(lb, ?), 0)").join(", ");
  reading(root, db, (handle) => {
    eachByIds<{ insertion_id: string; window: string }>(handle, ids, (placeholders) =>
      `SELECT insertion_id, substr(body, max(1, coalesce(${first}, 1) - 100), 240) AS window
        FROM (SELECT insertion_id, body, lower(body) AS lb
          FROM (SELECT insertion_id, json_extract(event_json, '$.body') AS body FROM source_documents
            WHERE insertion_id IN (${placeholders})))`,
      (row) => out.set(row.insertion_id, row.window), terms);
  });
  return out;
}

/** IN-clauses stay under SQLite's parameter ceiling. */
const chunked = <T>(values: readonly T[], size = 400): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
};

/** One `… IN (?, …)` lookup over a set of ids, visiting each row. The five
 * batched reads below all need the same three things to agree — the ids
 * deduplicated, batched under the parameter ceiling, and exactly as many
 * placeholders as the batch binds — so they are made together here instead
 * of by hand five times. `sql` is handed the placeholder list; `lead` binds
 * ahead of it. A batch is folded as it arrives rather than collected: the
 * biggest of these reads is over every source in the vault, whose rows carry
 * the whole transcript body. */
function eachByIds<R>(
  handle: Database,
  ids: readonly string[],
  sql: (placeholders: string) => string,
  each: (row: R) => void,
  lead: readonly string[] = []
): void {
  for (const batch of chunked([...new Set(ids)]))
    for (const row of handle.query(sql(batch.map(() => "?").join(","))).all(...lead, ...batch) as R[]) each(row);
}

/** Batched projected-event read for the request path: the scan resolves its
 * candidate insertion ids from the projection it already searched, never by
 * replaying the log directory (#456). */
export function projectedSourcesById(
  root: string,
  ids: readonly string[],
  db?: Database
): Map<string, SourceInsertion> {
  const out = new Map<string, SourceInsertion>();
  if (!ids.length) return out;
  reading(root, db, (handle) => {
    eachByIds<{ insertion_id: string; event_json: string }>(handle, ids, (placeholders) =>
      `SELECT insertion_id, event_json FROM source_documents WHERE insertion_id IN (${placeholders})`,
      (row) => out.set(row.insertion_id, JSON.parse(row.event_json) as SourceInsertion));
  });
  return out;
}

/** Sources' envelopes and authors, never their bodies, by insertion id:
 * what a reader's provenance is decided from (lib/provenance.ts). */
export function projectedSourceMetadata(
  root: string,
  ids: readonly string[],
  db?: Database
): Map<string, SourceMetadata> {
  const out = new Map<string, SourceMetadata>();
  if (!ids.length || (!db && !existsSync(assertionDbPath(root)))) return out;
  reading(root, db, (handle) => {
    eachByIds<{ insertion_id: string; header_json: string }>(handle, ids, (placeholders) =>
      `SELECT insertion_id, header_json FROM sources WHERE insertion_id IN (${placeholders})`,
      (row) => out.set(row.insertion_id, JSON.parse(row.header_json) as SourceMetadata));
  });
  return out;
}

/** The columns ranking a hit needs — id, source, title, dates — and nothing
 * else. `projectedSourcesById` parses each cited event's JSON, body included:
 * ranking a one-letter prefix parsed 46MB of transcript to read 650 titles
 * (70ms per keystroke). These rows cost 6ms. */
export type SourceHead = Pick<SourceInsertion, "id" | "source_id" | "title" | "occurred_at" | "received_at"> & {
  /** The envelope's `kind`, when it has one — what lets a viewer surface
   * tell a voice arrival (lib/voice.ts) from a piece of the record. */
  kind?: string;
  source?: string;
};

interface HeadRow {
  insertion_id: string;
  source_id: string;
  title: string;
  occurred_at: string | null;
  received_at: string | null;
  kind: string | null;
  source: string | null;
}

export function projectedSourceHeads(
  root: string,
  ids: readonly string[],
  db?: Database
): Map<string, SourceHead> {
  const out = new Map<string, SourceHead>();
  if (!ids.length) return out;
  reading(root, db, (handle) => {
    eachByIds<HeadRow>(handle, ids, (placeholders) =>
      `SELECT insertion_id, source_id, title, occurred_at, received_at,
          envelope_kind AS kind,
          envelope_source AS source FROM sources INDEXED BY sources_headers
        WHERE insertion_id IN (${placeholders})`,
      (row) => out.set(row.insertion_id, {
        id: row.insertion_id,
        source_id: row.source_id,
        title: row.title,
        ...(row.occurred_at ? { occurred_at: row.occurred_at } : {}),
        ...(row.received_at ? { received_at: row.received_at } : {}),
        ...(typeof row.kind === "string" && row.kind ? { kind: row.kind } : {}),
        ...(typeof row.source === "string" && row.source ? { source: row.source } : {}),
      }));
  });
  return out;
}

/** Which of `ids` the projection holds — the memory runner's citation gate
 * (#459): a memory claim may only cite `[[ast_…]]` ids the record resolves.
 * An absent projection file means nothing resolves: on a legacy vault there
 * are no assertions to cite, and the native runner syncs the projection
 * before asking. */
export function assertionIdsExist(root: string, ids: readonly string[], db?: Database): Set<string> {
  const out = new Set<string>();
  if (!ids.length || !existsSync(assertionDbPath(root))) return out;
  reading(root, db, (handle) => {
    eachByIds<{ id: string }>(handle, ids, (placeholders) =>
      `SELECT id FROM assertions WHERE id IN (${placeholders})`, (row) => out.add(row.id));
  });
  return out;
}

/** The evidence edges for a set of assertions, from the projection's join
 * table — the request path never parses assertion event files for this. */
export function sourceRefsForAssertions(
  root: string,
  ids: readonly string[],
  db?: Database
): Map<string, AssertionSourceReference[]> {
  const out = new Map<string, AssertionSourceReference[]>();
  if (!ids.length) return out;
  reading(root, db, (handle) => {
    eachByIds<AssertionSourceReference & { assertion_id: string }>(handle, ids, (placeholders) =>
      // an edge to a superseded landing is not evidence a reader should be
      // sent to (lib/sourceSupersede.ts); an edge to a source the
      // projection no longer holds stays, as it always has
      `SELECT x.assertion_id, x.insertion_id, x.source_id FROM assertion_sources x
        LEFT JOIN sources s ON s.insertion_id = x.insertion_id
        WHERE x.assertion_id IN (${placeholders}) AND (s.insertion_id IS NULL OR ${liveSourceSql("s")})`,
      ({ assertion_id, ...ref }) => {
        const held = out.get(assertion_id);
        if (held) held.push(ref);
        else out.set(assertion_id, [ref]);
      });
  });
  return out;
}

export interface EntityAssertionRow {
  id: string;
  text: string;
  refs: AssertionSourceReference[];
}

/** One entity's assertions with their evidence edges, newest first and
 * bounded — a heavily-cited entity must not fan a search out into its whole
 * history (#456). */
export function assertionsWithRefsForEntity(
  root: string,
  entityId: string,
  limit: number,
  db?: Database
): EntityAssertionRow[] {
  if (limit < 1) return [];
  return reading(root, db, (handle) => {
    const id = aliasTargetOf(handle, entityId)?.id ?? entityId;
    const rows = handle.query(`SELECT DISTINCT a.id, a.text, a.created_at
      FROM assertion_entities ae JOIN assertions a ON a.id = ae.assertion_id
      WHERE ae.entity_id IN ${RAW_IDS_OF} AND ${liveAssertionSql("a")}
      ORDER BY a.created_at DESC, a.id DESC LIMIT ?`)
      .all(id, id, limit) as { id: string; text: string }[];
    const refs = sourceRefsForAssertions(root, rows.map((row) => row.id), handle);
    return rows.map((row) => ({ ...row, refs: refs.get(row.id) ?? [] }));
  });
}

export function searchAssertionEntities(
  root: string,
  query: string,
  limit = 20,
  mode: "all" | "any" = "all",
  db?: Database
): AssertionEntityHit[] {
  if (limit < 1) return [];
  const names = searchAlternatives(query).flatMap(terms => searchNames(assertionDbPath(root), terms.join(" "), "entity", mode));
  if (!names.length) return [];
  return reading(root, db, (handle) => handle.query(`WITH hit AS (
    SELECT json_extract(value, '$.id') AS raw_id, json_extract(value, '$.score') AS score FROM json_each(?)
  ), ${ENTITY_RESOLVED_SQL} ORDER BY score LIMIT ?`).all(JSON.stringify(names), limit) as AssertionEntityHit[]);
}

/** Entity hits over own labels AND alias labels, each raw hit resolved
 * through the alias table and the best score kept per canonical entity —
 * so "Evan" ranks Evan Keller once, by the alias's exact match, with the
 * merged count. Preserve the best matching alias for the UI. */
const ENTITY_RESOLVED_SQL = `resolved AS (
    SELECT id, score, alias FROM (
      SELECT coalesce(al.entity_id, hit.raw_id) AS id, hit.score, al.alias,
        row_number() OVER (PARTITION BY coalesce(al.entity_id, hit.raw_id)
          ORDER BY hit.score, al.alias IS NOT NULL, al.alias) AS rn
        FROM hit LEFT JOIN entity_aliases al ON al.alias_id = hit.raw_id
    ) WHERE rn = 1
  )
  SELECT r.id,
    coalesce(e.label, (SELECT entity_label FROM entity_aliases WHERE entity_id = r.id LIMIT 1)) AS label,
    (SELECT count(DISTINCT ae.assertion_id) FROM assertion_entities ae
      WHERE ae.entity_id IN (SELECT r.id UNION ALL SELECT alias_id FROM entity_aliases WHERE entity_id = r.id))
      AS assertions,
    r.score, r.alias
  FROM resolved r LEFT JOIN entities e ON e.id = r.id`;

const ENTITY_HITS_SQL = `WITH hit AS (
    SELECT entity_fts.id AS raw_id, bm25(entity_fts) AS score
      FROM entity_fts WHERE entity_fts MATCH ?
    UNION ALL
    SELECT entity_alias_fts.alias_id AS raw_id, bm25(entity_alias_fts) AS score
      FROM entity_alias_fts WHERE entity_alias_fts MATCH ?
  ), ${ENTITY_RESOLVED_SQL}`;

/** Existing entities a bare label could already mean: every entity whose
 * label or alias contains ALL of the label's tokens as whole words (no
 * prefix), resolved, most-cited first. The intake guard's evidence
 * (lib/assertionAgent.ts): "Evan" → Evan Keller (100) before a stub is
 * minted beside it. */
export function projectedEntityCandidates(
  root: string,
  label: string,
  limit = 8,
  db?: Database
): ProjectedAssertionEntity[] {
  const terms = matchTerms(label);
  if (!terms.length || limit < 1) return [];
  const match = terms.map((term) => `"${term.replace(/"/g, "\"")}"`).join(" AND ");
  return reading(root, db, (handle) =>
    (handle.query(`${ENTITY_HITS_SQL} ORDER BY assertions DESC, r.score LIMIT ?`)
      .all(match, match, limit) as AssertionEntityHit[])
      .map(({ id, label: hitLabel, assertions }) => ({ id, label: hitLabel, assertions })));
}

/** Every label the live record answers to — each canonical entity's own
 * label first, then its aliases — with the canonical id and merged count,
 * for the intake guard's lookalike rules (lib/entityLookalikes.ts). Live
 * means at least one unrevoked claim under the entity or an alias of it;
 * one row per live label, read once per submit. */
export function projectedLabelRows(root: string, db?: Database): LabelRow[] {
  return reading(root, db, (handle) => {
    // Count distinct claims in SQLite rather than materializing every link
    // for every label check. Aliases are already flattened by the projection.
    const counts = handle.query(`SELECT coalesce(al.entity_id, ae.entity_id) AS id,
        count(DISTINCT ae.assertion_id) AS assertions
      FROM assertion_entities ae
      JOIN assertions a ON a.id = ae.assertion_id AND a.revoked_by IS NULL
      LEFT JOIN entity_aliases al ON al.alias_id = ae.entity_id
      GROUP BY coalesce(al.entity_id, ae.entity_id)`).all() as { id: string; assertions: number }[];
    const aliases = handle.query("SELECT alias_id, alias, entity_id, entity_label FROM entity_aliases").all() as
      { alias_id: string; alias: string; entity_id: string; entity_label: string }[];
    const labels = new Map((handle.query("SELECT id, label FROM entities").all() as { id: string; label: string }[])
      .map((row) => [row.id, row.label]));
    const merged = new Map(counts.map(row => [row.id, row.assertions]));
    const rows: LabelRow[] = [];
    for (const [id, assertions] of merged) {
      const label = labels.get(id) ?? aliases.find((row) => row.entity_id === id)?.entity_label;
      if (label) rows.push({ id, label, assertions });
    }
    for (const row of aliases) {
      const assertions = merged.get(row.entity_id);
      if (assertions !== undefined) rows.push({ id: row.entity_id, label: row.alias, assertions });
    }
    return rows;
  });
}

/** The entity a raw id names once the alias table has spoken: an aliased
 * id answers with its CANONICAL entity (id, label, merged count, aliases),
 * so a caller holding a stub's id — a link the model found by search, an
 * old page path — lands on the one dossier. Undefined only when neither
 * the entities table nor the alias table knows the id. */
export function projectedAssertionEntity(root: string, entityId: string, db?: Database): ProjectedAssertionEntity | undefined {
  return reading(root, db, (handle) => {
    const target = aliasTargetOf(handle, entityId);
    const id = target?.id ?? entityId;
    const row = handle.query(`SELECT e.id, e.label,
        (SELECT count(DISTINCT ae.assertion_id) FROM assertion_entities ae WHERE ae.entity_id IN ${RAW_IDS_OF})
          AS assertions
      FROM entities e WHERE e.id = ?`).get(id, id, id) as ProjectedAssertionEntity | null;
    const aliases = projectedEntityAliases(root, id, handle);
    if (row) return aliases.length ? { ...row, aliases } : row;
    // A canonical no assertion has linked directly — only its aliases have:
    // the alias table is the one thing that knows its label, and the count
    // is its aliases'.
    const label = target?.label ?? (handle.query(
      "SELECT entity_label FROM entity_aliases WHERE entity_id = ? LIMIT 1").get(id) as
      { entity_label: string } | null)?.entity_label;
    if (!label) return undefined;
    const count = (handle.query(`SELECT count(DISTINCT ae.assertion_id) AS n FROM assertion_entities ae
      WHERE ae.entity_id IN ${RAW_IDS_OF}`).get(id, id) as { n: number }).n;
    return { id, label, assertions: count, aliases };
  });
}

function statsOf(db: Database): AssertionProjectionStats {
  const count = (table: string): number => (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  const entities = (db.query(`SELECT count(*) AS n FROM entities
    WHERE id NOT IN (SELECT alias_id FROM entity_aliases)`).get() as { n: number }).n;
  const assertions = (db.query("SELECT count(*) AS n FROM assertions WHERE revoked_by IS NULL").get() as { n: number }).n;
  return {
    sources: count("sources"), assertions, entities,
    source_links: count("assertion_sources"),
  };
}

/** One assertion as the listing door serves it (#686). */
export interface AssertionListRow {
  id: string;
  /** The newest CONTENT date behind this assertion — the `occurred_at` of
   * the sources it cites — falling back to `created_at` when no source
   * carries one. NEVER plain `created_at`: the gardener asserts on the day
   * it reads an arrival, so `created_at` collapses to import time (every
   * one of the canary's 3,665 lands in a single month) while the sources
   * behind them span 2013-2026. Resolving this by hand cost the memory pass
   * ~15 turns of throwaway Python on every run. */
  date: string;
  text: string;
  entities: AssertionEntity[];
}

/** One entity's standing in the record: how much of it is about them, over
 * what span of content dates. */
export interface AssertionEntityTally {
  id: string;
  label: string;
  assertions: number;
  first: string;
  last: string;
}

export interface AssertionListFilters {
  /** Inclusive YYYY-MM-DD bounds on the CONTENT date, as `--after`/`--before`
   * mean them on a search. */
  since?: string;
  until?: string;
  /** An entity id, or an alias id the table folds into one. */
  entity?: string;
  /** 0 or absent means every match — a survey wants the window, not a page. */
  limit?: number;
}

/** Every live assertion with its content date, as a CTE the two readers
 * below share. LEFT joins throughout: an assertion whose sources are gone
 * from the projection still belongs in a listing, dated by its fallback. */
export const DATED_ASSERTIONS = `SELECT a.id AS id, a.text AS text, a.created_at AS created_at,
    COALESCE(MAX(s.occurred_at), a.created_at) AS date
  FROM assertions a
  LEFT JOIN assertion_sources x ON x.assertion_id = a.id
  LEFT JOIN sources s ON s.insertion_id = x.insertion_id
  WHERE a.revoked_by IS NULL AND ${liveAssertionSql("a")}
  GROUP BY a.id`;

/** THE LISTING DOOR (#686) — a date-ordered window over the live record.
 *
 * `searchAssertionProjection` answers "find X" and requires a term. The
 * memory pass's actual need is a SLICE — "everything since 2026-08-22,
 * newest content first" — which no door served, so every run rebuilt one:
 * ~15 turns writing a throwaway index over the raw JSON logs, in a
 * different shape each time. Three from-scratch runs each surveyed 8-13%
 * of the record and overlapped on 30% of what they saw.
 */
export function listAssertions(
  root: string,
  filters: AssertionListFilters = {},
  db?: Database
): AssertionListRow[] {
  return reading(root, db, (handle) => {
    const where: string[] = [];
    const args: (string | number)[] = [];
    // The entity clause resolves through the alias table the same way a
    // search does: asking for an alias id must not answer empty.
    if (filters.entity) {
      const id = aliasTargetOf(handle, filters.entity)?.id ?? filters.entity;
      where.push(`d.id IN (SELECT assertion_id FROM assertion_entities
        WHERE entity_id IN ${RAW_IDS_OF})`);
      args.push(id, id);
    }
    // Compared on the DAY, so an inclusive --until matches the whole day
    // rather than only its midnight instant.
    if (filters.since) { where.push("substr(d.date, 1, 10) >= ?"); args.push(filters.since); }
    if (filters.until) { where.push("substr(d.date, 1, 10) <= ?"); args.push(filters.until); }
    const limit = filters.limit && filters.limit > 0 ? filters.limit : -1;
    args.push(limit);
    const rows = handle.query(`WITH d AS (${DATED_ASSERTIONS})
      SELECT d.id, d.text, d.date FROM d
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY d.date DESC, d.id DESC LIMIT ?`)
      .all(...args) as Array<{ id: string; text: string; date: string }>;

    if (!rows.length) return [];
    const holes = "?,".repeat(rows.length).slice(0, -1);
    const ents = handle.query(`SELECT ae.assertion_id AS a, e.id, e.label
      FROM assertion_entities ae JOIN entities e ON e.id = ae.entity_id
      WHERE ae.assertion_id IN (${holes})`)
      .all(...rows.map((r) => r.id)) as Array<{ a: string; id: string; label: string }>;
    const byAssertion = new Map<string, AssertionEntity[]>();
    for (const e of ents) {
      const list = byAssertion.get(e.a);
      if (list) list.push({ id: e.id, label: e.label });
      else byAssertion.set(e.a, [{ id: e.id, label: e.label }]);
    }
    return rows.map((r) => ({ ...r, entities: byAssertion.get(r.id) ?? [] }));
  });
}

/** The record's shape in one query: every entity it names, how many live
 * assertions cite them, and the span of content dates those cover.
 * Most-cited first — a map for choosing where to read. */
export function tallyAssertionEntities(root: string, db?: Database): AssertionEntityTally[] {
  return reading(root, db, (handle) =>
    handle.query(`WITH d AS (${DATED_ASSERTIONS})
      SELECT e.id AS id, e.label AS label, COUNT(*) AS assertions,
             substr(MIN(d.date), 1, 7) AS first, substr(MAX(d.date), 1, 7) AS last
      FROM assertion_entities ae
      JOIN d ON d.id = ae.assertion_id
      JOIN entities e ON e.id = ae.entity_id
      GROUP BY ae.entity_id
      ORDER BY assertions DESC, e.label ASC`).all() as AssertionEntityTally[]);
}

export function assertionProjectionStats(root: string): AssertionProjectionStats {
  const db = openReadonly(root);
  try {
    return statsOf(db);
  } finally { db.close(); }
}

/** Logical digest ignores SQLite page layout and FTS internals. */
export function assertionProjectionDigest(root: string): string {
  const db = openReadonly(root);
  try {
    const rows = [
      db.query("SELECT event_json FROM source_documents ORDER BY insertion_id").all(),
      db.query("SELECT event_json FROM assertions ORDER BY id").all(),
      db.query("SELECT assertion_id, entity_id FROM assertion_entities ORDER BY assertion_id, entity_id").all(),
      db.query(`SELECT assertion_id, insertion_id, source_id
        FROM assertion_sources ORDER BY assertion_id, insertion_id`).all(),
      db.query("SELECT alias_id, entity_id FROM entity_aliases ORDER BY alias_id").all(),
      db.query("SELECT assertion_id, superseded_by FROM revocations ORDER BY id").all(),
      db.query("SELECT id, revoked_by, superseded_by FROM assertions WHERE revoked_by IS NOT NULL ORDER BY id").all(),
    ];
    return sha256hex(JSON.stringify(rows));
  } finally { db.close(); }
}
