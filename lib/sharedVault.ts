/**
 * sharedVault.ts — the record of ONE shared vault, as its members write it.
 *
 * A shared vault is an ordinary BigBrain vault directory whose logs are
 * written by several authenticated members rather than one machine
 * account and its gardener (docs/shared-vault.md). It reuses the engine's
 * append-only logs as they are — `log/insertions/` for evidence,
 * `log/assertions/` for claims, `log/revocations/` for corrections and
 * moderation (lib/eventLog.ts and the three `*Log.ts` modules) — and adds
 * exactly one durable log of its own, the CHANGE FEED (`log/shared-feed/`),
 * which is the vault's total order: one line per event landed, with a
 * sequence number a client resumes from.
 *
 * What this module decides, and why:
 *
 * - **The actor is the author.** Every event's `author` is the verified
 *   member (lib/sharedMembers.ts SharedActor), never a body field. Evidence
 *   keeps THREE identities apart on purpose: the SUBMITTER (verified, the
 *   event author and `envelope.submitted_by`), the ORIGIN AUTHOR (claimed —
 *   whose words these are: a forwarded email's sender, a colleague's note;
 *   `envelope.origin.author`, flagged `author_verified` only when it is the
 *   submitter's own person credential), and the ORIGIN IDENTITY (the stable
 *   `source_id`, so the same source resubmitted or corrected is recognisably
 *   the same source across submitters).
 *
 * - **Events are deterministic, so retries converge.** An evidence event
 *   carries no receive timestamp — the feed does — and is byte-identical on
 *   retry, which the log dedupes natively. Assertion and revocation ids
 *   exclude `created_at` (lib/assertionLog.ts), so a retry is recognised by
 *   id before append rather than tripping the immutability collision.
 *
 * - **Corrections are appends by their author.** A correction is a NEW
 *   assertion (`supersedes`) plus a revocation of the old one pointing at
 *   it; a retraction is the revocation alone. Only the assertion's author
 *   may do either — the owner included. What the OWNER has instead is
 *   MODERATION: a revocation attributed to the owner under its own
 *   procedure, so the record always says who retired a claim and in what
 *   capacity.
 *
 * - **The feed is a log, not a cache.** It carries the receive time and the
 *   credential each event arrived through, which the events themselves
 *   deliberately do not. Rebuilding it from the other logs would lose both,
 *   so it is retained like them.
 *
 * One writer process per vault (bin/shared.ts takes a pid lock): the feed's
 * sequence is assigned in memory from the file's tail and every write is a
 * synchronous block, so in-process concurrency cannot interleave two
 * sequence numbers. The event files themselves are create-only either way.
 */

import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import {
  appendAssertionEvent,
  assertionEntityId,
  assertionEventRel,
  createAssertionEvent,
  listAssertionEventFiles,
  validateAssertionEvent,
  type AssertionEntity,
  type AssertionEvent,
} from "./assertionLog";
import { parseEventFile, type EventFile } from "./eventLog";
import { ensureDir } from "./fsx";
import { sha256hex } from "./hash";
import { AST_ID, ENTITY_LINK, ENT_ID, norm } from "./ids";
import {
  appendSourceInsertionEvent,
  insertionEventRel,
  listSourceInsertionEventFiles,
  validateSourceInsertion,
  type EventAuthor,
  type SourceInsertion,
} from "./insertionLog";
import {
  appendRevocationEvent,
  createRevocationEvent,
  listRevocationEventFiles,
  revocationEventRel,
  validateRevocationEvent,
  type RevocationEvent,
} from "./revocationLog";
import type { SharedActor } from "./sharedMembers";

export const SHARED_FEED_DIR = "log/shared-feed";
const FEED_FILE = "feed.ndjson";

/** Page caps — a client resumes from a cursor, so no page needs to be big. */
export const FEED_PAGE_CAP = 200;
export const LIST_PAGE_CAP = 200;
export const SEARCH_CAP = 50;
export const MAX_EVIDENCE_BYTES = 1024 * 1024;
export const MAX_SOURCES_PER_ASSERTION = 20;

const INS_ID = /^ins_[a-f0-9]{24}$/u;

/** A refusal with the HTTP status it deserves; the message says what would
 * work. The door maps it 1:1. */
export class SharedVaultError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 413,
    message: string
  ) {
    super(message);
  }
}

export interface FeedActor {
  handle: string;
  member_id: string;
  kind: SharedActor["kind"];
  credential_id: string;
  role: SharedActor["role"];
}

