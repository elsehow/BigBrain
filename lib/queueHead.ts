/**
 * queueHead.ts — how deep the intake queue is and when it next runs.
 *
 * Four numbers, on GET /api/vault, for the home feed's column head: how
 * many are waiting, how many a live round holds, when the gardener next
 * fires, and the bound to hedge with when that time is inexact.
 *
 * This file was `dueFeed.ts`, and it built far more (#639, #666). The
 * due-set FEED — the job rows, the tend and memory run histories, the
 * observation arrivals — was the work view's payload, and the work view
 * was retired with #498. What was left ran two journal walks, the memory
 * stamp, a memory work scan, a third journal walk and the observation
 * mapping on every live ping, and threw all of it away so a tooltip could
 * say "3 waiting, ~2m": 185ms on the live vault, against 23ms for the
 * three reads below. `git log` has the rest if a run history comes back.
 */

import { intakeRunning } from "./assertionAgent";
import { readNextFire } from "./supervisorClock";
import { dueWork, WORK_BATCH_LIMIT, type IntakeJob } from "./work";

/** The gardener's tick (deploy tend units: 300s) — once work is due, the
 * bound on how late the next run can start. */
export const TEND_TICK_MS = 300_000;

export interface QueueHead {
  /** Due and not yet picked up. */
  waiting: number;
  /** Held by the round in flight — what the spinner reads. */
  running: number;
  /** ms until the gardener's next run; null when nothing is due. */
  nextEtaMs: number | null;
  /** The tick interval, non-null ONLY when the eta above is inexact. */
  tickMs: number | null;
}

/** The due scan, the lock, and the clock. The 500 is the ceiling `dueWork`
 * clamps to, so a vault with more than 500 due reports 500. */
export function queueHead(root: string): QueueHead {
  const jobs = dueWork(root, { kinds: ["intake"], limit: 500 }).filter(
    (j): j is IntakeJob => j.kind === "intake"
  );
  // Which of these a live round already holds. `next` hands the gardener
  // exactly this list, in this order, capped at the batch limit — so when
  // the lock is held, the leading WORK_BATCH_LIMIT jobs ARE the batch in
  // flight. That is derived from the same function the runner calls, not
  // guessed. `running` used to be hardcoded 0 here, which left the spinner
  // permanently unable to say the work had started (#642).
  const running = intakeRunning(root) ? Math.min(jobs.length, WORK_BATCH_LIMIT) : 0;
  // WHEN the gardener next fires. Nothing due ⇒ no chip.
  //
  // With something due this used to be a flat 0, which the labels read as
  // "now" — true only by accident, and false for most of the wait: an
  // arrival lands at a uniform random point inside the 300s tick, so "now"
  // was on average 2.5 minutes early and up to 5 late. The supervisor
  // publishes its actual next fire, so say that.
  //
  // `tickMs` rides along as the BOUND TO USE WHEN THE ETA IS INEXACT, and is
  // therefore null exactly when it is exact — with no supervisor, where no
  // supervisor publishes a clock, an eta of 0 still means "some time within
  // the tick" and the labels degrade to naming it.
  const firesAt = jobs.length ? readNextFire(root, "tend") : null;
  return {
    waiting: jobs.length - running,
    running,
    nextEtaMs: jobs.length ? (firesAt === null ? 0 : Math.max(0, firesAt - Date.now())) : null,
    tickMs: firesAt === null ? TEND_TICK_MS : null,
  };
}
