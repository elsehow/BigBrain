/**
 * machine.ts — one desktop's machine: its disk, its helper process, and the
 * guest inside (docs/plans/2026-10-12-contained-desktops.md, Lifecycle).
 *
 * A machine's state folder holds its disk (a clone of the image's rootfs),
 * its console log and its record. Starting it spawns the helper with a
 * config on stdin, waits for "running" on the helper's stdout and for the
 * guest's hello, and serves its egress socket. Stopping asks the guest to
 * shut down (it syncs and powers off), then the helper, then kills it.
 *
 * The helper is bigbrain-vm (packages/vm, macOS); on Linux, for tests and
 * development only, qemu.sh stands in for it with the same two sockets.
 * Nothing here interprets what the guest says beyond the Guest client's
 * checks; what the helper says on stdout is parsed as JSON lines and
 * otherwise ignored.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Guest, GuestError, PROTOCOL, clean, type Hello } from "./guest";

/** The image files a machine boots: from the image directory (packages/agents/image, or a downloaded one). */
export interface MachineImage { kernel: string; initramfs: string; rootfs: string; id?: string }

export const imageAt = (dir: string): MachineImage =>
  ({ kernel: join(dir, "vmlinuz"), initramfs: join(dir, "initramfs.cpio"), rootfs: join(dir, "rootfs.img") });

export type MachineState = "stopped" | "starting" | "running" | "stopping" | "failed" | "out-of-date";

export interface MachineOptions {
  /** The machine's state folder: disk.img, console.log, machine.json. */
  dir: string;
  image: MachineImage;
  /** "vz": bigbrain-vm (macOS). "qemu": qemu.sh, a Linux test harness. */
  backend: "vz" | "qemu";
  /** The helper: bigbrain-vm's path, or qemu.sh's. */
  helper: string;
  cpus?: number;
  memoryMiB?: number;
  /** Where the egress socket's connections go: called once per start with its path. */
  egress?: (socketPath: string) => Promise<void>;
  /** Told when the machine stops on its own: a crash, or the guest powering off. */
  onExit?: (why: string) => void;
  /** Host timeouts (PROTOCOL.md): hello within helloMs of the helper's start. */
  helloMs?: number;
  tz?: string;
}

export class MachineError extends Error {
  constructor(message: string, readonly console?: string) { super(message); this.name = "MachineError"; }
}

/** A Unix socket's path is at most 104 bytes on macOS: a long state folder gets its sockets in /tmp. */
export function socketDir(dir: string): string {
  if (Buffer.byteLength(join(dir, "egress.sock")) < 100) return dir;
  const short = join("/tmp", `bigbrain-${process.getuid?.() ?? 0}`, createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 16));
  mkdirSync(short, { recursive: true, mode: 0o700 });
  return short;
}

/** The last `n` lines of a console log, cleaned: what a failure shows. */
export function consoleTail(path: string, n = 20): string {
  try {
    const text = readFileSync(path, "utf8");
    return text.split("\n").filter(Boolean).slice(-n).map(l => clean(l, 200)).join("\n");
  } catch { return ""; }
}

/** Clone the image's rootfs into a desktop's disk: APFS clonefile where it can (shares blocks until written), else a copy. */
export function cloneDisk(rootfs: string, disk: string): void {
  const tmp = `${disk}.partial`;
  rmSync(tmp, { force: true });
  try { copyFileSync(rootfs, tmp, constants.COPYFILE_FICLONE_FORCE); }
  catch {
    // not APFS (or not a clone-capable file system): a sparse-aware copy where cp has one
    const r = Bun.spawnSync(process.platform === "darwin" ? ["cp", rootfs, tmp] : ["cp", "--sparse=always", rootfs, tmp]);
    if (r.exitCode !== 0) throw new MachineError(`Couldn't copy the machine image: ${clean(r.stderr.toString(), 200)}`);
  }
  renameSync(tmp, disk);
}

