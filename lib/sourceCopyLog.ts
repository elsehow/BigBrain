/** Append-only judgments that two sources are, or are not, one document
 * (#206) — the fuzzy half of lib/sourceCopies.ts, whose exact half needs no
 * record at all.
 *
 * Two kinds of event, one pair each (insertion ids, ascending):
 *  - `source.copies-judged`: a model's score, 0–1, that the two are the same
 *    work (lib/sourceCopyJudge.ts). Kept because a judgment costs a call;
 *    the cut-off is applied on read, so moving it re-judges nothing.
 *  - `source.copies-declared`: a person's word, `same` or not. It beats
 *    every judgment of the pair and every exact key the two share.
 * Latest per pair and kind wins (lib/sourceCopyReview.ts). Host code
 * constructs and validates events; the append/read/commit machinery is
 * lib/eventLog.ts.
 */

import type { AssertionProduction } from "./assertionLog";
import { eventLog, type AppendResult } from "./eventLog";
import { sha256hex } from "./hash";
import { validEventAuthor, type EventAuthor } from "./insertionLog";

export const SOURCE_COPY_LOG_DIR = "log/source-copies";

const INSERTION = /^ins_[a-f0-9]{24}$/u;

interface PairEvent {
  id: string;
  /** The two insertions, ascending. */
  pair: [string, string];
  author: EventAuthor;
  created_at: string;
  produced_by: AssertionProduction;
}
export interface SourceCopyJudged extends PairEvent { event: "source.copies-judged"; score: number }
export interface SourceCopyDeclared extends PairEvent { event: "source.copies-declared"; same: boolean }
export type SourceCopyEvent = SourceCopyJudged | SourceCopyDeclared;

export type SourceCopyAppendResult = AppendResult<SourceCopyEvent>;

export function validateSourceCopyEvent(event: SourceCopyEvent): void {
  if (!/^scp_[a-f0-9]{24}$/u.test(event.id)) throw new Error("source-copy-log: invalid event identity");
  const [a, b] = event.pair ?? [];
  if (!INSERTION.test(a ?? "") || !INSERTION.test(b ?? "") || a! >= b!)
    throw new Error("source-copy-log: pair must be two insertion ids, ascending");
  if (event.event === "source.copies-judged") {
    if (event.author?.kind !== "model" || typeof event.score !== "number" || !(event.score >= 0 && event.score <= 1))
      throw new Error("source-copy-log: a judgment is a model's score from 0 to 1");
  } else if (event.event === "source.copies-declared") {
    if (event.author?.kind !== "user" || typeof event.same !== "boolean")
      throw new Error("source-copy-log: a declaration is a person's same or not");
  } else throw new Error("source-copy-log: unknown event");
  if (!validEventAuthor(event.author)) throw new Error("source-copy-log: invalid author");
  if (!event.created_at?.trim()) throw new Error("source-copy-log: created_at is required");
  if (!event.produced_by?.procedure?.trim() || !event.produced_by.version?.trim())
    throw new Error("source-copy-log: production procedure and version are required");
}

const log = eventLog<SourceCopyEvent>({
  name: "source-copy",
  dir: SOURCE_COPY_LOG_DIR,
  when: (event) => event.created_at,
  validate: validateSourceCopyEvent,
});

export type SourceCopyInput = { a: string; b: string; author: EventAuthor; created_at: string; produced_by: AssertionProduction }
  & ({ score: number } | { same: boolean });

/** The identity includes `created_at`, as an alias event's does: a pair
 * judged or declared again is a new fact in time. */
export function createSourceCopyEvent(input: SourceCopyInput): SourceCopyEvent {
  const pair = [input.a, input.b].sort() as [string, string];
  const base = { pair, author: input.author, created_at: input.created_at, produced_by: input.produced_by };
  const body = "score" in input
    ? { event: "source.copies-judged" as const, ...base, score: input.score }
    : { event: "source.copies-declared" as const, ...base, same: input.same };
  const event = { id: `scp_${sha256hex(JSON.stringify(body)).slice(0, 24)}`, ...body } as SourceCopyEvent;
  validateSourceCopyEvent(event);
  return event;
}

export const appendSourceCopyEvent = log.append;
export const listSourceCopyEventFiles = log.listFiles;
export const readSourceCopyLog = log.read;
export const commitSourceCopyEvents = log.commit;

/** The key one pair has, either way round. */
export const copyPairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
