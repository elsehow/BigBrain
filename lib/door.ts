/** The door: the ONE way an arrival is persisted, and one stream for every
 * arrival. The owner's drops and the pollers' finds alike are queued first
 * (lib/arrivals.ts: sealed, outside the vault and away from every agent),
 * and only the worker here puts them to the firewall (lib/firewall.ts). What
 * passes lands in the record (`receive`, lib/intake.ts) or is staged for the
 * gardener (`stage`, lib/stageStorage.ts). Only this module may call any of
 * them (test/door.test.ts). Staging is persistence too: the gardener reads a
 * staged body before deciding, so a reset email screened only at landing
 * would already have been read by an agent.
 *
 * Whoever queues an arrival settles it at once, so a drop still answers with
 * its landing. Withheld means deleted, leaving one metadata line. When the
 * firewall cannot answer, the arrival waits in the queue: a drop is told it
 * is queued, a poller moves on, and the sweep (bin/arrivals.ts, on the
 * supervisor's schedule) settles it once the firewall answers. */

import {
  arrivalOutcome,
  pruneOutcomes,
  putArrival,
  readArrival,
  settleArrival,
  waitingIds,
  workerLock,
  type Arrival,
  type Outcome,
} from "./arrivals";
import { FirewallUnavailable, recordWithheld, screen } from "./firewall";
import { checkItem, IntakeError, receive, type IntakeReceipt, type ReceiveItemOpts } from "./intake";
import { withHeldLock } from "./sqliteLock";
import { stage, type StagedItem } from "./stageStorage";

/** The firewall could not answer yet. Nothing is lost: the arrival waits in
 * the queue and lands once it does. */
export class Queued extends Error {
  constructor(readonly id: string) {
    super("queued: it lands once the firewall answers");
  }
}

/** A drop door's HTTP status for a refused landing: 413 too large, 422
 * withheld, else 400. */
export function dropErrorStatus(e: unknown): number {
  if (e instanceof IntakeError) return e.code === "too-large" ? 413 : e.code === "withheld" ? 422 : 400;
  return 400;
}

type Settled = Outcome | { state: "waiting" };
const WAITING = { state: "waiting" } as const;
const BUSY = "the arrivals worker stayed busy";

/** Screen one queued arrival, then land, stage or withhold it. `waiting`
 * when the firewall cannot answer: it stays queued. One worker at a time, so
 * nothing is screened or landed twice; a second waits its turn and finds the
 * first one's outcome. */
export async function settle(root: string, id: string): Promise<Settled> {
  try {
    return await withHeldLock(workerLock(root), () => settleHeld(root, id), { busy: BUSY, wait: 60_000 });
  } catch (e) {
    if (e instanceof Error && e.message === BUSY) return WAITING;
    throw e;
  }
}

async function settleHeld(root: string, id: string): Promise<Settled> {
  const done = arrivalOutcome(root, id);
  const a = readArrival(root, id);
  if (done) {
    if (!a) return done;
    // the same arrival again, after it settled: nothing new, only what it became
    settleArrival(root, id, done);
    if (done.state === "landed") return { ...done, receipt: { ...done.receipt, deduped: true } };
    return done.state === "staged" ? { ...done, fresh: false } : done;
  }
  if (!a) throw new Error(`no arrival ${id} is queued`);
  const { source, content, attachments = [] } = a.to === "record" ? a : a.item;
  let verdict;
  try {
    verdict = await screen(root, content, attachments);
  } catch (e) {
    if (e instanceof FirewallUnavailable) return WAITING;
    throw e;
  }
  let outcome: Outcome;
  if (!verdict.pass) {
    recordWithheld(root, source, content, verdict);
    outcome = { state: "withheld" };
  } else if (a.to === "staging") outcome = { state: "staged", fresh: stage(root, a.item) };
  else outcome = landed(root, a);
  settleArrival(root, id, outcome);
  return outcome;
}

function landed(root: string, a: Extract<Arrival, { to: "record" }>): Outcome {
  try {
    return { state: "landed", receipt: receive({ root, content: a.content, raw: a.raw, attachments: a.attachments }) };
  } catch (e) {
    if (e instanceof IntakeError) return { state: "refused", code: e.code, error: e.message };
    throw e;
  }
}

/** The worker's round: settle what is waiting, oldest first, stopping when
 * the firewall cannot answer; the next round tries again. */
export async function sweep(root: string): Promise<{ settled: number; waiting: number }> {
  pruneOutcomes(root);
  let settled = 0;
  for (const id of waitingIds(root)) {
    if ((await settle(root, id)).state === "waiting") break;
    settled++;
  }
  return { settled, waiting: waitingIds(root).length };
}

/** Land the owner's drop in the record: queued, then settled at once. A
 * withheld or invalid item throws IntakeError, so its sender knows nothing
 * landed; one the firewall cannot answer for yet throws Queued. */
export async function land(opts: ReceiveItemOpts & { source?: string }): Promise<IntakeReceipt> {
  const { root, content, raw = content, attachments = [], source = "drop" } = opts;
  checkItem(content, attachments);
  const id = putArrival(root, { to: "record", source, content, raw, attachments });
  const o = await settle(root, id);
  if (o.state === "landed") return o.receipt;
  if (o.state === "waiting") throw new Queued(id);
  if (o.state === "refused") throw new IntakeError(o.code, o.error);
  throw new IntakeError("withheld", "withheld by the firewall: this looks like it carries a credential — nothing landed");
}

/** Queue a poller's find, for a caller that settles it later: under a lock,
 * or once its own network work is done. */
export function queueFind(root: string, item: StagedItem): string {
  return putArrival(root, { to: "staging", item });
}

/** Settle a queued find. True when it is new for the gardener (staged, or
 * waiting for the firewall); false when already staged, or withheld. */
export async function settleFind(root: string, id: string): Promise<boolean> {
  const o = await settle(root, id);
  return o.state === "waiting" || (o.state === "staged" && o.fresh);
}

/** Stage a poller's find for the gardener: queued, then settled at once. */
export async function hold(root: string, item: StagedItem): Promise<boolean> {
  return settleFind(root, queueFind(root, item));
}

/** A source's finds still waiting for the firewall, for a poller that must
 * not queue the same revision twice (lib/granolaStage.ts). */
export function waitingFinds(root: string, source: string): StagedItem[] {
  return waitingIds(root).flatMap((id) => {
    const a = readArrival(root, id);
    return a?.to === "staging" && a.item.source === source ? [a.item] : [];
  });
}

/** Admission of an item that was screened when it was staged. Only the
 * admission paths call this (test/door.test.ts). */
export function admit(opts: ReceiveItemOpts): IntakeReceipt {
  return receive(opts);
}
