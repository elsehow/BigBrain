/** work.ts — the queue is a VIEW over the logs (#520, work-as-a-view,
 * docs/plans/2026-08-23-work-as-a-view.md).
 *
 * All inputs are arrivals. All outputs are appended events. Nothing here is
 * enqueued, claimed, moved, or stored: `dueWork` is a projection query — a
 * job exists because the logs do not yet satisfy it — and `submitWork`
 * appends events, after which the job disappears because the view
 * recomputes. Declines settle exactly like assertions (a durable no is an
 * answer). Delete `.state/` and replay the logs: the same due set comes
 * back.
 *
 * NO claim state, by decision (2026-08-23, #479): single-flight is the
 * CALLER's job via the pid-liveness lock (`acquireAssertionLock`) on the
 * one machine designated tender. `nextWork` is a pure read; `submitWork`
 * is per-ITEM idempotent, so partial progress is durable and a lost caller
 * loses at most one un-submitted batch.
 *
 * Job kinds now: `intake` (an insertion no assertion and no decline cites),
 * `memory` (the pass's due-check behind the same interface), and `staged`
 * (what a poller found and the record does not yet hold — lib/stage.ts;
 * the one kind that is a cache read, not a projection query, because a
 * staged arrival is by definition not in the logs yet). Later kinds —
 * voice, materialize (#326), refresh (#325), synthesize (#53) — are more
 * arms of this function, not new producers.
 */

import type { Database } from "bun:sqlite";
import { ASSERTION_AGENT_MAX_BATCH, createAssertionLinkCanonicalizer } from "./assertionAgent";
import { bindMintedEntities } from "./entitySourceSeed";
import {
  assertionEventRel,
  commitAssertionEvents,
  createAssertionEvent,
  type AssertionEntity,
  type AssertionEvent,
  type AssertionProduction,
} from "./assertionLog";
import {
  appendAndProjectAssertion,
  appendAndProjectDecline,
  assertionIdsExist,
  openAssertionProjectionReadonly,
  projectedSourcesById,
  syncAssertionProjection,
} from "./assertionProjection";
import {
  commitDeclineEvents,
  createDeclineEvent,
  declineEventRel,
  type DeclineEvent,
} from "./declineLog";
import { liveSourceSql, supersedesOf } from "./sourceSupersede";
import {
  admitStaged,
  passStaged,
  STAGE_BATCH_LIMIT,
  stagedHeads,
  type AdmitResult,
  type PassResult,
  type StagedHead,
} from "./stage";
import type { EventAuthor, SourceInsertion } from "./insertionLog";
import { memoryDue, memoryWork, readMemoryStamp, type MemoryStamp } from "./memory";
import { str } from "./text";
import { aboutIds } from "./voiceFacts";
import { renderUserSide, userSide } from "./transcriptProjection";

/** One pull's ceiling — the intake batch size the runner already holds. */
export const WORK_BATCH_LIMIT = ASSERTION_AGENT_MAX_BATCH;

export { classifyIntake, type IntakeClass, type IntakeEnvelopeFacts } from "./intakeClass";
import { classifyIntake, type IntakeClass } from "./intakeClass";

// ── the view ────────────────────────────────────────────────────────────────

export interface IntakeJob {
  kind: "intake";
  insertion_id: string;
  source_id: string;
  title: string;
  /** The rank's class — or `agent-chat`, a session whose owner's side is
   * the item (lib/intakeClass.ts intakePriority). */
  class: IntakeClass | "agent-chat";
  /** The insertion-log reader's sort key (`received_at ?? occurred_at`). */
  at: string;
}

export interface MemoryJob {
  kind: "memory";
  reason: string;
  /** Assertion events past the memory cursor. */
  assertions: number;
  /** Voice arrivals past the memory cursor, waiting for the sweep (#521). */
  observations: number;
}

/** A staged arrival's head (#744): a poller found it, the record does not
 * hold it, and the gardener admits or passes it through `submit`. */
export interface StagedJob extends StagedHead {
  kind: "staged";
}

export type WorkJob = IntakeJob | MemoryJob | StagedJob;

export type WorkKind = WorkJob["kind"];