export type FeedEntry = {
  seq: number;
  /** Server receive time — the one timestamp evidence does not carry itself. */
  at: string;
  path: string;
  actor: FeedActor;
} & (
  | { kind: "evidence"; id: string; source_id: string }
  | { kind: "assertion"; id: string; supersedes?: string }
  | { kind: "revocation"; id: string; assertion_id: string; superseded_by?: string; mode: "correction" | "retraction" | "moderation" }
);

/** A feed entry before its sequence number — `Omit` distributed over the
 * union, so each variant keeps its own fields. */
export type FeedInput = FeedEntry extends infer T ? (T extends FeedEntry ? Omit<T, "seq"> : never) : never;

export interface FeedPage {
  entries: FeedEntry[];
  /** Pass back as `after` to continue; equals `head` when caught up. */
  next_cursor: number;
  has_more: boolean;
  head: number;
}

export interface EvidenceDraft {
  title: string;
  body: string;
  origin?: { id?: string; author?: string; kind?: string; url?: string; date?: string };
}

export interface AssertionDraft {
  text: string;
  sources: string[];
  confidence?: AssertionEvent["confidence"];
}

export interface AssertionView {
  assertion: AssertionEvent;
  /** The revocation that retired it, when one has. */
  revocation: RevocationEvent | null;
  /** Follow supersession to what stands today (itself when live). */
  resolved_id: string;
}

export interface SearchHit {
  kind: "evidence" | "assertion";
  id: string;
  /** The evidence title, or the assertion text. */
  text: string;
  author: EventAuthor;
  snippet: string;
  score: number;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Body keys that would NAME the actor or the event: each is derived from
 * the credential or computed, and a request that supplies one is refused
 * outright rather than silently overridden — a client that thinks it can
 * set these has the wrong model, and should learn so. */
export const FORGED_KEYS = [
  "author", "actor", "submitted_by", "submitted_by_id", "submitted_via", "submitted_kind", "on_behalf_of",
  "member", "member_id", "credential", "credential_id", "id", "source_id", "received", "received_at", "from",
  "from_kind", "envelope", "produced_by", "created_at", "author_verified", "supersedes", "entities", "seq",
] as const;

export function refuseForgedKeys(body: Record<string, unknown>, where = "body", except: readonly string[] = []): void {
  for (const key of FORGED_KEYS)
    if (key in body && !except.includes(key))
      throw new SharedVaultError(400, `forged authorship: "${where}.${key}" is derived from your credential or computed by the vault and cannot be supplied`);
}

export function actorAuthor(actor: SharedActor): EventAuthor {
  // An agent credential writes as the member's delegate — kind says so,
  // the id says whose — and a person credential as the person. Neither
  // can produce the other's author.
  return actor.kind === "agent" ? { kind: "agent", id: actor.handle } : { kind: "user", id: actor.handle };
}

const feedActor = (actor: SharedActor): FeedActor => ({
  handle: actor.handle,
  member_id: actor.member_id,
  kind: actor.kind,
  credential_id: actor.credential_id,
  role: actor.role,
});

/** Plain code-unit order — the same order `pageBy` compares cursors in.
 * (localeCompare would sort differently from `<`, and a cursor is a `<`.) */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const oneLine = (what: string, value: unknown, min: number, max: number): string => {
  if (typeof value !== "string") throw new SharedVaultError(400, `${what} must be a string`);
  const v = value.trim().replace(/\s+/gu, " ");
  if (v.length < min || v.length > max || /\p{Cc}/u.test(v))
    throw new SharedVaultError(400, `${what} must be one ${min}-${max} character line`);
  return v;
};

// ── the feed ────────────────────────────────────────────────────────────────

class Feed {
  private readonly abs: string;
  private headSeq: number;
  /** event id → seq, so a retry can answer with the ORIGINAL entry's seq,
   * and an event that landed without its feed line (a crash between the
   * two appends) gets one on the retry rather than never. */
  private seqs = new Map<string, number>();

  constructor(private readonly root: string) {
    this.abs = join(root, SHARED_FEED_DIR, FEED_FILE);
    const all = this.readAll();
    this.headSeq = all.at(-1)?.seq ?? 0;
    for (const row of all) this.seqs.set(row.id, row.seq);
  }

  head(): number {
    return this.headSeq;
  }

  seqOf(eventId: string): number | undefined {
    return this.seqs.get(eventId);
  }

  /** The entry for an event, appended now if the feed lacks it. */
  ensure(entry: FeedInput): { seq: number; appended: boolean } {
    const known = this.seqs.get(entry.id);
    if (known !== undefined) return { seq: known, appended: false };
    return { seq: this.append(entry).seq, appended: true };
  }