export class Machine {
  private child?: ChildProcess;
  private exited?: Promise<number | null>;
  private stopping = false;
  state: MachineState = "stopped";
  hello?: Hello;
  readonly sockets: string;

  constructor(private o: MachineOptions) {
    mkdirSync(o.dir, { recursive: true });
    this.sockets = socketDir(o.dir);
  }

  /** Boot this image from now on: a new disk is cloned from its rootfs; an existing disk keeps its own origin. */
  useImage(image: MachineImage): void { this.o.image = image; }

  /** The rootfs a disk was cloned from (machine.json in its folder), if it has one. */
  origin(): string | undefined {
    try { return (JSON.parse(readFileSync(join(this.o.dir, "machine.json"), "utf8")) as { image?: string }).image || undefined; }
    catch { return undefined; }
  }

  get disk(): string { return join(this.o.dir, "disk.img"); }
  get consoleLog(): string { return join(this.o.dir, "console.log"); }
  get guestSocket(): string { return join(this.sockets, "guest.sock"); }
  get egressSocket(): string { return join(this.sockets, "egress.sock"); }

  /** The guest's client. Reaches it only while the machine runs. */
  guest(): Guest { return new Guest(this.guestSocket, { tz: this.o.tz }); }

  /** Make the disk if it is missing; record what it was cloned from. */
  create(): void {
    if (existsSync(this.disk)) return;
    if (!existsSync(this.o.image.rootfs)) throw new MachineError("The machine image isn't here yet.");
    cloneDisk(this.o.image.rootfs, this.disk);
    writeFileSync(join(this.o.dir, "machine.json"), JSON.stringify({ image: this.o.image.id ?? "", protocol: PROTOCOL, created: new Date().toISOString() }, null, 2) + "\n");
  }

