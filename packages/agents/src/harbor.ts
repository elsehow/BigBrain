/**
 * harbor.ts — the shell a desktop's agent runs commands in.
 *
 * Every command runs in the desktop's guest (guests.ts), under
 * `/bin/bash -c`, in a process group of its own, which is its job. Harbor
 * keeps the job table and the settle loop:
 *
 * - a command that is still running after a short settle and owns a
 *   listening port returns early, as a job with that port: the agent just
 *   types `npm run dev`, there is no special tool for servers;
 * - stopping is by process group, SIGTERM then SIGKILL after a grace,
 *   because some dev servers outlive a SIGTERM to their own pid;
 * - a port another desktop holds is reported by name, where the guests know.
 *
 * Harbor spawns nothing and opens no file itself: the guest does both
 * (the plan's I1, held by .oxlintrc.json).
 */
import type { Execution, Guest } from "./guest";
import { LocalGuests, type Guests, type LocalGuestsOptions, type Prepared } from "./guests";
import type { Confinement } from "./sandbox";

export { TAG, SCOPE, scopeOf, commandEnv, loginEnv, type Listener } from "./guests";

const OUTPUT_CAP = 200_000;

export interface Job {
  id: number; desktop: string; command: string; cwd: string;
  pid: number; started: string;
  exited?: { code: number | null; signal: string | null };
  ports: number[];
  output(): string;
}
interface JobState extends Job { guest: Guest; guestJob: number; execution: Execution; done: Promise<void> }
export type RunResult =
  | { status: "exited"; code: number | null; signal: string | null; output: string; job: number }
  | { status: "running"; job: number; ports: number[]; output: string; note: string };

export interface HarborOptions extends LocalGuestsOptions {
  settleMs?: number;              // how long before a still-running command may return as a job
  waitMs?: number;                // the longest a command holds a turn before returning as a job
  graceMs?: number;               // SIGTERM → SIGKILL
  /** Where commands run. Default: LocalGuests over the options above. */
  guests?: Guests;
}

export class Harbor {
  private jobs = new Map<number, JobState>();
  private next = 1;
  readonly guests: Guests;
  constructor(private options: HarborOptions = {}) {
    this.guests = options.guests ?? new LocalGuests(options);
  }

  /** The guest a desktop's file tools use, under `confine`. */
  files(desktop: string, confine?: Confinement): Promise<Guest> {
    return this.guests.files(desktop, confine ?? bare(desktop));
  }

  /** Run a command in its desktop's guest. `confine` says what it may
   * change (sandbox.ts, confinement); without it, only its temp folder.
   * Throws AgentsError, having run nothing, when it can't be confined. */
  async run(desktop: string, command: string, cwd: string, signal?: AbortSignal, confine?: Confinement): Promise<RunResult> {
    const settleMs = this.options.settleMs ?? 3000, waitMs = this.options.waitMs ?? 120_000;
    const p: Prepared = await this.guests.command(desktop, command, confine ?? bare(desktop));
    const buf: string[] = [];
    let size = 0;
    const take = (_kind: string, d: Buffer) => {
      buf.push(d.toString());
      size += d.length;
      while (size > OUTPUT_CAP && buf.length > 1) size -= Buffer.byteLength(buf.shift()!);
    };
    let execution: Execution;
    try { execution = await p.guest.exec(p.argv, { cwd, env: p.env, grace: this.options.graceMs ?? 3000 }, take); }
    catch (e) { p.done(); throw e; }
    const id = this.next++;
    const job: JobState = {
      id, desktop, command, cwd, pid: execution.pid, started: new Date().toISOString(), ports: [],
      guest: p.guest, guestJob: execution.job, execution, done: Promise.resolve(), output: () => buf.join(""),
    };
    this.jobs.set(id, job);
    job.done = execution.exit.then(
      x => { job.exited = x; },
      // the guest went away mid-job: the job is gone with it
      () => { job.exited = { code: null, signal: "SIGKILL" }; },
    ).finally(() => p.done());
    const onAbort = () => { void this.stopJob(id); };
    signal?.addEventListener("abort", onAbort, { once: true });

    const t0 = Date.now();
    try {
      for (;;) {
        const tick = Math.min(500, Math.max(50, settleMs / 4));
        const finished = await Promise.race([job.done.then(() => true), sleep(tick).then(() => false)]);
        if (finished) return { status: "exited", code: job.exited!.code, signal: job.exited!.signal, output: job.output(), job: id };
        const elapsed = Date.now() - t0;
        if (elapsed >= settleMs) {
          const ports = (await p.guest.ports().catch(() => [])).filter(l => l.job === job.guestJob).map(l => l.port);
          if (ports.length) {
            job.ports = [...new Set(ports)].sort((a, b) => a - b);
            return { status: "running", job: id, ports: job.ports, output: job.output(),
              note: `Still running as job ${id}; listening on ${job.ports.map(p => `127.0.0.1:${p}`).join(", ")}.` };
          }
        }
        if (elapsed >= waitMs)
          return { status: "running", job: id, ports: [], output: job.output(), note: `Still running as job ${id} after ${Math.round(waitMs / 1000)}s; it keeps running in the background.` };
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** The desktop that holds a port, if any desktop does. */
  holder(port: number): Promise<string | undefined> {
    return this.guests.holder?.(port) ?? Promise.resolve(undefined);
  }

  /** Resolves when a job's command has exited. */
  whenExited(id: number): Promise<Job["exited"]> {
    const job = this.jobs.get(id);
    return job ? job.done.then(() => job.exited) : Promise.resolve(undefined);
  }

  jobsFor(desktop: string): Job[] { return [...this.jobs.values()].filter(j => j.desktop === desktop); }
  job(id: number): Job | undefined { return this.jobs.get(id); }

  /** The servers a desktop is running now: its live jobs' listening ports. */
  async servers(desktop: string): Promise<Array<{ port: number; pid: number; job?: number; command?: string }>> {
    const live = this.jobsFor(desktop).filter(j => !j.exited) as JobState[];
    const guests = [...new Set(live.map(j => j.guest))];
    const found = (await Promise.all(guests.map(g => g.ports().then(ps => ps.map(p => ({ ...p, guest: g }))).catch(() => [])))).flat();
    const seen = new Set<number>();
    const out: Array<{ port: number; pid: number; job?: number; command?: string }> = [];
    for (const l of found) {
      const job = live.find(j => j.guest === l.guest && j.guestJob === l.job);
      if (!job || seen.has(l.port)) continue;
      seen.add(l.port);
      out.push({ port: l.port, pid: l.pid, job: job.id, command: job.command });
    }
    return out.sort((a, b) => a.port - b.port);
  }

  async stopJob(id: number): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || job.exited) return;
    await job.guest.stopJob(job.guestJob, this.options.graceMs ?? 3000).catch(() => job.execution.close());
    await Promise.race([job.done, sleep(2000)]);
  }

  /** Stop every desktop's processes in this engine's scope: after a restart no agent is running, so they're left over. */
  stopAll(): Promise<number> { return this.guests.stopAll(); }

  /** Stop everything a desktop runs. Returns how many guests or groups. */
  async stopDesktop(desktop: string): Promise<number> {
    const live = this.jobsFor(desktop).filter(j => !j.exited);
    await Promise.all(live.map(j => this.stopJob(j.id)));
    return live.length + await this.guests.stopDesktop(desktop);
  }
}

/** No confinement given: the desktop changes nothing but its temp folder. */
const bare = (desktop: string): Confinement => ({ desktop, write: [], worktrees: [], untrusted: false });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
