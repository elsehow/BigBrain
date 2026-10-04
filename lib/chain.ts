/** chain.ts — a CHAIN is one way of gardening the record (#51).
 *
 * Every chain reads the same substrate — the door, `log/insertions`, the
 * owner-only intake view, the model runners — and writes only its own logs
 * and journals. A chain brings two kinds of stage:
 *
 * - a SOURCE stage: per-arrival work, due while the chain's own log does not
 *   yet settle an arrival (the work view, #479 — nothing is enqueued, a
 *   settling event makes the job vanish when the view recomputes);
 * - SCHEDULED stages: passes over the chain's own output, due when there is
 *   new input since their checkpoint AND their interval has elapsed (memory,
 *   today; `scheduledVerdict` is that rule).
 *
 * The classic chain is tend + memory (lib/tend.ts). The supervisor's one
 * `tend` tick asks every registered chain (lib/chains.ts) whether it has
 * work and runs the ones that do; each chain single-flights on its own lock,
 * so chains never wait on each other.
 */

import type { Manifest } from "./manifest";

/** One stage's answer to "should you run now?", with the reason a human reads. */
export interface StageVerdict {
  due: boolean;
  reason: string;
}

/** What a chain has waiting. */
export interface ChainDue {
  /** Per-arrival jobs the chain's logs do not yet settle. */
  source: number;
  /** Each scheduled stage's verdict, by stage name. */
  scheduled: Record<string, StageVerdict>;
}

export interface ChainRunOpts {
  root: string;
  manifest: Manifest;
  /** Run scheduled stages that are not due (a first run is deliberate). */
  force?: boolean;
  /** Cap on source-stage rounds this run. */
  maxRounds?: number;
}

/** How a run reads to the person who asked for it. */
export interface ChainReport {
  lines: string[];
  /** A stage failed, or the run could not start. */
  failed: boolean;
  /** Why the run could not start at all — printed to stderr. */
  error?: string;
}

export interface Chain<Result = unknown> {
  name: string;
  due(root: string, opts?: { now?: Date }): ChainDue;
  run(opts: ChainRunOpts): Promise<Result>;
  report(result: Result): ChainReport;
}

export const chainHasWork = (due: ChainDue): boolean =>
  due.source > 0 || Object.values(due.scheduled).some((s) => s.due);

/** THE scheduled-stage rule: work waiting AND the stage's clock elapsed,
 * unless forced. A stage with no clock yet never runs on its own — its first
 * run is deliberate (--force). `work` describes what is waiting, or is
 * undefined when nothing is; it is asked only once the clock is valid, so a
 * stage with no clock never pays for its scan. */
export function scheduledVerdict(opts: {
  force?: boolean;
  now?: Date;
  nextRunAt?: string;
  work: () => string | undefined;
  /** Says what "nothing waiting" means for this stage. */
  idle?: string;
}): StageVerdict {
  if (opts.force) return { due: true, reason: "forced" };
  const next = opts.nextRunAt ? Date.parse(opts.nextRunAt) : NaN;
  if (!Number.isFinite(next)) return { due: false, reason: "no stamp — first run is --force" };
  const work = opts.work();
  if (!work) return { due: false, reason: opts.idle ?? "nothing new to fold in" };
  if ((opts.now ?? new Date()).getTime() >= next) return { due: true, reason: `scheduled sweep — ${work}` };
  return { due: false, reason: `next sweep not yet due (${work} waiting)` };
}