  /** Boot, and resolve once the guest has said hello. */
  async start(): Promise<Hello> {
    if (this.state === "running" && this.hello) return this.hello;
    this.create();
    this.state = "starting";
    this.stopping = false;
    rmSync(this.guestSocket, { force: true });
    rmSync(this.egressSocket, { force: true });
    rotate(this.consoleLog);
    if (this.o.egress) await this.o.egress(this.egressSocket);

    const child = this.o.backend === "vz"
      ? spawn(this.o.helper, [], { stdio: ["pipe", "pipe", "pipe"] })
      // qemu.sh runs QEMU and two socats: its own process group, so a kill takes all three
      : spawn("bash", [this.o.helper, resolve(this.o.image.kernel, ".."), this.sockets], {
        detached: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MEMORY: String(this.o.memoryMiB ?? 2048), CPUS: String(this.o.cpus ?? 2), DISK: this.disk, CONSOLE: this.consoleLog } });
    this.child = child;
    this.exited = new Promise(done => child.once("exit", code => done(code)));
    let said = "", stderr = "";
    const why = () => [said, stderr.trim()].filter(Boolean).join("; ").slice(0, 400);
    const running = new Promise<void>((done, fail) => {
      let buf = "";
      child.stdout!.on("data", (d: Buffer) => {
        buf += d.toString();
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          let state: unknown;
          try { state = (JSON.parse(line) as { state?: unknown }).state; } catch { state = line; }
          if (state === "running") done();
          if (state === "failed") {
            try { said = clean((JSON.parse(line) as { error?: string }).error ?? line, 300); } catch { said = clean(line, 300); }
            // the helper's own words on stderr may still be arriving
            setTimeout(() => fail(new MachineError(`The desktop's machine did not start (${why()}).`, consoleTail(this.consoleLog))), 100);
          }
        }
      });
      child.stderr!.on("data", (d: Buffer) => { stderr = clean((stderr + d.toString()).slice(-600), 300); });
      void this.exited!.then(code => fail(new MachineError(`The desktop's machine stopped as it started (exit ${code}${why() ? `: ${why()}` : ""}).`, consoleTail(this.consoleLog))));
    });
    if (this.o.backend === "vz") {
      child.stdin!.write(JSON.stringify({
        kernel: this.o.image.kernel, initramfs: this.o.image.initramfs, cmdline: "console=hvc0 panic=-1 quiet",
        cpus: this.o.cpus ?? defaultCpus(), memoryMiB: this.o.memoryMiB ?? 2048, disk: this.disk, console: this.consoleLog,
        guestSocket: this.guestSocket, egressSocket: this.egressSocket,
      }) + "\n");
    }
    void this.exited.then(code => {
      this.child = undefined;
      const was = this.state;
      this.hello = undefined;
      if (this.stopping) { this.state = "stopped"; return; }
      if (was === "running" || was === "starting") {
        this.state = "failed";
        this.o.onExit?.(`The desktop's machine stopped (exit ${code}).`);
      }
    });

    const deadline = Date.now() + (this.o.helloMs ?? 15_000);
    try {
      await Promise.race([running, sleep(Math.max(0, deadline - Date.now())).then(() => { throw new MachineError("The desktop's machine did not start in time.", consoleTail(this.consoleLog)); })]);
      // the guest listens a moment after the helper says running: try until it answers
      for (;;) {
        try {
          this.hello = await this.guest().hello(Math.max(500, deadline - Date.now()));
          break;
        } catch (e) {
          if (Date.now() > deadline) throw new MachineError("The desktop's machine did not start: its guest never answered.", consoleTail(this.consoleLog));
          if (!(e instanceof GuestError) || !["unreachable", "timeout"].includes(e.code)) throw e;
          await sleep(30);
        }
      }
    } catch (e) {
      await this.kill();
      this.state = "failed";
      throw e;
    }
    if (this.hello.protocol !== PROTOCOL) {
      await this.stop();
      this.state = "out-of-date";
      throw new MachineError(`The desktop's machine speaks protocol ${this.hello.protocol}; this engine speaks ${PROTOCOL}. Rebuild it.`);
    }
    this.state = "running";
    return this.hello;
  }

  /** The guest powers off cleanly; failing that, the helper stops the machine; failing that, it is killed. */
  async stop(): Promise<void> {
    if (!this.child) { if (this.state !== "out-of-date") this.state = "stopped"; return; }
    this.stopping = true;
    this.state = "stopping";
    const exited = this.exited!;
    await this.guest().shutdown().catch(() => undefined);
    if (await within(exited, 10_000)) { this.state = "stopped"; return; }
    this.child?.stdin?.write("stop\n");
    if (this.o.backend === "qemu") this.child?.kill("SIGTERM");
    if (await within(exited, 5000)) { this.state = "stopped"; return; }
    await this.kill();
    this.state = "stopped";
  }

  /** Kill the helper now: the machine stops mid-whatever. ext4's journal covers the disk. */
  async kill(): Promise<void> {
    if (!this.child) return;
    this.stopping = true;
    if (this.o.backend === "qemu" && this.child.pid) { try { process.kill(-this.child.pid, "SIGKILL"); } catch { /* gone */ } }
    else this.child.kill("SIGKILL");
    await within(this.exited!, 5000);
  }

  /** The helper's pid, while it runs. */
  get pid(): number | undefined { return this.child?.pid; }

  /** Remove the machine's disk and state. */
  async delete(): Promise<void> {
    await this.stop();
    rmSync(this.o.dir, { recursive: true, force: true });
  }
}

/** CPUs: min(4, max(2, physical / 2)). */
export function defaultCpus(): number {
  const n = navigator.hardwareConcurrency || 4;
  return Math.min(4, Math.max(2, Math.floor(n / 2)));
}

/** Keep the console log under 1 MB: the previous one moves aside. */
function rotate(path: string): void {
  try { if (statSync(path).size > 1_000_000) renameSync(path, `${path}.1`); } catch { /* none yet */ }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const within = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => true), sleep(ms).then(() => false)]);
