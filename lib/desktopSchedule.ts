/**
 * desktopSchedule.ts — the desktop supervisor's clock (#574), kept pure so
 * it can be tested without spawning anything.
 *
 * The scheduler only decides WHEN TO ASK. The chains (lib/chains.ts) stay the
 * single source of "is anything due"; a tick that finds nothing exits in
 * milliseconds. So the clock here is deliberately dumb — per-job "next
 * fire" timestamps checked from one heartbeat — and its one real job is
 * sleep/wake: a machine that slept two hours has missed one tick of every
 * job, not twenty-four, and gets exactly one catch-up fire per job on the
 * first beat after waking, the way launchd's StartInterval behaves.
 */

/**
 * The cadence: how often each recurring job runs, in seconds.
 *
 * These numbers used to live in the launchd plists `bigbrain install --role
 * host` rendered, and the supervisor regex-parsed `StartInterval` back out
 * of them so the two schedulers could not drift. That install retired with
 * #645 and the templates went with it; this table is the schedule now.
 *
 * Granola polls every minute: an idle poll is ONE list request
 * against a ~5/s limit, an empty poll writes nothing to the vault, and a
 * meeting's transcript is then in the feed within a minute of Granola
 * finishing it instead of up to five.
 */
export const CADENCE: Readonly<Record<string, number>> = {
  tend: 300,
  publish: 900,
  granola: 60,
  "that-tracks": 60,
  email: 60,
  rss: 900,
};

/** Seconds between runs for `name`. An integration with no entry above polls
 * every 5 minutes — the same default the missing-plist path used to give. */
export function cadence(name: string): number {
  return CADENCE[name] ?? 300;
}

export interface ScheduledJob {
  name: string;
  /** Seconds between fires. */
  interval: number;
  /** Fire on the first beat, rather than one interval in. */
  atStart: boolean;
}

export class Scheduler {
  private readonly next = new Map<string, number>();
  private readonly jobs: ScheduledJob[];

  constructor(jobs: readonly ScheduledJob[], now: number) {
    this.jobs = [...jobs];
    for (const j of jobs) this.next.set(j.name, j.atStart ? now : now + j.interval * 1000);
  }

  /** A job the plan gained after start — an integration the settings screen
   * just listed in vault.yaml (email's first inbox, #749). Nothing is ever
   * removed here: a disabled integration's own run.ts exits at its gate. A
   * name already planned is left alone, clock and all. */
  add(job: ScheduledJob, now: number): void {
    if (this.jobs.some((j) => j.name === job.name)) return;
    this.jobs.push(job);
    this.next.set(job.name, job.atStart ? now : now + job.interval * 1000);
  }

  /**
   * Every job to fire at `now`, in plan order: those whose clock has passed
   * (however long ago — an overdue clock is one fire, not one per missed
   * interval). A job still running from its last fire is skipped and its
   * clock left alone, so it fires on the first beat after it exits rather
   * than piling up behind itself.
   */
  due(now: number, running: ReadonlySet<string>): string[] {
    return this.jobs
      .filter((j) => !running.has(j.name) && (this.next.get(j.name) ?? Infinity) <= now)
      .map((j) => j.name);
  }

  /** Record a fire: the next one is a full interval from now. */
  started(name: string, now: number): void {
    const j = this.jobs.find((x) => x.name === name);
    if (j) this.next.set(name, now + j.interval * 1000);
  }

  /**
   * Bring a job's clock forward to `now` — an arrival asking for the work it
   * just created, instead of waiting out the rest of the interval
   * (lib/supervisorClock.ts carries the request across processes).
   *
   * It moves a CLOCK, it does not fire: `due` still refuses a job that is
   * already running, so a poke during a run lands on the first beat after it
   * exits rather than stacking a second one beside it. A job the plan does
   * not carry has no clock here and is ignored — the plan stays the one
   * switch, which is the whole reason the old direct-spawn poke was removed.
   */
  poke(name: string, now: number): void {
    if (this.jobs.some((j) => j.name === name)) this.next.set(name, now);
  }

  nextAt(name: string): number | undefined {
    return this.next.get(name);
  }
}

/**
 * How long the process was away, if it was: the gap between two heartbeats
 * that is more than `tolerance` beats wide. Sleep is the usual cause; a
 * starved event loop looks the same and is handled the same (fire what is
 * overdue, once). 0 when the beat arrived on time.
 */
export function wokeAfter(prevBeat: number, now: number, beatMs: number, tolerance = 3): number {
  const gap = now - prevBeat;
  return gap > tolerance * beatMs ? gap : 0;
}

export function durationLabel(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 90_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms / 60_000)} min`;
}
