/**
 * guests.ts — where a desktop's files and commands live.
 *
 * Harbor and the coding tools reach a desktop's world only through a
 * `Guest` (guest.ts): they never spawn a command or open a file the agent
 * names themselves (the plan's I1). `Guests` says which guest a desktop's
 * next file operation or command goes to, and how the command is run:
 *
 * - LocalGuests (here): `bigbrain-guest --serve` on this machine, one per
 *   desktop, confined by the Launcher (sandbox.ts: Seatbelt). The sandboxed
 *   mode: what the guest touches are the host's own files.
 * - Machines (machine.ts, Phase 3): the guest inside the desktop's machine.
 *
 * A local guest is started under the profile its desktop's confinement
 * gives at that moment. When that changes (another desktop takes a lease,
 * this one reads untrusted material, a port elsewhere starts listening), the
 * next command or file operation gets a new guest, and the old one drains:
 * it keeps the jobs it runs, under the profile they started with, as a
 * command started before such a change always has, and stops when they end.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Guest, GuestError } from "./guest";
import { run } from "./run";
import { DEFAULT_HOSTS, Seatbelt, type Confinement, type Launcher, type SandboxPolicy } from "./sandbox";
import { EgressProxy } from "./proxy";
import { AgentsError } from "./workspace";

/** What runs one command: the guest, and the argv and environment it is given. */
export interface Prepared {
  guest: Guest; argv: string[]; env: Record<string, string>;
  /** Call once the command's job has ended: a draining guest with nothing left goes. */
  done(): void;
}

export interface Guests {
  /** The guest a desktop's file tools use, under what it may change now. */
  files(desktop: string, confine: Confinement): Promise<Guest>;
  /** How a desktop's command runs. Throws AgentsError, having run nothing, when it can't be confined. */
  command(desktop: string, command: string, confine: Confinement): Promise<Prepared>;
  /** The host's own path for a guest path, for the host's hooks (OpenOptions.write and .file);
   * throws for a path the file tools never write. Absent where the guest's files aren't the host's. */
  real?(abs: string, rel: string): string;
  /** Which desktop holds a port on this machine, if any does. */
  holder?(port: number): Promise<string | undefined>;
  /** Stop everything a desktop runs. Returns how many guests or process groups. */
  stopDesktop(desktop: string): Promise<number>;
  /** Stop every desktop's leftovers in this engine's scope (after a restart). */
  stopAll(): Promise<number>;
}

/** Not BIGBRAIN_DESKTOP: the engine reads that as "running inside the app" (lib/env.ts). */
export const TAG = "BIGBRAIN_AGENT_DESKTOP";
/** Which engine's agents a process belongs to: a short hash of its workspace,
 * so two engines on one machine (the app, and a developer's scratch engine)
 * never sweep or stop each other's processes. */
export const SCOPE = "BIGBRAIN_AGENT_SCOPE";
export const scopeOf = (workspaceRoot: string): string => createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12);

/** The system tools discovery needs, by absolute path where they live: an app
 * started from Finder runs with a PATH that may lack /usr/sbin, where lsof is. */
const tool = (name: string, ...dirs: string[]) => dirs.map(d => `${d}/${name}`).find(p => existsSync(p)) ?? name;
const LSOF = tool("lsof", "/usr/sbin", "/usr/bin");
const PS = tool("ps", "/bin", "/usr/bin");
/** What discovery and an identity-only shell start with. */
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** A command's environment: the base, minus the host's own BIGBRAIN_* settings
 * (the app's mode, the vault, ports) and any name the host withholds (its
 * credentials), plus the desktop's tag. An agent working on BigBrain itself
 * must not run its code as the host's app, on the host's vault. */
export function commandEnv(base: NodeJS.ProcessEnv, desktop: string, scope?: string, withheld: Iterable<string> = []): NodeJS.ProcessEnv {
  const deny = new Set(withheld);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith("BIGBRAIN_") && !deny.has(k)) env[k] = v;
  env[TAG] = desktop;
  if (scope) env[SCOPE] = scope;
  return env;
}

let snapshot: Promise<NodeJS.ProcessEnv> | undefined;
/** The person's login shell's environment, taken once: their PATH, version
 * managers and exports, so an agent's commands behave like their terminal.
 * An app started from Finder gets a thinner environment than a shell. The
 * shell starts from an identity-only seed so this process's own variables
 * don't leak in; anything that fails falls back to that seed, never to this
 * process's env. No ssh agent: the sandbox drops one the shell names, too. */
