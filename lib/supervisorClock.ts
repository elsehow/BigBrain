/**
 * supervisorClock.ts — the desktop supervisor's clock as OTHER processes see
 * it. `bin/desktop.ts` runs the clock (lib/desktopSchedule.ts does its
 * arithmetic); the api, the viewer and every landing path are separate
 * children that cannot call into it, so the two directions go through
 * `.state/`:
 *
 *   IN   `requestWake(root, "tend")` — an arrival asking for the work it just
 *        created. The supervisor takes the request on its next beat and
 *        brings that job's clock forward. Before this, intake was POLLED and
 *        nothing else: a drop landed, returned, and waited out however much
 *        of the 300s tick was left (a uniform 0–5 min, and the whole of it
 *        spent under a spinner that claimed the work was already happening).
 *
 *   OUT  `readNextFire(root, "tend")` — when that job actually fires next, so
 *        the queue view can say it instead of guessing. The head used to
 *        hardcode `nextEtaMs = 0` whenever anything was due, which rendered
 *        as "building links now" for the entire wait.
 *
 * WHY A FILE AND NOT A SPAWN. The poke was removed in 2026-08-10 (see the
 * note in lib/intake.ts) because arrivals used to spawn the pass DIRECTLY,
 * which bypassed the scheduler and meant a disabled trigger did not
 * actually stop runs — the timer had to be the one switch. That reasoning is
 * intact and this respects it: a wake request moves a CLOCK the supervisor
 * owns, it does not start anything. The supervisor still decides whether the
 * job exists in its plan at all, `Scheduler.due` still refuses a job that is
 * already running, and `tendDue` inside the tick is still the only judge of
 * whether there is work. Nothing here can run a pass the plan does not carry.
 *
 * With no supervisor — the scripts run by hand — there is nothing to read
 * either side: a wake request is inert (the next hand-run tick does the work,
 * exactly as today) and no stamp is written, so `readNextFire` answers null
 * and callers fall back to naming the tick bound. Both degrade to the old
 * behaviour rather than to a wrong one.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, writeAtomic } from "./fsx";

/** Job names are path segments under `.state/wake/`, so they are constrained
 * rather than trusted. Every caller is internal today; this keeps a future
 * one from turning an integration name into a traversal. */
const JOB_NAME = /^[a-z][a-z0-9-]*$/;

const wakeDir = (root: string): string => join(root, ".state", "wake");
export const nextFireFile = (root: string): string => join(root, ".state", "schedule.json");

/**
 * Ask the supervisor to bring `job`'s clock forward. Idempotent — a burst of
 * arrivals leaves ONE marker and earns one fire — and best-effort: a vault on
 * a read-only mount, or one with no supervisor at all, must never fail a
 * landing over a scheduling hint.
 */
export function requestWake(root: string, job: string): void {
  if (!JOB_NAME.test(job)) return;
  try {
    ensureDir(wakeDir(root));
    // Not writeAtomic: the content is irrelevant (existence IS the request)
    // and an empty marker cannot be read torn.
    writeFileSync(join(wakeDir(root), job), "");
  } catch {
    /* a missed nudge costs one tick, never an arrival */
  }
}

/** Consume a pending request for `job`: true once per request, then gone. */
export function takeWake(root: string, job: string): boolean {
  if (!JOB_NAME.test(job)) return false;
  const path = join(wakeDir(root), job);
  try {
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

interface NextFireStamp {
  /** The supervisor that owns these clocks. A stamp outlives a hard kill
   * (SIGKILL leaves no chance to clear it), and a stale one would promise a
   * fire that is never coming — so the reader checks liveness, the same way
   * `memoryRunning` reads the memory lock. */
  pid: number;
  /** job → epoch ms of its next fire. */
  jobs: Record<string, number>;
}

/** Publish the clock. Called by the supervisor whenever a next-fire changes. */
export function writeNextFires(root: string, jobs: Record<string, number>): void {
  try {
    ensureDir(join(root, ".state"));
    writeAtomic(nextFireFile(root), `${JSON.stringify({ pid: process.pid, jobs })}\n`);
  } catch {
    /* the view falls back to the tick bound */
  }
}

/** Drop the clock on a clean stop, so nothing reads a schedule that ended. */
export function clearNextFires(root: string): void {
  try {
    rmSync(nextFireFile(root), { force: true });
  } catch {
    /* the pid check covers what this misses */
  }
}

/**
 * When `job` fires next, epoch ms — or null when nobody is keeping this
 * clock: no stamp, a torn one, a dead supervisor, or a job the plan omits.
 * Null is not "never"; it means ASK SOMETHING ELSE (the tick bound), which
 * is what the callers do.
 */
export function readNextFire(root: string, job: string): number | null {
  try {
    const stamp = JSON.parse(readFileSync(nextFireFile(root), "utf8")) as NextFireStamp;
    if (!stamp || typeof stamp.pid !== "number") return null;
    process.kill(stamp.pid, 0); // throws when the supervisor is gone
    const at = stamp.jobs?.[job];
    return typeof at === "number" && Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}
