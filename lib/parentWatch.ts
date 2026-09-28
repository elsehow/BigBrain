/**
 * parentWatch.ts — die with a parent that cannot say it died (#597).
 *
 * A process on macOS is never told its parent is gone: there is no
 * PR_SET_PDEATHSIG, and a child that only reads its stdin sees EOF only if
 * it is still healthy enough to be scheduled. So the desktop's process
 * tree (the shell → bin/desktop.ts → api, web) watches UPWARD instead:
 * each process polls the pid it was handed, once a second, with the zero
 * signal, and takes itself down when that pid is gone. It asks nothing of
 * the process that died — a SIGKILLed or wedged parent is noticed the same
 * as a clean exit.
 *
 * The pid to watch travels in BIGBRAIN_SUPERVISOR_PID: bin/desktop.ts sets
 * it to its own pid, so every child it starts (and its own setup door)
 * carries it. Run by hand it is unset, and the same scripts watch
 * nothing — the job manager owns their lifetime there.
 */

import { supervisorPidEnv } from "./env";

/** Is `pid` a live process? EPERM means it exists and is not ours — alive. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Call `onGone` once `pid` no longer exists, checking every `everyMs`.
 * Returns a stop function. The timer is unref'd: it never keeps a process
 * alive that would otherwise have finished. */
export function watchPid(pid: number, onGone: () => void, everyMs = 1000): () => void {
  const timer = setInterval(() => {
    if (alive(pid)) return;
    clearInterval(timer);
    onGone();
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** The supervisor's identity, including when its setup door runs in this
 * process. Whether to watch that pid is a separate lifecycle decision. */
export function supervisorPid(): number | null {
  const n = supervisorPidEnv() ?? NaN;
  return Number.isInteger(n) && n > 1 ? n : null;
}

/** For a long-lived child of bin/desktop.ts: exit the moment the supervisor
 * is gone, rather than hold the port for a vault nothing is tending.
 * Returns the pid watched, or null when there is none (a job manager's
 * child, a hand-run script). */
export function dieWithSupervisor(name: string): number | null {
  const pid = supervisorPid();
  if (pid === null || pid === process.pid) return null; // only watch upward
  watchPid(pid, () => {
    console.error(`${name}: the supervisor (pid ${pid}) is gone — exiting with it`);
    process.exit(0);
  });
  return pid;
}