export function loginEnv(): Promise<NodeJS.ProcessEnv> {
  return snapshot ??= (async () => {
    const shell = process.env.SHELL || "/bin/zsh";
    const seed: NodeJS.ProcessEnv = { PATH: SYSTEM_PATH, TERM: "dumb" };
    for (const k of ["HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR"]) if (process.env[k]) seed[k] = process.env[k];
    const out = await new Promise<string | null>(done => {
      const child = spawn(shell, ["-ilc", "env -0"], { env: seed, stdio: ["ignore", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => { child.kill("SIGKILL"); done(null); }, 10_000);
      child.stdout!.on("data", d => chunks.push(d));
      child.on("error", () => { clearTimeout(timer); done(null); });
      child.on("close", code => { clearTimeout(timer); done(code === 0 ? Buffer.concat(chunks).toString() : null); });
    });
    if (!out) return { ...seed };
    const env: NodeJS.ProcessEnv = {};
    for (const pair of out.split("\0")) { const i = pair.indexOf("="); if (i > 0) env[pair.slice(0, i)] = pair.slice(i + 1); }
    return env.PATH ? env : { ...seed };
  })();
}

/** The guest binary: BIGBRAIN_GUEST_BIN, beside the running bun (the app's
 * bundle), or this checkout's build. Undefined when none is built. */
export function guestBinary(): string | undefined {
  const candidates = [
    process.env.BIGBRAIN_GUEST_BIN,
    join(dirname(process.execPath), "bigbrain-guest"),
    resolve(import.meta.dir, "../../guest/target/release/bigbrain-guest"),
    resolve(import.meta.dir, "../../guest/target/debug/bigbrain-guest"),
  ];
  return candidates.find((p): p is string => !!p && existsSync(p));
}

export const NO_GUEST = "Build the guest helper first (bun run guest:build), so this desktop's files and commands have somewhere to run.";

/** Where a write lands, links followed: the file's real path. Never inside a
 * repository's .git (its hooks and config run code), however the path is spelled or linked. */
export function landing(abs: string, rel: string): string {
  let at = abs;
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  // a broken link would be followed to wherever it names
  if (at !== abs && lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink()) throw new AgentsError(`${rel} is a broken link; the file tools don't write through it.`);
  const real = join(realpathSync(at), relative(at, abs));
  if ([rel, real].some(p => p.split(sep).some(s => s.toLowerCase() === ".git"))) throw new AgentsError(`${rel} is inside a .git folder; the file tools don't write there.`);
  return real;
}

export interface Listener { pid: number; port: number; address: string; desktop?: string }

/** Every listening TCP socket on this machine, with the desktop whose tag its process carries (lsof and ps -E: macOS/BSD). */
export async function listeners(scope?: string): Promise<Listener[]> {
  const lsof = await run(LSOF, ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], undefined, { PATH: SYSTEM_PATH });
  const out: Listener[] = [];
  let pid = 0;
  for (const line of lsof.out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n")) {
      const m = /^(.*):(\d+)$/.exec(line.slice(1));
      if (m && pid) out.push({ pid, port: Number(m[2]), address: m[1]! });
    }
  }
  const tagged = await tags(scope, [...new Set(out.map(l => l.pid))]);
  for (const l of out) { const t = tagged.get(l.pid); if (t) l.desktop = t.desktop; }
  return out;
}

/** pid → its desktop tag and process group, for one scope only, for the given pids (or every process). */
async function tags(scope: string | undefined, pids?: number[]): Promise<Map<number, { desktop: string; pgid: number }>> {
  const map = new Map<number, { desktop: string; pgid: number }>();
  if (pids && !pids.length) return map;
  const args = ["-E", "-ww", "-o", "pid=,pgid=,command=", ...(pids ? ["-p", pids.join(",")] : ["-ax"])];
  const ps = await run(PS, args, undefined, { PATH: SYSTEM_PATH });
  const pattern = new RegExp(`(?:^|\\s)${TAG}=([a-z0-9-]+)(?:\\s|$)`);
  const scoped = new RegExp(`(?:^|\\s)${SCOPE}=([a-f0-9]+)(?:\\s|$)`);
  for (const line of ps.out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    const tag = m && pattern.exec(m[3]!);
    if (!m || !tag || scoped.exec(m[3]!)?.[1] !== scope) continue;
    map.set(Number(m[1]), { desktop: tag[1]!, pgid: Number(m[2]) });
  }
  return map;
}