  /** Every complete line, in sequence. A trailing partial line (a torn
   * write) is not part of the feed; a line that does not parse, or whose
   * seq does not advance, is skipped — a damaged feed still answers with
   * what it has, in order. */
  private readAll(): FeedEntry[] {
    if (!existsSync(this.abs)) return [];
    const text = readFileSync(this.abs, "utf8");
    const out: FeedEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as FeedEntry;
        if (typeof row.seq === "number" && row.seq > (out.at(-1)?.seq ?? 0)) out.push(row);
      } catch {
        /* skip */
      }
    }
    return out;
  }

  /** The file's tail: the last complete line's seq, and whether the file
   * ends in a newline at all — a torn append leaves it not ending in one,
   * and the next append must start a new line rather than glue itself to
   * the fragment. Cheap enough to run before every append. */
  private tail(): { seq: number; terminated: boolean } {
    if (!existsSync(this.abs)) return { seq: 0, terminated: true };
    const fd = openSync(this.abs, "r");
    try {
      const size = fstatSync(fd).size;
      if (!size) return { seq: 0, terminated: true };
      const span = Math.min(size, 16 * 1024);
      const buf = Buffer.alloc(span);
      readSync(fd, buf, 0, span, size - span);
      const text = buf.toString("utf8");
      const terminated = text.endsWith("\n");
      const lines = text.split("\n");
      // The last element is "" after a complete line, or a torn partial.
      for (let i = lines.length - 2; i >= 0; i--) {
        try {
          const seq = (JSON.parse(lines[i]!) as FeedEntry).seq;
          if (typeof seq === "number") return { seq, terminated };
        } catch {
          /* a torn or damaged line — look one further back */
        }
      }
      return { seq: span < size ? this.readAll().at(-1)?.seq ?? 0 : 0, terminated };
    } finally {
      closeSync(fd);
    }
  }

  append(entry: FeedInput): FeedEntry {
    ensureDir(join(this.root, SHARED_FEED_DIR));
    // Re-check the tail: if another process appended (it should not — the
    // server holds a pid lock — but a hand-run CLI might), continue from
    // what is on disk rather than reissuing a sequence number.
    const tail = this.tail();
    if (tail.seq > this.headSeq) this.headSeq = tail.seq;
    const full = { seq: this.headSeq + 1, ...entry } as FeedEntry;
    appendFileSync(this.abs, `${tail.terminated ? "" : "\n"}${JSON.stringify(full)}\n`);
    this.headSeq = full.seq;
    this.seqs.set(full.id, full.seq);
    return full;
  }

  page(after: number, limit: number): FeedPage {
    const all = this.readAll();
    const head = all.at(-1)?.seq ?? 0;
    if (head > this.headSeq) {
      this.headSeq = head;
      for (const row of all) this.seqs.set(row.id, row.seq);
    }
    // By seq, not by line index — the two agree on a healthy feed and
    // only the seq is a promise to the client.
    const entries: FeedEntry[] = [];
    for (const row of all) {
      if (row.seq <= after) continue;
      if (entries.length >= limit) break;
      entries.push(row);
    }
    const next = entries.at(-1)?.seq ?? Math.min(after, head);
    return { entries, next_cursor: next, has_more: next < head, head };
  }
}

// ── an id → file index over one log ─────────────────────────────────────────

class EventIndex<T extends { id: string }> {
  private files = new Map<string, EventFile>();
  private parsed = new Map<string, T>();

  constructor(
    private readonly root: string,
    private readonly list: (root: string) => EventFile[],
    private readonly validate: (event: T) => void
  ) {
    this.refresh();
  }

  refresh(): void {
    this.files = new Map(this.list(this.root).map((f) => [f.id, f]));
  }

  /** Is this id on disk? A miss re-lists once — the common case for a NEW
   * event is a miss, and the listing is what makes a stale in-memory view
   * impossible to write against. */
  has(id: string): boolean {
    if (this.files.has(id)) return true;
    this.refresh();
    return this.files.has(id);
  }

  note(event: T, rel: string): void {
    this.files.set(event.id, { id: event.id, abs: join(this.root, rel) });
    this.parsed.set(event.id, event);
  }

  get(id: string): T | undefined {
    const cached = this.parsed.get(id);
    if (cached) return cached;
    if (!this.has(id)) return undefined;
    try {
      const event = parseEventFile<T>(this.files.get(id)!, this.validate);
      this.parsed.set(id, event);
      return event;
    } catch {
      return undefined;
    }
  }

  /** Every valid event, parsed (cached after the first read). */
  all(): T[] {
    this.refresh();
    const out: T[] = [];
    for (const id of this.files.keys()) {
      const event = this.get(id);
      if (event) out.push(event);
    }
    return out;
  }
}

// ── the vault ───────────────────────────────────────────────────────────────

export interface SharedVaultOpts {
  now?: () => Date;
}