export interface DueWorkOpts {
  kinds?: readonly WorkKind[];
  /** Ceiling on INTAKE jobs returned (the memory job rides along when due;
   * staged heads have their own, STAGE_BATCH_LIMIT). Defaults to the batch
   * limit; pass more to render a backlog view. */
  limit?: number;
  now?: Date;
}

const DUE_INTAKE_FROM = `FROM sources s
  WHERE s.intake_priority IS NOT NULL AND ${liveSourceSql("s")}
    AND NOT EXISTS (SELECT 1 FROM assertion_sources a WHERE a.insertion_id = s.insertion_id)
    AND NOT EXISTS (SELECT 1 FROM declines d WHERE d.insertion_id = s.insertion_id)`;

function dueIntakeJobs(db: Database, limit = -1): IntakeJob[] {
  const rows = db.query(`SELECT s.insertion_id, s.source_id, s.title,
      s.intake_at AS at, s.intake_class AS class
    ${DUE_INTAKE_FROM}
    ORDER BY s.intake_priority, s.intake_at, s.insertion_id LIMIT ?`).all(limit) as Omit<IntakeJob, "kind">[];
  return rows.map((row) => ({ kind: "intake", ...row }));
}

function dueMemoryJob(root: string, opts: DueWorkOpts): MemoryJob | undefined {
  const due = memoryDue(root, opts.now ? { now: opts.now } : {});
  if (!due.due) return undefined;
  const work = memoryWork(root);
  return {
    kind: "memory", reason: due.reason,
    assertions: work.record,
    observations: work.voice.length,
  };
}

/** The due-work view: which jobs the logs do not yet satisfy, intake in
 * priority order (oldest first within a class). Pure over logs +
 * projections — it syncs the projection (cheap, incremental #456) and
 * queries; it never claims, stores, or moves anything. */
export const WORK_KINDS: readonly WorkKind[] = ["intake", "staged", "memory"];

export function dueWork(root: string, opts: DueWorkOpts = {}): WorkJob[] {
  const kinds = new Set(opts.kinds ?? WORK_KINDS);
  const limit = opts.limit ?? WORK_BATCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("work: limit must be a positive integer");
  const jobs: WorkJob[] = [];
  if (kinds.has("intake")) {
    syncAssertionProjection(root);
    const db = openAssertionProjectionReadonly(root);
    try {
      jobs.push(...dueIntakeJobs(db, limit));
    } finally { db.close(); }
  }
  if (kinds.has("staged"))
    for (const h of stagedHeads(root, STAGE_BATCH_LIMIT)) jobs.push({ kind: "staged", ...h });
  if (kinds.has("memory")) {
    const memory = dueMemoryJob(root, opts);
    if (memory) jobs.push(memory);
  }
  return jobs;
}

/** Every due intake id, UNCAPPED — what a tend round diffs (before against
 * after) to learn which insertions it settled, and how many are left.
 *
 * `dueWork`'s limit is a BATCH size, not a page: it is what the gardener is
 * handed to work on. tend used to spell this itself as `dueWork(…, {limit:
 * 500})`, which made `remaining` saturate at 500 on a longer backlog and
 * report a queue shorter than it was (#640). */
export function dueIntakeIds(root: string): string[] {
  syncAssertionProjection(root);
  const db = openAssertionProjectionReadonly(root);
  try {
    return dueIntakeJobs(db).map((j) => j.insertion_id);
  } finally { db.close(); }
}

/** The viewer's "N items waiting for your agent" (#494) — the same query as
 * `dueWork`, counted instead of listed, so the screen and the gardener can
 * never disagree. */
export function dueIntakeCount(root: string): number {
  syncAssertionProjection(root);
  const db = openAssertionProjectionReadonly(root);
  try {
    return (db.query(`SELECT count(*) AS n ${DUE_INTAKE_FROM}`).get() as { n: number }).n;
  } finally { db.close(); }
}

// ── context packs ───────────────────────────────────────────────────────────

export interface NeighborAssertion {
  id: string;
  text: string;
  created_at: string;
}

