/** The native append-only source log. One immutable JSON event per insertion
 * (#496: nothing else is written beside it). The log machinery itself is
 * lib/eventLog.ts; what lives here is the event, its author, and how one is
 * built from an envelope. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Envelope } from "./envelope";
import { eventLog, type AppendResult } from "./eventLog";
import { sha256hex } from "./hash";
import { requestWake } from "./supervisorClock";
import { scalar } from "./text";

export const INSERTION_LOG_DIR = "log/insertions";

export type EventAuthor =
  | { kind: "user"; id: string }
  | { kind: "model"; id: string; invocation_id?: string }
  | { kind: "service" | "agent" | "system"; id: string };

export interface SourceInsertion {
  event: "source.inserted";
  id: string;
  source_id: string;
  author: EventAuthor;
  title: string;
  body: string;
  envelope: Record<string, unknown>;
  occurred_at?: string;
  received_at?: string;
  /** Set only by the one-time legacy importer; native events do not depend on
   * a reference path. */
  imported_path?: string;
  content_sha256: string;
}

/** Immutable source identity and envelope, without the potentially large body. */
export type SourceMetadata = Omit<SourceInsertion, "body">;

export type NativeInsertionResult = AppendResult<SourceInsertion>;

/** The author of an event in ANY of these logs: a real principal, and a
 * model must say which invocation spoke. Lives beside `EventAuthor` because
 * all five logs validate it identically — it was four byte-identical hand
 * copies. */
export function validEventAuthor(author: EventAuthor): boolean {
  return Boolean(author?.kind && author.id?.trim() &&
    (author.kind !== "model" || author.invocation_id?.trim()));
}

/** An insertion's own moment: when it reached us, falling back to when it
 * happened. Picks the month directory and orders a read. */
const insertionWhen = (event: Pick<SourceInsertion, "occurred_at" | "received_at">): string =>
  event.received_at ?? event.occurred_at ?? "";

/** When a source is FROM — what the viewer shows and orders it by: a
 * message's own timestamp (an email's `seq`), else the day it names, else
 * when it reached us. A bare day that is also the landing day yields the
 * landing time (a note dropped today stays today, not midnight UTC); an
 * earlier bare day reads as its UTC noon, so no timezone moves it a day.
 * insertionWhen above stays received-first: it files the event on disk. */
export function sourceMoment(s: Pick<SourceInsertion, "occurred_at" | "received_at"> & { envelope?: Record<string, unknown> }): string {
  const seq = s.envelope?.seq;
  if (typeof seq === "string" && Number.isFinite(Date.parse(seq))) return seq;
  const day = s.occurred_at, received = s.received_at;
  if (!day) return received ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) return day;
  return received?.startsWith(day) ? received : `${day}T12:00:00.000Z`;
}

export function validateSourceInsertion(event: SourceInsertion): void {
  if (event.event !== "source.inserted" || !event.id || !event.source_id)
    throw new Error("insertion-log: invalid source.inserted shape");
}

const log = eventLog<SourceInsertion>({
  name: "insertion",
  dir: INSERTION_LOG_DIR,
  when: insertionWhen,
  validate: validateSourceInsertion,
});

const slug = (value: string): string => value.trim().toLocaleLowerCase()
  .replace(/[^\p{L}\d@._+-]+/gu, "-").replace(/^-|-$/g, "");

export function insertionAuthor(envelope: Record<string, unknown>): EventAuthor {
  const from = scalar(envelope["from"]);
  const fromKind = scalar(envelope["from_kind"]);
  if (fromKind === "person" && from) return { kind: "user", id: from };
  if (fromKind === "agent" && from) return { kind: "agent", id: slug(from) };
  return {
    kind: "service",
    id: slug(scalar(envelope["source"]) ?? scalar(envelope["submitted_via"]) ?? from ?? "intake"),
  };
}

export function sourceInsertion(envelope: Envelope & Record<string, unknown>, body: string): SourceInsertion {
  const sourceId = scalar(envelope.id);
  if (!sourceId) throw new Error("insertion-log: source id is required");
  const contentSha256 = sha256hex(`${JSON.stringify(envelope)}\n${body}`);
  return {
    event: "source.inserted", id: `ins_${sha256hex(`${sourceId}\u0000${contentSha256}`).slice(0, 24)}`,
    source_id: sourceId, author: insertionAuthor(envelope), title: scalar(envelope.title) ?? sourceId,
    body, envelope,
    ...(scalar(envelope.date) ? { occurred_at: scalar(envelope.date) } : {}),
    ...(scalar(envelope.received) ? { received_at: scalar(envelope.received) } : {}),
    content_sha256: contentSha256,
  };
}

/** Takes a PARTIAL event, and must keep doing so: lib/searchCore.ts ranks
 * hits off `projectedSourceHeads`' slim rows (id, source, title, dates —
 * no body), because parsing whole events to read titles cost 70ms per
 * keystroke on a one-letter prefix. So this cannot be `log.rel`, which
 * wants the event. */
export function insertionEventRel(event: Pick<SourceInsertion, "id" | "occurred_at" | "received_at">): string {
  return log.path(event.id, insertionWhen(event));
}

/** Is the event this projection row describes still IN the log? The log is
 * append-only but not immortal: a retraction commit deletes event files
 * (the vault's own `record: retract 9 agent-chat captures…`), while the
 * assertion projection's sync only ever ADDS — nothing prunes the row, so
 * the index outlives the evidence. Any reader that derives a path from the
 * projection and hands it to someone must ask the tree, not the index:
 * search returned a retracted insertion's path and `/v1/note` refused the
 * very path search had just printed. */
export function insertionEventOnDisk(
  root: string,
  event: Pick<SourceInsertion, "id" | "occurred_at" | "received_at">
): boolean {
  return existsSync(join(root, insertionEventRel(event)));
}

/** Idempotently append one immutable insertion event. A deterministic event
 * id makes a retry converge on the same file rather than duplicating it. */
export function appendSourceInsertionEvent(root: string, event: SourceInsertion): NativeInsertionResult {
  const result = log.append(root, event);
  // Every front door — the API, the drop zone, voice, the extension, an
  // integration's poll — lands here, so this is the one place that can tell
  // the supervisor's clock that intake may now be due. A dedup does NOT
  // wake: a retry of an arrival already on disk created no new work.
  // Best-effort by construction (lib/supervisorClock.ts): a missed nudge
  // costs the 300s tick that used to be the only path.
  if (!result.deduped) requestWake(root, "tend");
  return result;
}

export function appendSourceInsertion(root: string, envelope: Envelope & Record<string, unknown>, body: string): NativeInsertionResult {
  return appendSourceInsertionEvent(root, sourceInsertion(envelope, body));
}

/** Commit only append-only insertion events. Used by the one-time reference
 * backfill; normal intake commits its insertion beside the reference/queue. */
export const commitSourceInsertionEvents = log.commit;

export const listSourceInsertionEventFiles = log.listFiles;

export const readSourceInsertionLog = log.read;