export class SharedVault {
  private readonly now: () => Date;
  private readonly feedLog: Feed;
  private readonly insertions: EventIndex<SourceInsertion>;
  private readonly assertions: EventIndex<AssertionEvent>;
  private readonly revocations: EventIndex<RevocationEvent>;

  constructor(
    public readonly root: string,
    opts: SharedVaultOpts = {}
  ) {
    this.now = opts.now ?? (() => new Date());
    this.feedLog = new Feed(root);
    this.insertions = new EventIndex<SourceInsertion>(root, listSourceInsertionEventFiles, validateSourceInsertion);
    this.assertions = new EventIndex<AssertionEvent>(root, listAssertionEventFiles, validateAssertionEvent);
    this.revocations = new EventIndex<RevocationEvent>(root, listRevocationEventFiles, validateRevocationEvent);
  }

  head(): number {
    return this.feedLog.head();
  }

  /** Event ids on disk that the feed does not carry — a crash between an
   * event append and its feed line leaves one until the retry heals it.
   * An operator's drift check (`bigbrain shared inspect`). */
  missingFromFeed(): string[] {
    const out: string[] = [];
    for (const index of [this.insertions, this.assertions, this.revocations])
      for (const event of index.all()) if (this.feedLog.seqOf(event.id) === undefined) out.push(event.id);
    return out;
  }

  feed(after: number, limit: number): FeedPage {
    if (!Number.isInteger(after) || after < 0)
      throw new SharedVaultError(400, "after must be a non-negative integer sequence number (0 = from the start)");
    if (!Number.isInteger(limit) || limit < 1 || limit > FEED_PAGE_CAP)
      throw new SharedVaultError(400, `limit must be 1-${FEED_PAGE_CAP}`);
    return this.feedLog.page(after, limit);
  }

  // ── evidence ──────────────────────────────────────────────────────────

  /** Land evidence. The event is a pure function of (actor, draft): a
   * retry is byte-identical and dedupes; the receive time rides in the
   * feed entry, which is written only for a NEW event. */
  dropEvidence(actor: SharedActor, raw: unknown): { insertion: SourceInsertion; deduped: boolean; seq: number } {
    if (!isPlainObject(raw)) throw new SharedVaultError(400, "evidence must be a JSON object {title, body, origin?}");
    refuseForgedKeys(raw);
    for (const key of Object.keys(raw))
      if (!["title", "body", "origin"].includes(key))
        throw new SharedVaultError(400, `unknown evidence field "${key}" — use title, body, origin`);
    const title = oneLine("title", raw["title"], 1, 300);
    if (typeof raw["body"] !== "string" || !raw["body"].trim())
      throw new SharedVaultError(400, "body must be a non-empty string");
    const body = raw["body"];
    if (Buffer.byteLength(body) > MAX_EVIDENCE_BYTES)
      throw new SharedVaultError(413, `body exceeds ${MAX_EVIDENCE_BYTES} bytes`);

    const origin: { id?: string; author?: string; kind?: string; url?: string; date?: string } = {};
    if (raw["origin"] !== undefined) {
      if (!isPlainObject(raw["origin"])) throw new SharedVaultError(400, "origin must be an object");
      const o = raw["origin"];
      // `origin.author` and `origin.id` are the CLAIMED source author and
      // identity — data the submitter reports, stored as reported and
      // flagged unverified; they are the one place a name may be supplied.
      refuseForgedKeys(o, "origin", ["author", "id"]);
      for (const key of Object.keys(o))
        if (!["id", "author", "kind", "url", "date"].includes(key))
          throw new SharedVaultError(400, `unknown origin field "${key}" — use id, author, kind, url, date`);
      if (o["id"] !== undefined) origin.id = oneLine("origin.id", o["id"], 1, 200);
      if (o["author"] !== undefined) origin.author = oneLine("origin.author", o["author"], 1, 200);
      if (o["kind"] !== undefined) {
        if (typeof o["kind"] !== "string" || !/^[a-z][a-z0-9-]{0,31}$/u.test(o["kind"]))
          throw new SharedVaultError(400, "origin.kind must be a short lowercase slug (e.g. note, email, meeting)");
        origin.kind = o["kind"];
      }
      if (o["url"] !== undefined) {
        const url = oneLine("origin.url", o["url"], 1, 2000);
        if (!/^https?:\/\/\S+$/u.test(url)) throw new SharedVaultError(400, "origin.url must be an http(s) URL");
        origin.url = url;
      }
      if (o["date"] !== undefined) {
        const date = oneLine("origin.date", o["date"], 1, 40);
        if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/u.test(date) || !Number.isFinite(Date.parse(date)))
          throw new SharedVaultError(400, "origin.date must be YYYY-MM-DD or an ISO-8601 timestamp");
        origin.date = date;
      }
    }