export interface IntakeInputs {
  /** The insertion, body capped at WORK_BODY_INLINE_CHARS — the pi source
   * tool's chunk contract (#514): a huge arrival is sliced, never silently
   * clipped by the transport. `body_truncated` says so; read_intake with
   * insertion_id/start/chars fetches the same view, without source wrappers. */
  insertion: SourceInsertion;
  body_length: number;
  body_truncated: boolean;
  /** Existing assertions citing the same source — what the record already
   * says about this object, so intake extends rather than repeats. */
  neighborhood: NeighborAssertion[];
  neighborhood_truncated: boolean;
  neighborhood_next?: number;
  /** UNSETTLED voice arrivals about this source (#521) — the user's own
   * guidance riding the job. DATA, never instructions: person voice renders
   * verbatim, agent voice framed (from_kind is the grade). Each settles by
   * being cited in the assertions it informed, or by a decline. */
  voice?: VoiceNote[];
  /** Voice-class jobs only: what this arrival is ABOUT — the record objects
   * its `about:` names, so the gardener can read the subject first. */
  about?: AboutRef[];
  /** The prior landing of the SAME source this arrival revises — the
   * envelope's `supersedes`, honored under lib/sourceSupersede.ts's rule.
   * Once this arrival is filed the record shows the revision only: every
   * assertion grounded solely on the prior landing goes dark, so the
   * `neighborhood` is what to carry forward, not what is already covered. */
  supersedes?: AboutRef;
}

/** One voice arrival attached to a job as guidance (#521). */
export interface VoiceNote {
  insertion_id: string;
  kind: string;
  from: string;
  from_kind?: string;
  at: string;
  text: string;
}

/** One record object a voice arrival points at. */
export interface AboutRef {
  source_id: string;
  insertion_id: string;
  title: string;
}

export interface MemoryInputs {
  stamp: MemoryStamp;
  assertions: number;
  observations: number;
}

/** A staged head IS its inputs: the body comes only through `open`. */
export type StagedInputs = Record<string, never>;

export type WorkItem =
  | { job: IntakeJob; inputs: IntakeInputs }
  | { job: MemoryJob; inputs: MemoryInputs }
  | { job: StagedJob; inputs: StagedInputs };

const NEIGHBORHOOD_LIMIT = 8;

/** Inline body ceiling per intake item (the pi source tool served 20k). */
export const WORK_BODY_INLINE_CHARS = 20_000;

/** The same body representation for inline intake and every continuation. */
function intakeBody(insertion: SourceInsertion): string {
  const field = (key: string) => typeof insertion.envelope[key] === "string" ? insertion.envelope[key] as string : undefined;
  return classifyIntake({ kind: field("kind"), type: field("type"), source: field("source") }) === "agent-chat"
    ? renderUserSide(userSide(insertion.body)) : insertion.body;
}

function intakeNeighborhood(db: Database, insertion: SourceInsertion, start = 0, limit = NEIGHBORHOOD_LIMIT) {
  const rows = db.query(`SELECT DISTINCT a.id, a.text, a.created_at FROM assertions a
    JOIN assertion_sources s ON s.assertion_id = a.id
    WHERE s.source_id = ? AND s.insertion_id <> ?
    ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`)
    .all(insertion.source_id, insertion.id, limit + 1, start) as NeighborAssertion[];
  return {
    neighborhood: rows.slice(0, limit),
    neighborhood_truncated: rows.length > limit,
    ...(rows.length > limit ? { neighborhood_next: start + limit } : {}),
  };
}

/** Read a landed arrival even after it has been settled. Offsets refer to
 * the body served by next, including the user-only conversation projection. */
