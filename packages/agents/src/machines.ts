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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { Guest } from "./guest";
import type { Guests, Prepared } from "./guests";
import { Machine, MachineError, type MachineState } from "./machine";
import type { MachineImages, Progress } from "./images";
import type { EgressProxy } from "./proxy";
import { AgentsError, checkDesktopId, stateFolder, type Workspace } from "./workspace";

/** The macOS helper: BIGBRAIN_VM_HELPER, beside the running bun (the app's bundle), or this checkout's build (bun run vm:build). */
export function vmHelper(): string | undefined {
  return [
    process.env.BIGBRAIN_VM_HELPER,
    join(dirname(process.execPath), "bigbrain-vm"),
    resolve(import.meta.dir, "../../vm/.build/release/bigbrain-vm"),
  ].find((p): p is string => !!p && existsSync(p));
}

/** The rootfs a machine's disk came from, from its folder's record. */
function readOrigin(dir: string): string | undefined {
  try { return (JSON.parse(readFileSync(join(dir, "machine.json"), "utf8")) as { image?: string }).image || undefined; }
  catch { return undefined; }
}

/** The Linux test harness that stands in for the helper (image/qemu.sh). */
export const QEMU_HELPER = resolve(import.meta.dir, "../image/qemu.sh");

/** Where a machine's tools look for trusted certificates: the system bundle, which carries this install's CA (Machines.trust). */
const BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
const TRUST_ENV: Record<string, string> = {
  NODE_EXTRA_CA_CERTS: "/usr/local/share/ca-certificates/bigbrain-machine.crt",
  SSL_CERT_FILE: BUNDLE, CURL_CA_BUNDLE: BUNDLE, REQUESTS_CA_BUNDLE: BUNDLE, PIP_CERT: BUNDLE, GIT_SSL_CAINFO: BUNDLE,
  UV_NATIVE_TLS: "1", npm_config_cafile: BUNDLE,
};

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
  /** This install's CA (egressPolicy.ts), PEM: installed in each machine at its start, so the proxy's terminated TLS is trusted there. */
  ca?: () => string;
  /** Told what happens to a desktop's machine. */
  onEvent?: (desktop: string, event: MachineEvent) => void;
  tz?: string;
}

interface Entry {
  machine: Machine;
  /** Guest port → its forward: a host loopback listener joined to the guest's port by connect. */
  forwards: Map<number, { server: Server; port: number; sockets: Set<Socket> }>;
  jobs: number;
  used: number;
  starting?: Promise<void>;
  failures: number[];
  /** While the image downloads for this desktop's first start: how far. */
  preparing?: { got: number; total: number };
  /** The last start that failed, until one succeeds: why, and the console's tail. */
  failure?: { message: string; console: string };
}

/** What the person's header shows of a desktop's machine. */
export interface MachineInfo { state: MachineState; preparing?: { got: number; total: number }; failure?: { message: string; console: string }; blocked?: boolean }

const FAILURES = 3, FAILURE_WINDOW = 60 * 60 * 1000;