async function stopGroups(groups: number[], graceMs: number): Promise<void> {
  const alive = (g: number) => { try { process.kill(-g, 0); return true; } catch { return false; } };
  for (const g of groups) { try { process.kill(-g, "SIGTERM"); } catch { /* gone */ } }
  const deadline = Date.now() + graceMs;
  while (groups.some(alive) && Date.now() < deadline) await sleep(100);
  for (const g of groups.filter(alive)) { try { process.kill(-g, "SIGKILL"); } catch { /* gone */ } }
}

export interface LocalGuestsOptions {
  /** This engine's agents: it only finds and stops those (scopeOf). */
  scope?: string;
  /** The base environment for commands. Default: the person's login shell's (loginEnv). */
  env?: NodeJS.ProcessEnv | (() => Promise<NodeJS.ProcessEnv>);
  /** Names never passed to a command, whatever the base holds. Asked per command. */
  withheld?: () => Iterable<string>;
  /** What the sandbox keeps from commands. */
  policy?: SandboxPolicy;
  /** What confines each guest. Default: Seatbelt, which refuses off macOS. */
  launcher?: Launcher;
  /** The guest binary. Default: guestBinary(). */
  guest?: string;
  /** Whether discovery (lsof, ps -E) runs: busy ports, holders, the sweep after a restart. Default: on macOS. */
  discovery?: boolean;
  graceMs?: number;
}

interface Instance {
  desktop: string;
  /** What its profile was made from: a new one is needed when this changes. */
  key: string;
  /** The same, without the busy ports: file operations don't care about those. */
  filesKey: string;
  child: ChildProcess;
  guest: Guest;
  /** What the launcher added to a command's environment (the proxy, the temp folder), and what it took out. */
  added: Record<string, string>;
  removed: string[];
  jobs: number;
  draining: boolean;
  dir: string;
}

/** One local guest per desktop, confined by the Launcher, replaced when the confinement changes. */
export class LocalGuests implements Guests {
  private current = new Map<string, Promise<Instance>>();
  private instances = new Set<Instance>();
  private launcher: Launcher;
  private n = 0;

  constructor(private o: LocalGuestsOptions = {}) {
    const policy = o.policy ?? {};
    // where commands reach the internet: started on the first command
    this.launcher = o.launcher ?? new Seatbelt(policy, new EgressProxy({ hosts: desktop => policy.hosts?.(desktop) ?? DEFAULT_HOSTS, ask: policy.ask }));
  }

  private get discovery(): boolean { return this.o.discovery ?? process.platform === "darwin"; }

  private base(): Promise<NodeJS.ProcessEnv> {
    const env = this.o.env;
    return typeof env === "function" ? env() : env ? Promise.resolve(env) : loginEnv();
  }

  real(abs: string, rel: string): string { return landing(abs, rel); }

  async holder(port: number): Promise<string | undefined> {
    if (!this.discovery) return undefined;
    return (await listeners(this.o.scope)).find(l => l.port === port)?.desktop;
  }

  async files(desktop: string, confine: Confinement): Promise<Guest> {
    const live = await this.current.get(desktop)?.catch(() => undefined);
    if (live && !live.draining && live.filesKey === keyOf(confine)) return live.guest;
    return (await this.instance(desktop, confine)).guest;
  }

  async command(desktop: string, command: string, confine: Confinement): Promise<Prepared> {
    const inst = await this.instance(desktop, confine);
    // the environment is taken per command: a credential withheld since is withheld now
    const env = commandEnv(await this.base(), desktop, this.o.scope, this.o.withheld?.());
    for (const k of inst.removed) delete env[k];
    inst.jobs++;
    let settled = false;
    return {
      guest: inst.guest, argv: ["/bin/bash", "-c", command], env: { ...strings(env), ...inst.added },
      done: () => { if (settled) return; settled = true; inst.jobs--; this.reap(inst); },
    };
  }

  /** The desktop's guest under this confinement: the current one if it fits, else a new one (the old drains). */
  private async instance(desktop: string, confine: Confinement): Promise<Instance> {
    // every port something else listens on now: the person's services, other desktops' servers
    const busy = this.discovery ? (await listeners(this.o.scope).catch(() => [])).filter(l => l.desktop !== desktop).map(l => l.port) : [];
    const key = `${keyOf(confine)}|${[...new Set(busy)].sort((a, b) => a - b).join(",")}`;
    const pending = this.current.get(desktop);
    const live = await pending?.catch(() => undefined);
    if (live && !live.draining && live.key === key && live.child.exitCode === null) return live;
    if (live) { live.draining = true; this.reap(live); }
    const next = this.start(desktop, confine, busy, key);
    this.current.set(desktop, next);
    next.catch(() => { if (this.current.get(desktop) === next) this.current.delete(desktop); });
    return next;
  }