export function readIntake(root: string, insertionId: string, opts: {
  start?: number; chars?: number; neighborhood_start?: number; neighborhood_limit?: number;
} = {}) {
  if (typeof insertionId !== "string" || !insertionId.trim()) throw new Error("missing insertion_id");
  const integer = (value: number | undefined, fallback: number, min: number, max: number) => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`expected integer ${min}–${max}`);
    return value;
  };
  const start = integer(opts.start, 0, 0, Number.MAX_SAFE_INTEGER);
  const chars = integer(opts.chars, WORK_BODY_INLINE_CHARS, 1, 80_000);
  const neighborhoodStart = integer(opts.neighborhood_start, 0, 0, Number.MAX_SAFE_INTEGER);
  const neighborhoodLimit = integer(opts.neighborhood_limit, NEIGHBORHOOD_LIMIT, 1, 100);
  syncAssertionProjection(root);
  const db = openAssertionProjectionReadonly(root);
  try {
    const insertion = projectedSourcesById(root, [insertionId], db).get(insertionId);
    if (!insertion) throw new Error(`no insertion ${insertionId}`);
    const body = intakeBody(insertion);
    const bodyStart = Math.min(start, body.length);
    const bodyEnd = Math.min(body.length, bodyStart + chars);
    return {
      insertion: { ...insertion, body: body.slice(bodyStart, bodyEnd) },
      body_start: bodyStart, body_end: bodyEnd, body_length: body.length,
      body_truncated: bodyEnd < body.length,
      ...intakeNeighborhood(db, insertion, neighborhoodStart, neighborhoodLimit),
    };
  } finally { db.close(); }
}

/** `next` = dueWork + context packs. A PURE READ — no claim, no lease, no
 * state (#479 revised): calling it twice returns the same items, and only
 * `submitWork`'s appended events make them go away. Capped at the batch
 * limit — this is the pull, not the backlog view. */
export function nextWork(root: string, opts: Omit<DueWorkOpts, "limit"> & { limit?: number } = {}): WorkItem[] {
  const limit = opts.limit ?? WORK_BATCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > WORK_BATCH_LIMIT)
    throw new Error(`work: next limit must be 1-${WORK_BATCH_LIMIT}`);
  const jobs = dueWork(root, { ...opts, limit });
  const intakeIds = jobs.flatMap((job) => (job.kind === "intake" ? [job.insertion_id] : []));
  const items: WorkItem[] = [];
  if (intakeIds.length) {
    const db = openAssertionProjectionReadonly(root);
    try {
      const insertions = projectedSourcesById(root, intakeIds, db);
      // Unsettled voice arrivals whose `about` names this job's source —
      // the same due-predicate as intake itself, so a settled directive
      // stops riding. json_each answers [] for an absent about and one row
      // for the legacy single-string stamp, so no shape check is needed.
      const voiceQ = db.query(`
        SELECT s.insertion_id, s.event_json,
          COALESCE(s.received_at, s.occurred_at, '') AS at
        FROM sources s
        LEFT JOIN assertion_sources a ON a.insertion_id = s.insertion_id
        LEFT JOIN declines d ON d.insertion_id = s.insertion_id
        WHERE a.assertion_id IS NULL AND d.decline_id IS NULL
          AND json_extract(s.event_json, '$.envelope.kind') IN ('directive', 'request')
          AND EXISTS (SELECT 1 FROM json_each(s.event_json, '$.envelope.about') je
                      WHERE je.value = ?)
        ORDER BY at, s.insertion_id`);
      const aboutQ = db.query(`
        SELECT insertion_id, source_id, title,
          MAX(COALESCE(received_at, occurred_at, '')) AS at
        FROM sources WHERE source_id = ? GROUP BY source_id`);
      const priorQ = db.query("SELECT insertion_id, source_id, title FROM sources WHERE insertion_id = ?");
      const voiceNotesFor = (job: IntakeJob): VoiceNote[] => {
        const rows = voiceQ.all(job.source_id) as {
          insertion_id: string; event_json: string; at: string;
        }[];
        const notes: VoiceNote[] = [];
        for (const row of rows) {
          if (row.insertion_id === job.insertion_id) continue;
          try {
            const event = JSON.parse(row.event_json) as SourceInsertion;
            const env = event.envelope as Record<string, unknown>;
            notes.push({
              insertion_id: event.id,
              kind: str(env["kind"]) ?? "directive",
              from: str(env["from"]) ?? event.author.id,
              ...(str(env["from_kind"]) ? { from_kind: str(env["from_kind"])! } : {}),
              at: row.at,
              text: event.body,
            });
          } catch { /* an unparseable projected row represents nothing */ }
        }
        return notes;
      };
      for (const job of jobs) {
        if (job.kind !== "intake") continue;
        const insertion = insertions.get(job.insertion_id);
        if (!insertion) throw new Error(`work: due insertion is not projected: ${job.insertion_id}`);
        const body = intakeBody(insertion);
        const truncated = body.length > WORK_BODY_INLINE_CHARS;
        const inputs: IntakeInputs = {
          insertion: { ...insertion, body: truncated ? body.slice(0, WORK_BODY_INLINE_CHARS) : body },
          body_length: body.length,
          body_truncated: truncated,
          ...intakeNeighborhood(db, insertion),
        };
        const named = supersedesOf(insertion);
        const prior = named
          ? (priorQ.get(named) as { insertion_id: string; source_id: string; title: string } | null)
          : null;
        // the same-source guard, as the readers apply it: a stranger named
        // in `supersedes` is not a revision of anything
        if (prior && prior.source_id === job.source_id) inputs.supersedes = prior;
        if (job.class === "voice") {
          const about = aboutIds(insertion.envelope as Record<string, unknown>).flatMap((id) => {
            const row = aboutQ.get(id) as
              | { insertion_id: string; source_id: string; title: string }
              | null;
            return row
              ? [{ source_id: row.source_id, insertion_id: row.insertion_id, title: row.title }]
              : [];
          });
          if (about.length) inputs.about = about;
        } else {
          const voice = voiceNotesFor(job);
          if (voice.length) inputs.voice = voice;
        }
        items.push({ job, inputs });
      }
    } finally { db.close(); }
  }
  for (const job of jobs) {
    if (job.kind === "staged") items.push({ job, inputs: {} });
    if (job.kind !== "memory") continue;
    items.push({
      job,
      inputs: { stamp: readMemoryStamp(root), assertions: job.assertions, observations: job.observations },
    });
  }
  return items;
}