    // Whose words: the submitter's own unless they say otherwise. Verified
    // only when a PERSON credential submits its own words — an agent's
    // submission of "alice's words" is a claim like any other.
    const originAuthor = origin.author ?? actor.handle;
    const authorVerified = originAuthor === actor.handle && actor.kind === "person";
    const sourceId = origin.id
      ? `origin:${origin.id}`
      : `shared:${sha256hex(`${title}\u0000${body}\u0000${originAuthor}`).slice(0, 24)}`;
    const envelope: Record<string, unknown> = {
      id: sourceId,
      kind: origin.kind ?? "note",
      title,
      ...(origin.date ? { date: origin.date } : {}),
      ...(origin.url ? { url: origin.url } : {}),
      origin: {
        id: sourceId,
        author: originAuthor,
        author_verified: authorVerified,
        ...(origin.kind ? { kind: origin.kind } : {}),
        ...(origin.url ? { url: origin.url } : {}),
        ...(origin.date ? { date: origin.date } : {}),
      },
      source: "shared-vault",
      submitted_by: actor.handle,
      submitted_by_id: actor.member_id,
      submitted_kind: actor.kind,
      submitted_via: actor.credential_id,
    };
    const contentSha256 = sha256hex(`${JSON.stringify(envelope)}\n${body}`);
    const event: SourceInsertion = {
      event: "source.inserted",
      id: `ins_${sha256hex(`${sourceId}\u0000${contentSha256}`).slice(0, 24)}`,
      source_id: sourceId,
      author: actorAuthor(actor),
      title,
      body,
      envelope,
      ...(origin.date ? { occurred_at: origin.date } : {}),
      content_sha256: contentSha256,
    };
    const result = appendSourceInsertionEvent(this.root, event, { wake: false });
    this.insertions.note(event, result.path);
    // A dedupe still ENSURES the feed line: the one crash window in this
    // method is between the event append and the feed append, and a retry
    // is how the record heals — with the original seq when there is one.
    const feed = this.feedLog.ensure({
      at: this.now().toISOString(),
      kind: "evidence",
      id: event.id,
      source_id: sourceId,
      path: result.path,
      actor: feedActor(actor),
    });
    return { insertion: event, deduped: result.deduped && !feed.appended, seq: feed.seq };
  }

  evidence(id: string): SourceInsertion | undefined {
    if (!INS_ID.test(id)) throw new SharedVaultError(400, "not an insertion id (ins_ + 24 hex)");
    return this.insertions.get(id);
  }

  listEvidence(opts: { limit: number; cursor?: string | null }): Page<SourceInsertion> {
    const rows = this.insertions.all().sort((a, b) => cmp(a.id, b.id));
    return pageBy(rows, (r) => r.id, opts);
  }

  // ── assertions ────────────────────────────────────────────────────────

  private draftAssertion(raw: unknown, allowReason = false): AssertionDraft & { reason?: string } {
    if (!isPlainObject(raw)) throw new SharedVaultError(400, "an assertion is a JSON object {text, sources, confidence?}");
    refuseForgedKeys(raw);
    const allowed = ["text", "sources", "confidence", ...(allowReason ? ["reason"] : [])];
    for (const key of Object.keys(raw))
      if (!allowed.includes(key)) throw new SharedVaultError(400, `unknown assertion field "${key}" — use ${allowed.join(", ")}`);
    const text = oneLine("text", raw["text"], 12, 2000);
    const sources = raw["sources"];
    if (!Array.isArray(sources) || !sources.length || sources.length > MAX_SOURCES_PER_ASSERTION)
      throw new SharedVaultError(400, `sources must list 1-${MAX_SOURCES_PER_ASSERTION} insertion ids the assertion rests on`);
    for (const s of sources)
      if (typeof s !== "string" || !INS_ID.test(s))
        throw new SharedVaultError(400, `invalid citation ${JSON.stringify(s)} — cite insertion ids (ins_ + 24 hex)`);
    const confidence = raw["confidence"] ?? "direct";
    if (confidence !== "direct" && confidence !== "candidate")
      throw new SharedVaultError(400, "confidence must be direct or candidate");
    const out: AssertionDraft & { reason?: string } = { text, sources: [...new Set(sources as string[])], confidence };
    if (allowReason && raw["reason"] !== undefined) out.reason = oneLine("reason", raw["reason"], 1, 2000);
    return out;
  }

  /** `[[Label]]` → `[[ent_…|Label]]`, ids cut from the label the way the
   * engine cuts them (assertionEntityId). A client that writes an id must
   * write the one the label yields — entity ids are derived, never minted
   * by a writer. Entity aliasing across labels is out of this slice. */
  private canonicalize(text: string): { text: string; entities: AssertionEntity[] } {
    const entities = new Map<string, AssertionEntity>();
    const canonical = text.replace(ENTITY_LINK, (_whole, rawTarget: string, rawDisplay?: string) => {
      const target = rawTarget.trim();
      const display = (rawDisplay ?? "").trim();
      let id: string;
      let label: string;
      if (ENT_ID.test(target)) {
        if (!display) throw new SharedVaultError(400, `link [[${target}]] names an id without a label — write [[Label]]`);
        label = display;
        id = assertionEntityId(label);
        if (id !== target)
          throw new SharedVaultError(400, `link [[${target}|${display}]] — entity ids are derived from labels; write [[${display}]]`);
      } else {
        label = target;
        if (!norm(label)) throw new SharedVaultError(400, "an empty [[link]] names nothing");
        id = assertionEntityId(label);
      }
      const prior = entities.get(id);
      if (prior && norm(prior.label) !== norm(label))
        throw new SharedVaultError(400, `conflicting labels for one entity: ${prior.label} / ${label}`);
      entities.set(id, prior ?? { id, label: label.replace(/\s+/gu, " ") });
      return `[[${id}|${display || label}]]`;
    });
    return { text: canonical, entities: [...entities.values()] };
  }

  private citedSources(ids: readonly string[]): Map<string, SourceInsertion> {
    const out = new Map<string, SourceInsertion>();
    for (const id of ids) {
      const source = this.insertions.get(id);
      if (!source) throw new SharedVaultError(400, `invalid citation: no evidence ${id} in this vault`);
      out.set(id, source);
    }
    return out;
  }

  private buildAssertion(actor: SharedActor, draft: AssertionDraft, supersedes?: string): AssertionEvent {
    const { text, entities } = this.canonicalize(draft.text);
    const sources = this.citedSources(draft.sources);
    try {
      return createAssertionEvent(
        {
          text,
          entities,
          sources: draft.sources,
          author: actorAuthor(actor),
          confidence: draft.confidence ?? "direct",
          created_at: this.now().toISOString(),
          produced_by: { procedure: "shared-vault", version: "1" },
          ...(supersedes ? { supersedes } : {}),
        },
        sources
      );
    } catch (error) {
      throw new SharedVaultError(400, error instanceof Error ? error.message : String(error));
    }
  }

  /** Append an assertion, recognising a retry by id (the id excludes
   * `created_at`), and feed it only when new. */
  private landAssertion(actor: SharedActor, event: AssertionEvent): { deduped: boolean; seq: number } {
    const rel = assertionEventRel(event);
    let deduped = true;
    if (!this.assertions.has(event.id)) {
      const result = appendAssertionEvent(this.root, event);
      this.assertions.note(event, result.path);
      deduped = result.deduped;
    }
    const feed = this.feedLog.ensure({
      at: this.now().toISOString(),
      kind: "assertion",
      id: event.id,
      ...(event.supersedes ? { supersedes: event.supersedes } : {}),
      path: rel,
      actor: feedActor(actor),
    });
    return { deduped: deduped && !feed.appended, seq: feed.seq };
  }

  private landRevocation(
    actor: SharedActor,
    event: RevocationEvent,
    mode: "correction" | "retraction" | "moderation"
  ): { deduped: boolean; seq: number } {
    const rel = revocationEventRel(event);
    let deduped = true;
    if (!this.revocations.has(event.id)) {
      const result = appendRevocationEvent(this.root, event);
      this.revocations.note(event, result.path);
      deduped = result.deduped;
    }
    const feed = this.feedLog.ensure({
      at: this.now().toISOString(),
      kind: "revocation",
      id: event.id,
      assertion_id: event.assertion_id,
      ...(event.superseded_by ? { superseded_by: event.superseded_by } : {}),
      mode,
      path: rel,
      actor: feedActor(actor),
    });
    return { deduped: deduped && !feed.appended, seq: feed.seq };
  }

  assert(actor: SharedActor, raw: unknown): { assertion: AssertionEvent; deduped: boolean; seq: number } {
    const draft = this.draftAssertion(raw);
    const event = this.buildAssertion(actor, draft);
    return { assertion: event, ...this.landAssertion(actor, event) };
  }

  /** The revoked set, assertion id → its FIRST revocation by (created_at, id)
   * — the engine's rule when several name one assertion. */
  private revokedMap(): Map<string, RevocationEvent> {
    const out = new Map<string, RevocationEvent>();
    const rows = this.revocations.all().sort((a, b) => cmp(a.created_at, b.created_at) || cmp(a.id, b.id));
    for (const row of rows) if (!out.has(row.assertion_id)) out.set(row.assertion_id, row);
    return out;
  }

  private view(event: AssertionEvent, revoked: ReadonlyMap<string, RevocationEvent>): AssertionView {
    const seen = new Set<string>();
    let at = event.id;
    while (!seen.has(at)) {
      seen.add(at);
      const next = revoked.get(at)?.superseded_by;
      if (!next || !this.assertions.has(next)) break;
      at = next;
    }
    return { assertion: event, revocation: revoked.get(event.id) ?? null, resolved_id: at };
  }

  assertion(id: string): AssertionView | undefined {
    if (!AST_ID.test(id)) throw new SharedVaultError(400, "not an assertion id (ast_ + 24 hex)");
    const event = this.assertions.get(id);
    return event ? this.view(event, this.revokedMap()) : undefined;
  }

  listAssertions(opts: { limit: number; cursor?: string | null; includeRevoked?: boolean }): Page<AssertionView> {
    const revoked = this.revokedMap();
    const rows = this.assertions
      .all()
      .filter((a) => opts.includeRevoked || !revoked.has(a.id))
      .sort((a, b) => cmp(a.created_at, b.created_at) || cmp(a.id, b.id));
    const page = pageBy(rows, (a) => `${a.created_at}\u0000${a.id}`, opts);
    return { items: page.items.map((a) => this.view(a, revoked)), next_cursor: page.next_cursor };
  }

  /** Whose assertion, and does it still stand — the two questions every
   * correction path asks first. Ownership is by HANDLE, so a member and
   * the agent acting for them own the same assertions. */
  private ownedLive(actor: SharedActor, id: string, verb: string): AssertionView {
    const view = this.assertion(id);
    if (!view) throw new SharedVaultError(404, `no assertion ${id}`);
    if (view.assertion.author.id !== actor.handle)
      throw new SharedVaultError(403, `only its author (${view.assertion.author.id}) can ${verb} ${id}; the owner may moderate it instead`);
    if (view.revocation)
      throw new SharedVaultError(409, `${id} is already revoked by ${view.revocation.id}${view.revocation.superseded_by ? ` (superseded by ${view.revocation.superseded_by})` : ""}`);
    return view;
  }

  /** A correction: the author's NEW assertion superseding the old, and the
   * revocation that points the old at it. Two appends, both idempotent, in
   * the order that leaves the record sane if interrupted between them (a
   * superseding assertion without its revocation just coexists until the
   * retry lands the revocation). */
  correct(
    actor: SharedActor,
    id: string,
    raw: unknown
  ): { assertion: AssertionEvent; revocation: RevocationEvent; deduped: boolean; seq: number } {
    if (!AST_ID.test(id)) throw new SharedVaultError(400, "not an assertion id (ast_ + 24 hex)");
    const draft = this.draftAssertion(raw, true);
    this.ownedLive(actor, id, "correct");
    const event = this.buildAssertion(actor, draft, id);
    const landed = this.landAssertion(actor, event);
    const revocation = createRevocationEvent({
      assertion_id: id,
      superseded_by: event.id,
      reason: draft.reason ?? "corrected by its author",
      author: actorAuthor(actor),
      created_at: this.now().toISOString(),
      produced_by: { procedure: "shared-vault/correction", version: "1" },
    });
    const rev = this.landRevocation(actor, revocation, "correction");
    return { assertion: event, revocation, deduped: landed.deduped && rev.deduped, seq: rev.seq };
  }

  /** A retraction: the author's revocation with no successor. */
  retract(actor: SharedActor, id: string, raw: unknown): { revocation: RevocationEvent; deduped: boolean; seq: number } {
    if (!AST_ID.test(id)) throw new SharedVaultError(400, "not an assertion id (ast_ + 24 hex)");
    if (!isPlainObject(raw)) throw new SharedVaultError(400, "a retraction is a JSON object {reason}");
    refuseForgedKeys(raw);
    const reason = oneLine("reason", raw["reason"], 1, 2000);
    this.ownedLive(actor, id, "retract");
    const revocation = createRevocationEvent({
      assertion_id: id,
      reason,
      author: actorAuthor(actor),
      created_at: this.now().toISOString(),
      produced_by: { procedure: "shared-vault/retraction", version: "1" },
    });
    return { revocation, ...this.landRevocation(actor, revocation, "retraction") };
  }

  /** Moderation: the OWNER retires anyone's assertion, attributed to the
   * owner under its own procedure — never disguised as the author's
   * correction. The assertion's author and text are untouched. */
  moderate(actor: SharedActor, raw: unknown): { revocation: RevocationEvent; deduped: boolean; seq: number } {
    if (actor.role !== "owner") throw new SharedVaultError(403, "only the vault owner may moderate");
    if (!isPlainObject(raw)) throw new SharedVaultError(400, "moderation is a JSON object {assertion_id, reason}");
    refuseForgedKeys(raw);
    const id = raw["assertion_id"];
    if (typeof id !== "string" || !AST_ID.test(id)) throw new SharedVaultError(400, "assertion_id must be an assertion id (ast_ + 24 hex)");
    const reason = oneLine("reason", raw["reason"], 1, 2000);
    const view = this.assertion(id);
    if (!view) throw new SharedVaultError(404, `no assertion ${id}`);
    if (view.revocation) throw new SharedVaultError(409, `${id} is already revoked by ${view.revocation.id}`);
    const revocation = createRevocationEvent({
      assertion_id: id,
      reason,
      author: actorAuthor(actor),
      created_at: this.now().toISOString(),
      produced_by: { procedure: "shared-vault/moderation", version: "1" },
    });
    return { revocation, ...this.landRevocation(actor, revocation, "moderation") };
  }

  // ── search ────────────────────────────────────────────────────────────

  /** Term-AND over evidence titles/bodies and LIVE assertion text. A scan,
   * bounded by the caps; a ranked index is the engine's job once the
   * shared record grows past what a scan answers in time. */
  search(q: string, limit: number): SearchHit[] {
    const query = q.trim().toLowerCase();
    if (!query || query.length > 200) throw new SharedVaultError(400, "q must be 1-200 characters");
    if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_CAP) throw new SharedVaultError(400, `limit must be 1-${SEARCH_CAP}`);
    const terms = [...new Set(query.split(/[^\p{L}\p{N}_-]+/u).filter((t) => t.length > 0))].slice(0, 8);
    if (!terms.length) return [];
    const score = (hay: string): number => {
      const lower = hay.toLowerCase();
      let total = 0;
      for (const term of terms) {
        let n = 0;
        for (let i = lower.indexOf(term); i !== -1; i = lower.indexOf(term, i + term.length)) n++;
        if (!n) return 0;
        total += n;
      }
      return total;
    };
    const snippet = (hay: string): string => {
      const lower = hay.toLowerCase();
      const at = Math.max(0, lower.indexOf(terms[0]!) - 60);
      return hay.slice(at, at + 180).replace(/\s+/gu, " ").trim();
    };
    const hits: SearchHit[] = [];
    for (const e of this.insertions.all()) {
      const s = score(`${e.title}\n${e.body}`);
      if (s) hits.push({ kind: "evidence", id: e.id, text: e.title, author: e.author, snippet: snippet(`${e.title}\n${e.body}`), score: s });
    }
    const revoked = this.revokedMap();
    for (const a of this.assertions.all()) {
      if (revoked.has(a.id)) continue;
      const s = score(a.text);
      if (s) hits.push({ kind: "assertion", id: a.id, text: a.text, author: a.author, snippet: snippet(a.text), score: s });
    }
    return hits.sort((x, y) => y.score - x.score || cmp(x.id, y.id)).slice(0, limit);
  }
}

