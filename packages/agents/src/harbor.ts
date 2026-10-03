/**
 * harbor.ts — the shell a desktop's agent runs commands in.
 *
 * Every command runs under `/bin/bash -c`, in its own process group, with
 * `BIGBRAIN_DESKTOP=<id>` in its environment. That tag is inherited by
 * everything the command starts and survives daemonizing, so this module can
 * find a desktop's processes without the agent's help:
 *
 * - a command that is still running after a short settle and owns a
 *   listening loopback port returns early, as a job with that port: the
 *   agent just types `npm run dev`, there is no special tool for servers;
 * - stopping is by process group, SIGTERM then SIGKILL after a grace,
 *   because some dev servers outlive a SIGTERM to their own pid;
 * - a port another desktop holds is reported by name.
 *
 * Discovery reads `lsof` (who listens where) and `ps -E` (whose environment
 * carries the tag); both are macOS/BSD tools.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { run } from "./run";

export const TAG = "BIGBRAIN_DESKTOP";
const OUTPUT_CAP = 200_000;

export interface Job {
  id: number; desktop: string; command: string; cwd: string;
  pid: number; started: string;
  exited?: { code: number | null; signal: string | null };
  ports: number[];
  output(): string;
}
type JobState = Job & { child: ChildProcess; done: Promise<void> };
export type RunResult =
  | { status: "exited"; code: number | null; signal: string | null; output: string; job: number }
  | { status: "running"; job: number; ports: number[]; output: string; note: string };
export interface Listener { pid: number; port: number; address: string; desktop?: string }

export interface HarborOptions {
  settleMs?: number;              // how long before a still-running command may return as a job
  waitMs?: number;                // the longest a command holds a turn before returning as a job
  graceMs?: number;               // SIGTERM → SIGKILL
  env?: NodeJS.ProcessEnv;        // the base environment for commands
}

export class Harbor {
  private jobs = new Map<number, JobState>();
  private next = 1;
  constructor(private options: HarborOptions = {}) {}

  run(desktop: string, command: string, cwd: string, signal?: AbortSignal): Promise<RunResult> {
    const settleMs = this.options.settleMs ?? 3000, waitMs = this.options.waitMs ?? 120_000;
    const child = spawn("/bin/bash", ["-c", command], {
      cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...(this.options.env ?? process.env), [TAG]: desktop },
    });
    const id = this.next++;
    const buf: string[] = [];
    let size = 0;
    const job: JobState = {
      id, desktop, command, cwd, pid: child.pid ?? -1, started: new Date().toISOString(), ports: [],
      child, done: Promise.resolve(), output: () => buf.join(""),
    };
    const take = (d: Buffer) => {
      buf.push(d.toString());
      size += d.length;
      while (size > OUTPUT_CAP && buf.length > 1) size -= Buffer.byteLength(buf.shift()!);
    };
    child.stdout!.on("data", take);
    child.stderr!.on("data", take);
    this.jobs.set(id, job);
    const exited = new Promise<void>(done => child.on("close", (code, sig) => { job.exited = { code, signal: sig }; done(); }));
    job.done = exited;
    child.on("error", error => { take(Buffer.from(String(error))); });
    const onAbort = () => { void this.stopJob(id); };
    signal?.addEventListener("abort", onAbort, { once: true });

    return (async (): Promise<RunResult> => {
      const t0 = Date.now();
      try {
        for (;;) {
          const tick = Math.min(500, Math.max(50, settleMs / 4));
          const finished = await Promise.race([exited.then(() => true), sleep(tick).then(() => false)]);
          if (finished) return { status: "exited", code: job.exited!.code, signal: job.exited!.signal, output: job.output(), job: id };
          const elapsed = Date.now() - t0;
          if (elapsed >= settleMs) {
            const ports = (await this.listeners()).filter(l => l.desktop === desktop && this.inGroup(l.pid, job.pid)).map(l => l.port);
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
    })();
  }

  /** Whether `pid` is the job's leader or in its process group. */
  private groups = new Map<number, number>();
  private inGroup(pid: number, leader: number): boolean {
    if (pid === leader) return true;
    const pg = this.groups.get(pid);
    return pg === leader;
  }

  /** Every listening TCP socket, with the desktop whose tag its process carries. */
  async listeners(): Promise<Listener[]> {
    const lsof = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]);
    const out: Listener[] = [];
    let pid = 0;
    for (const line of lsof.out.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n")) {
        const m = /^(.*):(\d+)$/.exec(line.slice(1));
        if (m && pid) out.push({ pid, port: Number(m[2]), address: m[1]! });
      }
    }
    const tags = await this.tags([...new Set(out.map(l => l.pid))]);
    for (const l of out) { const t = tags.get(l.pid); if (t) { l.desktop = t.desktop; this.groups.set(l.pid, t.pgid); } }
    return out;
  }

  /** pid → its desktop tag and process group, for the given pids (or every process). */
  private async tags(pids?: number[]): Promise<Map<number, { desktop: string; pgid: number }>> {
    const map = new Map<number, { desktop: string; pgid: number }>();
    if (pids && !pids.length) return map;
    const args = ["-E", "-ww", "-o", "pid=,pgid=,command=", ...(pids ? ["-p", pids.join(",")] : ["-ax"])];
    const ps = await run("ps", args);
    const pattern = new RegExp(`(?:^|\\s)${TAG}=([a-z0-9-]+)(?:\\s|$)`);
    for (const line of ps.out.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      const tag = m && pattern.exec(m[3]!);
      if (m && tag) map.set(Number(m[1]), { desktop: tag[1]!, pgid: Number(m[2]) });
    }
    return map;
  }

  /** The desktop that holds a port, if any desktop does. */
  async holder(port: number): Promise<string | undefined> {
    return (await this.listeners()).find(l => l.port === port)?.desktop;
  }

  /** Resolves when a job's command has exited. */
  whenExited(id: number): Promise<Job["exited"]> {
    const job = this.jobs.get(id);
    return job ? job.done.then(() => job.exited) : Promise.resolve(undefined);
  }

  jobsFor(desktop: string): Job[] { return [...this.jobs.values()].filter(j => j.desktop === desktop); }
  job(id: number): Job | undefined { return this.jobs.get(id); }

  /** The servers a desktop is running now: tagged listeners, matched to jobs where possible. */
  async servers(desktop: string): Promise<Array<{ port: number; pid: number; job?: number; command?: string }>> {
    const ls = (await this.listeners()).filter(l => l.desktop === desktop);
    const seen = new Set<number>();
    return ls.filter(l => !seen.has(l.port) && seen.add(l.port)).map(l => {
      const job = [...this.jobs.values()].find(j => j.desktop === desktop && !j.exited && (j.pid === l.pid || this.inGroup(l.pid, j.pid)));
      return { port: l.port, pid: l.pid, ...(job ? { job: job.id, command: job.command } : {}) };
    }).sort((a, b) => a.port - b.port);
  }

  async stopJob(id: number): Promise<void> {
    const job = this.jobs.get(id);
    if (job && !job.exited) await this.stopGroups([job.pid]);
  }

  /** Stop everything carrying a desktop's tag, by process group. Returns how many groups. */
  async stopDesktop(desktop: string): Promise<number> {
    const tagged = await this.tags();
    const groups = new Set<number>();
    for (const [, t] of tagged) if (t.desktop === desktop) groups.add(t.pgid);
    for (const j of this.jobsFor(desktop)) if (!j.exited) groups.add(j.pid);
    await this.stopGroups([...groups]);
    return groups.size;
  }

  private async stopGroups(groups: number[]): Promise<void> {
    const alive = (g: number) => { try { process.kill(-g, 0); return true; } catch { return false; } };
    for (const g of groups) { try { process.kill(-g, "SIGTERM"); } catch { /* gone */ } }
    const deadline = Date.now() + (this.options.graceMs ?? 3000);
    while (groups.some(alive) && Date.now() < deadline) await sleep(100);
    for (const g of groups.filter(alive)) { try { process.kill(-g, "SIGKILL"); } catch { /* gone */ } }
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