// ── submit ──────────────────────────────────────────────────────────────────

export interface SubmitAssertion {
  submit: "assertion";
  text: string;
  entities: AssertionEntity[];
  /** Insertion ids the claim rests on. */
  sources: string[];
  confidence: AssertionEvent["confidence"];
}

export interface SubmitDecline {
  submit: "decline";
  insertion_ids: string[];
  reason: string;
}

/** Land staged arrivals (#744): each becomes an insertion, and the result
 * names the insertion id assertions may cite in the same call. */
export interface SubmitAdmit {
  submit: "admit";
  staged_ids: string[];
}

/** Let staged arrivals go, nothing landing. */
export interface SubmitPass {
  submit: "pass";
  staged_ids: string[];
  reason: string;
}

export type SubmitItem = SubmitAssertion | SubmitDecline | SubmitAdmit | SubmitPass;

export interface SubmitItemResult {
  index: number;
  ok: boolean;
  /** The appended event's id when ok. */
  id?: string;
  deduped?: boolean;
  error?: string;
  /** admit / pass: one row per staged id, in the order given. */
  staged?: (AdmitResult | PassResult)[];
}

export interface SubmitResult {
  results: SubmitItemResult[];
  appended: number;
  deduped: number;
  rejected: number;
  /** Staged arrivals landed / let go by this call (#744). */
  admitted: number;
  passed: number;
}

export interface SubmitOpts {
  author: EventAuthor;
  produced_by: AssertionProduction;
  now?: () => Date;
}

/** Per-ITEM host-validated append (#479 revised): each item validates,
 * appends, and projects independently — a malformed proposal rejects alone,
 * everything accepted is durable immediately, and each insertion stops
 * being due the moment its event lands. Idempotent: event ids are content
 * hashes that EXCLUDE `created_at`, and an id the record already holds is
 * answered `deduped` — so a retried submission converges on the prior
 * event even when its timestamp differs, instead of tripping the log's
 * immutability collision. */