export class Machines implements Guests {
  private entries = new Map<string, Entry>();
  private listeners = new Set<(desktop: string, event: MachineEvent) => void>();
  private download?: AbortController;
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
        backend: this.o.backend, helper: this.o.helper, cpus: this.o.cpus, memoryMiB: () => this.o.memoryMiB?.() ?? 2048, tz: this.o.tz,
        egress: path => this.o.proxy.serveDesktop(desktop, path),
        onExit: why => { this.unforwardAll(desktop); this.o.proxy.unserveDesktop(desktop); this.emit(desktop, { type: "machine.failed", message: why, console: "" }); },
      });
      e = { machine, forwards: new Map(), jobs: 0, used: 0, failures: [] };
      this.entries.set(desktop, e);
    }
    return e;
  }

  /** A desktop's machine's state, without starting it. */
  state(desktop: string): MachineState { return this.entries.get(desktop)?.machine.state ?? "stopped"; }

  /** Everything the header shows of a desktop's machine, without starting it. */
  info(desktop: string): MachineInfo {
    const e = this.entries.get(desktop);
    if (!e) return { state: "stopped" };
    const recent = e.failures.filter(t => Date.now() - t < FAILURE_WINDOW).length;
    return { state: e.starting && e.machine.state === "stopped" ? "starting" : e.machine.state,
      ...(e.preparing ? { preparing: e.preparing } : {}), ...(e.failure ? { failure: e.failure } : {}), ...(recent >= FAILURES ? { blocked: true } : {}) };
  }

  /** The rootfs every desktop's disk came from: what pruning keeps. */
  origins(): string[] {
    const out: string[] = [];
    let ids: string[] = [];
    try { ids = readdirSync(this.o.ws.state); } catch { return out; }
    for (const id of ids) {
      const origin = this.entries.get(id)?.machine.origin() ?? readOrigin(join(this.o.ws.state, id, "vm"));
      if (origin) out.push(origin);
    }
    return out;
  }

  /** The machine image here: how much is still to download, and what the image and the desktops' disks take. */
  image(): { missing: number; imageBytes: number; diskBytes: number; local: boolean } {
    const bytes = (dir: string): number => {
      let n = 0;
      try { for (const f of readdirSync(dir, { recursive: true }) as string[]) { try { const st = statSync(join(dir, f)); if (st.isFile()) n += st.blocks * 512; } catch { /* gone */ } } } catch { /* none */ }
      return n;
    };
    let diskBytes = 0;
    try { for (const id of readdirSync(this.o.ws.state)) { try { diskBytes += statSync(join(this.o.ws.state, id, "vm", "disk.img")).blocks * 512; } catch { /* none */ } } } catch { /* none */ }
    let missing = 0;
    try { missing = this.o.images.missing(); } catch { /* no image for this computer */ }
    return { missing, imageBytes: bytes(this.o.images.dir), diskBytes, local: !!process.env.BIGBRAIN_MACHINE_IMAGE };
  }

  /** Remove every image no disk came from. Returns bytes freed. */
  prune(): number { return this.o.images.prune(this.origins()); }

  /** Stop downloading the image: every start waiting on it fails, and says so. */
  cancel(): void { this.download?.abort(); }

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
    this.download ??= new AbortController();
    const image = await this.o.images.ensure((p: Progress) => {
      e.preparing = { got: p.got, total: p.total };
      this.emit(desktop, { type: "machine.preparing", got: p.got, total: p.total });
    }, this.download.signal).catch(err => {
      e.failure = { message: this.download?.signal.aborted ? "Preparing the desktop machine was cancelled." : err instanceof Error ? err.message : String(err), console: "" };
      throw err;
    }).finally(() => { e.preparing = undefined; if (this.download?.signal.aborted) this.download = undefined; });
    // the disk's origin stays its own; the kernel and initramfs are always the current ones
    e.machine.useImage(image);
    await this.makeRoom(desktop);
    const t0 = Date.now();
    try {
      const hello = await e.machine.start();
      await this.trust(e.machine);
      e.failure = undefined;
      this.emit(desktop, { type: "machine.started", ms: Date.now() - t0, image: hello.image });
    } catch (err) {
      e.failures.push(Date.now());
      const message = err instanceof Error ? err.message : String(err);
      e.failure = { message, console: err instanceof MachineError ? err.console ?? "" : "" };
      this.emit(desktop, { type: "machine.failed", message, console: err instanceof MachineError ? err.console ?? "" : "" });
      throw new AgentsError(message);
    }
  }

  /** Install this install's CA in a machine's trust store, when it isn't there already. */
  private async trust(m: Machine): Promise<void> {
    const pem = this.o.ca?.();
    if (!pem) return;
    const g = m.guest();
    const path = "/usr/local/share/ca-certificates/bigbrain-machine.crt";
    const have = await g.stat(path, true).catch(() => undefined);
    const want = createHash("sha256").update(pem).digest("hex");
    if (have?.sha256 === want) return;
    await g.write(path, pem, { parents: true, mode: 0o644 });
    const x = await g.exec(["/usr/sbin/update-ca-certificates"], { cwd: "/", user: "root" }, () => {});
    await x.exit;
  }

  /** Over the cap: stop the least recently used idle machine. */
  private async makeRoom(desktop: string): Promise<void> {
    const cap = Math.max(1, this.o.running?.() ?? 3);
    const live = [...this.entries.entries()].filter(([id, e]) => id !== desktop && ["running", "starting"].includes(e.machine.state));
    if (live.length < cap) return;
    const idle = live.filter(([, e]) => e.jobs === 0 && e.machine.state === "running").sort((a, b) => a[1].used - b[1].used);
    for (const [id] of idle.slice(0, live.length - cap + 1)) await this.stop(id, `${cap} machines were running; this one was idle longest`);
  }

  /** Close a desktop's open connections beyond its machine: what it may reach just shrank (the plan's D9). */
  drop(desktop: string): number { return this.o.proxy.drop(desktop); }

  /** Clear the record of failed starts, so the next command tries again. */
  retry(desktop: string): void { const e = this.entry(desktop); e.failures = []; e.failure = undefined; }

  async files(desktop: string): Promise<Guest> { return (await this.running(desktop)).guest(); }

  async command(desktop: string, command: string): Promise<Prepared> {
    const m = await this.running(desktop);
    const e = this.entry(desktop);
    e.jobs++;
    let settled = false;
    return {
      guest: m.guest(), argv: ["/bin/bash", "-lc", command], env: { ...(this.o.ca ? TRUST_ENV : {}), ...this.o.env?.(desktop) },
      done: () => { if (settled) return; settled = true; e.jobs--; e.used = Date.now(); },
    };
  }

  /** A host loopback port forwarded to the guest's `port` (the plan's Previews). */
  async forward(desktop: string, port: number): Promise<number> {
    const e = this.entry(desktop);
    const known = e.forwards.get(port);
    if (known) return known.port;
    const sockets = new Set<Socket>();
    const server = createServer(client => {
      sockets.add(client);
      client.on("close", () => sockets.delete(client));
      client.on("error", () => client.destroy());
      // held by hand until the guest says yes: bun's paused server socket doesn't give back what it buffered
      const early: Buffer[] = [];
      const hold = (d: Buffer) => early.push(d);
      client.on("data", hold);
      e.machine.guest().connect(port).then(up => {
        sockets.add(up);
        up.on("close", () => { sockets.delete(up); client.destroy(); });
        up.on("error", () => client.destroy());
        client.on("close", () => up.destroy());
        client.off("data", hold);
        for (const b of early) up.write(b);
        client.pipe(up); up.pipe(client); up.resume();
      }).catch(() => client.destroy());
    });
    const hostPort = await new Promise<number>((done, fail) => {
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => done((server.address() as { port: number }).port));
    });
    server.unref();
    e.forwards.set(port, { server, port: hostPort, sockets });
    return hostPort;
  }

  unforward(desktop: string, port: number): void {
    const f = this.entries.get(desktop)?.forwards.get(port);
    if (!f) return;
    f.server.close();
    for (const s of f.sockets) s.destroy();
    this.entries.get(desktop)!.forwards.delete(port);
  }

  private unforwardAll(desktop: string): void {
    // a copy: unforward deletes from the map being walked
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const port of [...this.entries.get(desktop)?.forwards.keys() ?? []]) this.unforward(desktop, port);
  }

  /** Stop a desktop's machine: its guest powers off. Its disk stays. */
  async stop(desktop: string, why = "stopped"): Promise<void> {
    const e = this.entries.get(desktop);
    if (e) this.unforwardAll(desktop);
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

  /** Rebuild a machine: a fresh disk from the current image, on the next command. Everything in it is lost, copies included. */
  async rebuild(desktop: string): Promise<void> {
    await this.delete(desktop);
  }
}