/** Keyset pagination over rows already sorted by `key`. The cursor is the
 * last row's key, base64url — opaque on the wire, cheap to check. */
function pageBy<T>(rows: T[], key: (row: T) => string, opts: { limit: number; cursor?: string | null }): Page<T> {
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > LIST_PAGE_CAP)
    throw new SharedVaultError(400, `limit must be 1-${LIST_PAGE_CAP}`);
  let from = 0;
  if (opts.cursor) {
    if (opts.cursor.length > 512) throw new SharedVaultError(400, "bad cursor");
    let decoded: string;
    try {
      decoded = Buffer.from(opts.cursor, "base64url").toString("utf8");
    } catch {
      throw new SharedVaultError(400, "bad cursor");
    }
    if (!decoded) throw new SharedVaultError(400, "bad cursor");
    from = rows.findIndex((row) => key(row) > decoded);
    if (from === -1) from = rows.length;
  }
  const items = rows.slice(from, from + opts.limit);
  const last = items.at(-1);
  const more = from + items.length < rows.length;
  return { items, next_cursor: more && last ? Buffer.from(key(last), "utf8").toString("base64url") : null };
}

/** Vault-relative paths of the three engine logs plus the feed — what the
 * shared-vault server reads and writes, and NOTHING else under the root. */
export const SHARED_LOG_RELS = {
  insertion: insertionEventRel,
  assertion: assertionEventRel,
  revocation: revocationEventRel,
  feed: `${SHARED_FEED_DIR}/${FEED_FILE}`,
};