export function submitWork(root: string, items: readonly SubmitItem[], opts: SubmitOpts): SubmitResult {
  if (!items.length) return { results: [], appended: 0, deduped: 0, rejected: 0, admitted: 0, passed: 0 };
  const now = opts.now ?? (() => new Date());
  const results: SubmitItemResult[] = [];
  // Staged arrivals FIRST (#744): an admit lands an insertion the same
  // call's assertions may cite, so it must be projected before they are
  // validated. Neither op touches the logs' identity story — admit is the
  // intake waist, pass is a cache delete plus config — so neither dedupes.
  let admitted = 0;
  let passed = 0;
  for (const [index, item] of items.entries()) {
    if (item.submit === "admit") {
      const rows = admitStaged(root, item.staged_ids);
      admitted += rows.filter((r) => r.ok).length;
      results.push({ index, ok: rows.every((r) => r.ok), staged: rows, ...(rows.every((r) => r.ok) ? {} : { error: rows.find((r) => !r.ok)!.error! }) });
    } else if (item.submit === "pass") {
      const rows = passStaged(root, item.staged_ids, item.reason, now());
      passed += rows.filter((r) => r.ok).length;
      results.push({ index, ok: rows.every((r) => r.ok), staged: rows, ...(rows.every((r) => r.ok) ? {} : { error: rows.find((r) => !r.ok)!.error! }) });
    }
  }
  syncAssertionProjection(root);
  const cited = items.flatMap((item) =>
    item.submit === "assertion" ? item.sources : item.submit === "decline" ? item.insertion_ids : []);
  const sources = projectedSourcesById(root, cited);
  const assertionPaths: string[] = [];
  const declinePaths: string[] = [];
  // The pre-append snapshot answers "does the record already hold this id"
  // (WAL: it will not see this run's own appends — `seenThisRun` covers an
  // intra-batch duplicate).
  const db = openAssertionProjectionReadonly(root);
  const seenThisRun = new Set<string>();
  const alreadyHeld = (event: { id: string }, kind: "assertion" | "decline"): boolean => {
    if (seenThisRun.has(event.id)) return true;
    return kind === "assertion"
      ? assertionIdsExist(root, [event.id], db).size > 0
      : Boolean(db.query("SELECT 1 FROM declines WHERE decline_id = ? LIMIT 1").get(event.id));
  };
  try {
    for (const [index, item] of items.entries()) {
      if (item.submit === "admit" || item.submit === "pass") continue; // handled above
      try {
        const createdAt = now().toISOString();
        if (item.submit === "assertion") {
          const event = createAssertionEvent({
            text: item.text, entities: item.entities, sources: item.sources,
            author: opts.author, confidence: item.confidence, created_at: createdAt,
            produced_by: opts.produced_by,
          }, sources);
          if (alreadyHeld(event, "assertion")) {
            results.push({ index, ok: true, id: event.id, deduped: true });
            continue;
          }
          const appended = appendAndProjectAssertion(root, event);
          seenThisRun.add(event.id);
          assertionPaths.push(assertionEventRel(event));
          results.push({ index, ok: true, id: event.id, deduped: appended.deduped });
        } else {
          const event: DeclineEvent = createDeclineEvent({
            insertion_ids: item.insertion_ids, reason: item.reason,
            author: opts.author, created_at: createdAt, produced_by: opts.produced_by,
          }, sources);
          if (alreadyHeld(event, "decline")) {
            results.push({ index, ok: true, id: event.id, deduped: true });
            continue;
          }
          const appended = appendAndProjectDecline(root, event);
          seenThisRun.add(event.id);
          declinePaths.push(declineEventRel(event));
          results.push({ index, ok: true, id: event.id, deduped: appended.deduped });
        }
      } catch (error) {
        results.push({
          index, ok: false,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
        });
      }
    }
  } finally { db.close(); }
  results.sort((a, b) => a.index - b.index);
  const logged = results.filter((r) => !r.staged);
  const appended = logged.filter((r) => r.ok && !r.deduped).length;
  const deduped = logged.filter((r) => r.ok && r.deduped).length;
  if (assertionPaths.length)
    commitAssertionEvents(root, assertionPaths, `Submit ${assertionPaths.length} assertion(s)`);
  if (declinePaths.length)
    commitDeclineEvents(root, declinePaths, `Submit ${declinePaths.length} decline(s)`);
  return { results, appended, deduped, rejected: results.filter((r) => !r.ok).length, admitted, passed };
}

// ── the wire (#479) ─────────────────────────────────────────────────────────

/** A submit item as it arrives off a wire (MCP tool args, or the HTTP
 * door's body) — untrusted shape, validated here. */
