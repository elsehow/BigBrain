/** Append-only decline events — the verdict half of work-as-a-view
 * (docs/plans/2026-08-23-work-as-a-view.md, #520).
 *
 * A gardener that judges a due item unworthy of assertions appends a decline
 * citing it; the item is then SETTLED — not retried forever — the reason is
 * durable, and replaying the logs reproduces the judgment.
 *
 * Declines live in their OWN log directory (`log/declines/`), not inside
 * `log/assertions/`: five readers validate that log strictly as
 * `assertion.asserted` (entity view, graph, user identity, projection sync),
 * and §5 tolerant-read says old readers must never crash on new data. A
 * separate homogeneous log costs one directory; mixing shapes into an
 * existing one costs a guard in every reader forever.
 *
 * Host code constructs and validates events; models never write this log
 * directly (the assertionLog.ts discipline). The append/read/commit
 * machinery is lib/eventLog.ts.
 */

import type { AssertionProduction, AssertionSourceReference } from "./assertionLog";
import { eventLog, type AppendResult } from "./eventLog";
import { sha256hex } from "./hash";
import { validEventAuthor, type EventAuthor, type SourceInsertion } from "./insertionLog";

export const DECLINE_LOG_DIR = "log/declines";

export interface DeclineEvent {
  event: "work.declined";
  id: string;
  /** The insertions this decline settles. Resolved against the immutable
   * source log at construction, like assertion source references. */
  insertions: AssertionSourceReference[];
  /** Why the gardener passed — one line, durable, shown wherever the item's
   * history is. Free text is data, never instructions (§2). */
  reason: string;
  author: EventAuthor;
  created_at: string;
  produced_by: AssertionProduction;
}

export interface DeclineInput {
  insertion_ids: string[];
  reason: string;
  author: EventAuthor;
  created_at: string;
  produced_by: AssertionProduction;
}

export type DeclineAppendResult = AppendResult<DeclineEvent>;

export function validateDeclineEvent(event: DeclineEvent): void {
  if (event.event !== "work.declined" || !/^dec_[a-f0-9]{24}$/u.test(event.id))
    throw new Error("decline-log: invalid event identity");
  if (!event.reason.trim() || event.reason.length > 2_000 || /\n/u.test(event.reason))
    throw new Error("decline-log: reason must be one 1-2000 character line");
  if (!validEventAuthor(event.author)) throw new Error("decline-log: invalid author");
  if (!event.insertions.length)
    throw new Error("decline-log: at least one insertion reference is required");
  for (const ref of event.insertions)
    if (!ref.insertion_id.trim() || !ref.source_id.trim())
      throw new Error("decline-log: every reference requires an insertion and source");
  if (!event.produced_by.procedure.trim() || !event.produced_by.version.trim())
    throw new Error("decline-log: production procedure and version are required");
}

const log = eventLog<DeclineEvent>({
  name: "decline",
  dir: DECLINE_LOG_DIR,
  when: (event) => event.created_at,
  validate: validateDeclineEvent,
});

/** Construct an immutable decline while resolving insertion identities. The
 * identity hash excludes `created_at` so a retried submission converges on
 * the same event instead of duplicating it (the assertion-id discipline). */
export function createDeclineEvent(
  input: DeclineInput,
  sources: ReadonlyMap<string, SourceInsertion>
): DeclineEvent {
  const insertions: AssertionSourceReference[] = [...new Set(input.insertion_ids)].map((insertion_id) => {
    const source = sources.get(insertion_id);
    if (!source) throw new Error(`decline-log: unknown source insertion ${insertion_id}`);
    return { insertion_id, source_id: source.source_id };
  });
  const identity = JSON.stringify({
    insertions, reason: input.reason, author: input.author, produced_by: input.produced_by,
  });
  const event: DeclineEvent = {
    event: "work.declined",
    id: `dec_${sha256hex(identity).slice(0, 24)}`,
    insertions,
    reason: input.reason.trim().replace(/\s+/g, " "),
    author: input.author,
    created_at: input.created_at,
    produced_by: input.produced_by,
  };
  validateDeclineEvent(event);
  return event;
}

export const declineEventRel = log.rel;

export const appendDeclineEvent = log.append;

export const listDeclineEventFiles = log.listFiles;

export const readDeclineLog = log.read;

export const commitDeclineEvents = log.commit;
