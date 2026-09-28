/** Append-only revocation events — "that assertion no longer stands" (#629).
 *
 * The assertion log is immutable: an event is content-addressed and never
 * edited. So a wrong claim, a retracted fact, a privacy deletion, or a link
 * that named the wrong entity is corrected by APPENDING a revocation — and,
 * when there is a right version, a superseding assertion the revocation
 * points at. The original keeps its author and date; the correction is
 * its own event with its own author; nothing is rewritten.
 *
 * Readers treat a revoked assertion as absent: `readAssertionLog` drops it
 * by default, the projection keeps its row (flagged, for the redirect) but
 * removes its entity, evidence and FTS edges. A superseded id still opens
 * — on its successor (resolveAssertionId), so a memory topic citing
 * `[[ast_old]]` keeps resolving until its next regeneration re-cites.
 *
 * Its own log directory (`log/revocations/`), for declineLog.ts's reason.
 * Host code constructs and validates events; models never write this log.
 * The append/read/commit machinery is lib/eventLog.ts.
 */

import type { AssertionProduction } from "./assertionLog";
import { eventLog, type AppendResult } from "./eventLog";
import { sha256hex } from "./hash";
import { AST_ID } from "./ids";
import { validEventAuthor, type EventAuthor } from "./insertionLog";

export const REVOCATION_LOG_DIR = "log/revocations";

export interface RevocationEvent {
  event: "assertion.revoked";
  id: string;
  /** The assertion that no longer stands. */
  assertion_id: string;
  /** The assertion that stands in its place, when there is one. */
  superseded_by?: string;
  /** Why — one line, durable. Free text is data, never instructions. */
  reason: string;
  author: EventAuthor;
  created_at: string;
  produced_by: AssertionProduction;
}

export interface RevocationInput {
  assertion_id: string;
  superseded_by?: string;
  reason: string;
  author: EventAuthor;
  created_at: string;
  produced_by: AssertionProduction;
}

export type RevocationAppendResult = AppendResult<RevocationEvent>;

export function validateRevocationEvent(event: RevocationEvent): void {
  if (event.event !== "assertion.revoked" || !/^rev_[a-f0-9]{24}$/u.test(event.id))
    throw new Error("revocation-log: invalid event identity");
  if (!AST_ID.test(event.assertion_id)) throw new Error("revocation-log: invalid assertion id");
  if (event.superseded_by !== undefined && !AST_ID.test(event.superseded_by))
    throw new Error("revocation-log: invalid superseding assertion id");
  if (event.superseded_by === event.assertion_id)
    throw new Error("revocation-log: an assertion cannot supersede itself");
  if (!event.reason?.trim() || event.reason.length > 2_000 || /\n/u.test(event.reason))
    throw new Error("revocation-log: reason must be one 1-2000 character line");
  if (!validEventAuthor(event.author)) throw new Error("revocation-log: invalid author");
  if (!event.created_at?.trim()) throw new Error("revocation-log: created_at is required");
  if (!event.produced_by?.procedure?.trim() || !event.produced_by.version?.trim())
    throw new Error("revocation-log: production procedure and version are required");
}

const log = eventLog<RevocationEvent>({
  name: "revocation",
  dir: REVOCATION_LOG_DIR,
  when: (event) => event.created_at,
  validate: validateRevocationEvent,
});

/** Construct an immutable revocation. The identity hash excludes
 * `created_at`, so a retried correction converges on the same event. */
export function createRevocationEvent(input: RevocationInput): RevocationEvent {
  const reason = input.reason.trim().replace(/\s+/g, " ");
  const identity = JSON.stringify({
    assertion_id: input.assertion_id, superseded_by: input.superseded_by ?? null, reason,
    author: input.author, produced_by: input.produced_by,
  });
  const event: RevocationEvent = {
    event: "assertion.revoked",
    id: `rev_${sha256hex(identity).slice(0, 24)}`,
    assertion_id: input.assertion_id,
    ...(input.superseded_by ? { superseded_by: input.superseded_by } : {}),
    reason,
    author: input.author,
    created_at: input.created_at,
    produced_by: input.produced_by,
  };
  validateRevocationEvent(event);
  return event;
}

export const revocationEventRel = log.rel;

export const appendRevocationEvent = log.append;

export const listRevocationEventFiles = log.listFiles;

export const readRevocationLog = log.read;

export const commitRevocationEvents = log.commit;

/** The revoked set: assertion id → the revocation that retired it (the
 * first one, when several). What every log reader filters by. */
export function revokedAssertions(root: string, opts: { strict?: boolean } = {}): Map<string, RevocationEvent> {
  const out = new Map<string, RevocationEvent>();
  for (const event of log.read(root, opts)) if (!out.has(event.assertion_id)) out.set(event.assertion_id, event);
  return out;
}

/** Follow supersession to the assertion that stands today — itself when it
 * was never revoked, or was revoked without a successor. Cycle-safe. */
export function resolveAssertionIdIn(revoked: ReadonlyMap<string, RevocationEvent>, id: string): string {
  const seen = new Set<string>();
  let at = id;
  while (!seen.has(at)) {
    seen.add(at);
    const next = revoked.get(at)?.superseded_by;
    if (!next) return at;
    at = next;
  }
  return at;
}