  private async start(desktop: string, confine: Confinement, busy: number[], key: string): Promise<Instance> {
    // "" says "no guest", as a test of the refusal does
    const bin = this.o.guest === "" ? undefined : this.o.guest ?? guestBinary();
    if (!bin) throw new AgentsError(NO_GUEST);
    const dir = this.launcher.tmp?.(desktop) ?? mkdtempSync(join(tmpdir(), "bigbrain-guest-"));
    const sock = join(dir, `guest-${process.pid}-${++this.n}.sock`);
    rmSync(sock, { force: true });
    const env = commandEnv(await this.base(), desktop, this.o.scope, this.o.withheld?.());
    const launch = await this.launcher.launch({ command: `exec ${shq(bin)} --serve --unix ${shq(sock)}`, env, confine, busy });
    const child = spawn(launch.file, launch.args, { env: launch.env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let said = "";
    child.stderr!.on("data", (d: Buffer) => { said = (said + d.toString()).slice(-400); });
    const exited = new Promise<void>(done => child.once("exit", () => done()));
    const guest = new Guest(sock);
    const deadline = Date.now() + 10_000;
    for (;;) {
      if (child.exitCode !== null || child.signalCode) throw new AgentsError(`The sandbox could not start this desktop's guest (${said.trim().slice(0, 300) || `exit ${child.exitCode ?? child.signalCode}`}), so this did not run.`);
      if (existsSync(sock)) {
        try { await guest.hello(2000); break; }
        catch (e) { if (!(e instanceof GuestError) || !["unreachable", "timeout"].includes(e.code)) throw e; }
      }
      if (Date.now() > deadline) { child.kill("SIGKILL"); throw new AgentsError("This desktop's guest did not start in time, so this did not run."); }
      await Promise.race([sleep(20), exited]);
    }
    const given = strings(env), launched = strings(launch.env);
    const inst: Instance = { desktop, key, filesKey: keyOf(confine), child, guest, jobs: 0, draining: false, dir,
      added: Object.fromEntries(Object.entries(launched).filter(([k, v]) => given[k] !== v)),
      removed: Object.keys(given).filter(k => !(k in launched)) };
    this.instances.add(inst);
    void exited.then(() => { this.instances.delete(inst); rmSync(sock, { force: true }); });
    return inst;
  }

  /** A draining guest with no jobs left stops. */
  private reap(inst: Instance): void {
    if (!inst.draining || inst.jobs > 0) return;
    void this.shutdown(inst);
  }

  private async shutdown(inst: Instance): Promise<void> {
    this.instances.delete(inst);
    await inst.guest.shutdown().catch(() => undefined);
    const gone = await Promise.race([new Promise<boolean>(done => inst.child.exitCode !== null ? done(true) : inst.child.once("exit", () => done(true))), sleep(5000).then(() => false)]);
    if (!gone) { try { process.kill(-inst.child.pid!, "SIGKILL"); } catch { /* gone */ } }
  }

  async stopDesktop(desktop: string): Promise<number> {
    const mine = [...this.instances].filter(i => i.desktop === desktop);
    this.current.delete(desktop);
    await Promise.all(mine.map(i => this.shutdown(i)));
    // what a job left running outside its own group: found by tag
    let swept = 0;
    if (this.discovery) {
      const groups = new Set([...(await tags(this.o.scope)).values()].filter(t => t.desktop === desktop).map(t => t.pgid));
      await stopGroups([...groups], this.o.graceMs ?? 3000);
      swept = groups.size;
    }
    return mine.length + swept;
  }

  async stopAll(): Promise<number> {
    const all = [...this.instances];
    this.current.clear();
    await Promise.all(all.map(i => this.shutdown(i)));
    if (!this.discovery) return all.length;
    const groups = new Set([...(await tags(this.o.scope)).values()].map(t => t.pgid));
    await stopGroups([...groups], this.o.graceMs ?? 3000);
    return all.length + groups.size;
  }
}

const strings = (env: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string"));

/** What a desktop may change, as a key: a new guest when it differs. */
const keyOf = (c: Confinement) => JSON.stringify([c.write, c.worktrees, c.untrusted, c.ws ?? null]);
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
