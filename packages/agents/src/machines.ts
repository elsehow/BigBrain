/**
 * machines.ts — contained desktops: each desktop's files and commands live
 * in a machine of its own (machine.ts), and this is the Guests that says so
 * (the plan's Lifecycle).
 *
 * - A machine starts lazily: on its desktop's first command or file
 *   operation, never on open. The image is fetched first if it isn't here
 *   (images.ts), with progress the host can show.
 * - At most `running` machines run at once (default 3). Starting one more
 *   stops the least recently used idle one (no live job), with an event
 *   saying so; with none idle, the start waits for nothing and goes over.
 * - Three failed starts within an hour leave the desktop's machine failed
 *   until the person retries (`retry`).
 * - Commands are `bash -lc` as `work`; their environment is the guest's own
 *   base (PROTOCOL.md, exec) plus what the host grants a project. Nothing of
 *   the host's environment reaches them (I5).
 * - Egress: each machine's egress socket is served by the engine's proxy as
 *   that desktop's (proxy.ts, serveDesktop), so the proxy knows whose a
 *   connection is from the socket it arrives on.
 */
import { join } from "node:path";
import type { Guest } from "./guest";
import type { Guests, Prepared } from "./guests";
import { Machine, MachineError, type MachineState } from "./machine";
import type { MachineImages, Progress } from "./images";
import type { EgressProxy } from "./proxy";
import { AgentsError, checkDesktopId, stateFolder, type Workspace } from "./workspace";

export type MachineEvent =
  | { type: "machine.preparing"; got: number; total: number }
  | { type: "machine.started"; ms: number; image: string }
  | { type: "machine.stopped"; why: string }
  | { type: "machine.failed"; message: string; console: string };

export interface MachinesOptions {
  ws: Workspace;
  images: MachineImages;
  proxy: EgressProxy;
  /** "vz": the macOS helper; "qemu": the Linux test harness. */
  backend: "vz" | "qemu";
  helper: string;
  /** Machines running at once (Settings). Default 3. */
  running?: () => number;
  /** Memory per machine in MiB (Settings, 1 to 8 GiB). Default 2048. */
  memoryMiB?: () => number;
  cpus?: number;
  /** Values a desktop's commands get beyond the guest's base: what the host grants a project. */
  env?: (desktop: string) => Record<string, string>;
  /** Told what happens to a desktop's machine. */
  onEvent?: (desktop: string, event: MachineEvent) => void;
  tz?: string;
}

interface Entry {
  machine: Machine;
  jobs: number;
  used: number;
  starting?: Promise<void>;
  failures: number[];
}

const FAILURES = 3, FAILURE_WINDOW = 60 * 60 * 1000;

export class Machines implements Guests {
  private entries = new Map<string, Entry>();
  private listeners = new Set<(desktop: string, event: MachineEvent) => void>();
  constructor(private o: MachinesOptions) {}