export interface RawSubmitItem {
  submit?: unknown;
  text?: unknown;
  sources?: unknown;
  confidence?: unknown;
  insertion_ids?: unknown;
  reason?: unknown;
  staged_ids?: unknown;
  rule?: unknown;
}

/** The ONE wire→log pipeline (#479: "host validation is the same validator",
 * literally): the MCP server's `submit` tool and the HTTP
 * gardener door both run THIS. Top-level misuse (not an array, empty,
 * oversized) throws — the caller maps that to its transport's refusal.
 * Per-item problems never throw: each assertion's [[links]] canonicalize
 * host-side FIRST (the model never mints entity ids), a bad item rejects
 * alone at its own index, and everything accepted is durable when this
 * returns. */
export function submitWire(root: string, raw: unknown, opts: SubmitOpts): SubmitResult {
  if (!Array.isArray(raw) || !raw.length) throw new Error("items must be a non-empty array");
  if (raw.length > WORK_BATCH_LIMIT * 4)
    throw new Error(`too many items — submit at most ${WORK_BATCH_LIMIT * 4} per call`);
  // Link verification reads the projection — build it before the first
  // canonicalize, or a fresh vault rejects everything as "not built".
  syncAssertionProjection(root);
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const canonicalize = createAssertionLinkCanonicalizer(root);
  const preRejected: SubmitItemResult[] = [];
  const items: { index: number; item: SubmitItem; minted?: AssertionEntity[] }[] = [];
  for (const [index, r] of (raw as RawSubmitItem[]).entries()) {
    try {
      if (r.submit === "assertion") {
        const text = str(r.text).trim();
        if (!text) throw new Error("assertion needs text");
        const sources = Array.isArray(r.sources) ? r.sources.map(String) : [];
        if (r.confidence !== "direct" && r.confidence !== "candidate")
          throw new Error('confidence must be "direct" or "candidate"');
        const links = canonicalize(text);
        items.push({
          index,
          item: {
            submit: "assertion", text: links.text, entities: links.entities,
            sources, confidence: r.confidence,
          },
          minted: links.minted,
        });
      } else if (r.submit === "decline") {
        const ids = Array.isArray(r.insertion_ids) ? r.insertion_ids.map(String) : [];
        items.push({
          index,
          item: { submit: "decline", insertion_ids: ids, reason: str(r.reason) },
        });
      } else if (r.submit === "admit" || r.submit === "pass") {
        const ids = Array.isArray(r.staged_ids) ? r.staged_ids.map(String).filter(Boolean) : [];
        if (!ids.length) throw new Error(`${r.submit} needs staged_ids`);
        if (r.submit === "admit") items.push({ index, item: { submit: "admit", staged_ids: ids } });
        else items.push({ index, item: { submit: "pass", staged_ids: ids, reason: str(r.reason) } });
      } else {
        throw new Error('submit must be "assertion", "decline", "admit" or "pass"');
      }
    } catch (error) {
      preRejected.push({
        index, ok: false,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      });
    }
  }
  const submitted = items.length
    ? submitWork(root, items.map((i) => i.item), opts)
    : { results: [], appended: 0, deduped: 0, rejected: 0, admitted: 0, passed: 0 };
  // An entity a claim just minted from the document it names is that
  // document (lib/entitySourceSeed.ts). The claims are durable already; a
  // binding that fails leaves them be and the bulk pass can bind it later.
  try {
    bindMintedEntities(root, submitted.results.flatMap((r) => {
      const held = items[r.index]!;
      return r.ok && !r.deduped && held.item.submit === "assertion" && held.minted?.length
        ? [{ entities: held.minted, insertion_ids: held.item.sources }] : [];
    }), opts.now);
  } catch (error) {
    console.warn(`work: entity-source binding skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Re-key submitWork's dense indices back to the caller's, merge the
  // canonicalization rejects, and report in the caller's order.
  const results = [
    ...submitted.results.map((r) => ({ ...r, index: items[r.index]!.index })),
    ...preRejected,
  ].sort((a, b) => a.index - b.index);
  return {
    results,
    appended: submitted.appended,
    deduped: submitted.deduped,
    rejected: submitted.rejected + preRejected.length,
    admitted: submitted.admitted,
    passed: submitted.passed,
  };
}