  /** Hear what happens to every desktop's machine. Returns the way to stop hearing. */
  on(listener: (desktop: string, event: MachineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(desktop: string, event: MachineEvent): void {
    this.o.onEvent?.(desktop, event);
    for (const l of this.listeners) l(desktop, event);
  }

  private entry(desktop: string): Entry {
    let e = this.entries.get(checkDesktopId(desktop));
    if (!e) {
      const machine = new Machine({
        dir: join(stateFolder(this.o.ws, desktop), "vm"), image: { kernel: "", initramfs: "", rootfs: "" },
        backend: this.o.backend, helper: this.o.helper, cpus: this.o.cpus, memoryMiB: this.o.memoryMiB?.(), tz: this.o.tz,
        egress: path => this.o.proxy.serveDesktop(desktop, path),
        onExit: why => { this.o.proxy.unserveDesktop(desktop); this.emit(desktop, { type: "machine.failed", message: why, console: "" }); },
      });
      e = { machine, jobs: 0, used: 0, failures: [] };
      this.entries.set(desktop, e);
    }
    return e;
  }

  /** A desktop's machine's state, without starting it. */
  state(desktop: string): MachineState { return this.entries.get(desktop)?.machine.state ?? "stopped"; }

  /** The desktop's machine, running: started (and its image fetched) if it isn't. */
  async running(desktop: string): Promise<Machine> {
    const e = this.entry(desktop);
    e.used = Date.now();
    if (e.machine.state === "running") return e.machine;
    if (e.machine.state === "out-of-date") throw new AgentsError("This desktop's machine is out of date: rebuild it to keep working (its uncommitted work is lost; land it first).");
    e.starting ??= this.start(desktop, e).finally(() => { e.starting = undefined; });
    await e.starting;
    return e.machine;
  }

  private async start(desktop: string, e: Entry): Promise<void> {
    const now = Date.now();
    e.failures = e.failures.filter(t => now - t < FAILURE_WINDOW);
    if (e.failures.length >= FAILURES) throw new AgentsError("This desktop's machine failed to start three times in the last hour. Retry it from the desktop when you're ready.");
    const image = await this.o.images.ensure((p: Progress) => this.emit(desktop, { type: "machine.preparing", got: p.got, total: p.total }));
    // the disk's origin stays its own; the kernel and initramfs are always the current ones
    e.machine.useImage(image);
    await this.makeRoom(desktop);
    const t0 = Date.now();
    try {
      const hello = await e.machine.start();
      this.emit(desktop, { type: "machine.started", ms: Date.now() - t0, image: hello.image });
    } catch (err) {
      e.failures.push(Date.now());
      const message = err instanceof Error ? err.message : String(err);
      this.emit(desktop, { type: "machine.failed", message, console: err instanceof MachineError ? err.console ?? "" : "" });
      throw new AgentsError(message);
    }
  }

  /** Over the cap: stop the least recently used idle machine. */
  private async makeRoom(desktop: string): Promise<void> {
    const cap = Math.max(1, this.o.running?.() ?? 3);
    const live = [...this.entries.entries()].filter(([id, e]) => id !== desktop && ["running", "starting"].includes(e.machine.state));
    if (live.length < cap) return;
    const idle = live.filter(([, e]) => e.jobs === 0 && e.machine.state === "running").sort((a, b) => a[1].used - b[1].used);
    for (const [id] of idle.slice(0, live.length - cap + 1)) await this.stop(id, `${cap} machines were running; this one was idle longest`);
  }

  /** Clear the record of failed starts, so the next command tries again. */
  retry(desktop: string): void { this.entry(desktop).failures = []; }

  async files(desktop: string): Promise<Guest> { return (await this.running(desktop)).guest(); }

  async command(desktop: string, command: string): Promise<Prepared> {
    const m = await this.running(desktop);
    const e = this.entry(desktop);
    e.jobs++;
    let settled = false;
    return {
      guest: m.guest(), argv: ["/bin/bash", "-lc", command], env: this.o.env?.(desktop) ?? {},
      done: () => { if (settled) return; settled = true; e.jobs--; e.used = Date.now(); },
    };
  }

  /** Stop a desktop's machine: its guest powers off. Its disk stays. */
  async stop(desktop: string, why = "stopped"): Promise<void> {
    const e = this.entries.get(desktop);
    if (!e || e.machine.state === "stopped") return;
    await e.machine.stop();
    this.o.proxy.unserveDesktop(desktop);
    this.emit(desktop, { type: "machine.stopped", why });
  }

  async stopDesktop(desktop: string): Promise<number> {
    const was = this.state(desktop) === "running" ? 1 : 0;
    await this.stop(desktop, "archived");
    return was;
  }

  async stopAll(): Promise<number> {
    const ids = [...this.entries.keys()].filter(id => this.state(id) === "running");
    await Promise.all(ids.map(id => this.stop(id, "the engine stopped")));
    return ids.length;
  }

  /** Delete a desktop's machine: its disk and everything on it. */
  async delete(desktop: string): Promise<void> {
    const e = this.entries.get(desktop);
    if (e) await e.machine.delete();
    else await this.entry(desktop).machine.delete();
    this.entries.delete(desktop);
    this.o.proxy.unserveDesktop(desktop);
  }

  /** Rebuild an out-of-date machine: a fresh disk from the current image. Uncommitted work in it is lost. */
  async rebuild(desktop: string): Promise<void> {
    await this.delete(desktop);
  }
}
