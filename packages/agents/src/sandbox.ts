/**
 * sandbox.ts — what a desktop's commands may touch.
 *
 * Every command, and everything it starts, runs under macOS's sandbox
 * (`sandbox-exec`) with a Seatbelt profile written for that command. It
 * denies by default; its shape follows OpenAI Codex's and Anthropic's
 * sandbox-runtime profiles:
 *
 * - reads: everywhere, except what the host names (credential stores, its
 *   vault), this package's state, and other desktops' folders;
 * - writes: the desktop's own folder (its worktrees) and temp folder, the
 *   projects it may edit in place (none once it has read untrusted
 *   material), what a commit in its worktrees writes to their shared .git,
 *   and shared toolchain caches (its own instead, once untrusted). Never a
 *   repository's hooks or config, or the files that say where a .git is:
 *   host-side git runs in these folders;
 * - network: loopback, except the host's ports and every port something
 *   outside the desktop listens on when the command starts (one that starts
 *   listening later stays reachable from commands already running, debugger
 *   ports apart); beyond this machine only through the egress proxy
 *   (proxy.ts), to allowlisted hosts;
 * - IPC: a few system services (user lookup, logging, reading preferences);
 *   no Apple events, Launch Services, keychain, pasteboard or ssh agent.
 *   Signals and process inspection reach only the command's own processes.
 *
 * No sandbox, no shell: elsewhere than macOS, or when sandbox-exec is missing
 * or refuses the profile, a command is refused, never run unconfined.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { run } from "./run";
import { listWork } from "./worktree";
import { AgentsError, checkDesktopId, leaseHolder, listProjects, type Workspace } from "./workspace";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** What the host keeps from every command. Each is asked per command. */
export interface SandboxPolicy {
  /** Paths commands never read or write: credential stores, the host's vault. */
  deny?: () => Iterable<string>;
  /** Loopback ports commands never connect to, listening or not: the host's own servers. */
  ports?: () => Iterable<number>;
  /** What commands reach beyond this machine: host names (`*.example.com`
   * covers subdomains), through the egress proxy, and `localhost:<port>` for
   * a local service a project uses, such as a database. Default: DEFAULT_HOSTS. */
  hosts?: () => Iterable<string>;
  /** Shared toolchain caches a trusted desktop's commands may write. Default: CACHES. */
  caches?: readonly string[];
}

/** What one of a desktop's commands may change (confinement). */
export interface Confinement {
  desktop: string;
  /** The desktop's own folder, and each project it may edit in place. */
  write: string[];
  /** The desktop's worktrees: a commit there writes its project's shared .git. */
  worktrees: Array<{ path: string; branch: string }>;
  /** It has read untrusted material: shared caches stay read-only to it. */
  untrusted: boolean;
  /** The workspace's desktops/ (only this desktop's own is readable) and this package's state (unreadable). */
  ws?: { desktops: string; state: string };
}

/** The program, arguments and environment that run one command confined. */
export interface Launch { file: string; args: string[]; env: NodeJS.ProcessEnv }

/** Runs a desktop's command confined, or refuses it with an AgentsError.
 * Harbor's is Seatbelt; it is the swappable piece, for a sandbox elsewhere.
 * `busy`: loopback ports something outside the desktop listens on. */
export interface Launcher {
  launch(job: { command: string; env: NodeJS.ProcessEnv; confine: Confinement; busy: number[] }): Promise<Launch>;
}

/** Package registries, and the hosts dependency fetches come from. */
export const DEFAULT_HOSTS = [
  "registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org",
  "crates.io", "static.crates.io", "index.crates.io", "proxy.golang.org", "sum.golang.org", "rubygems.org",
  "github.com", "codeload.github.com", "objects.githubusercontent.com",
];

/** Toolchain caches, home-relative, that installs and builds write (cargo's
 * by name: the rest of ~/.cargo holds its config and the binaries on PATH). */
export const CACHES = [
  ".bun/install/cache", ".npm", ".cache/node/corepack", "Library/Caches/node-gyp", "Library/Caches/Yarn",
  "Library/pnpm", "Library/Caches/pnpm", "Library/Caches/pip", ".cache/uv", "go/pkg/mod", "Library/Caches/go-build",
  ".cargo/registry", ".cargo/git", ...["package-cache", "package-cache-mutate", "global-cache", "global-cache-journal", "global-cache-wal", "global-cache-shm"].map(f => `.cargo/.${f}`),
];

/** An untrusted desktop's caches: its own, by the variables each tool reads,
 * so nothing it fetched is installed from a shared cache later. */
const OWN_CACHES: Record<string, string> = {
  npm_config_cache: "npm", BUN_INSTALL_CACHE_DIR: "bun", YARN_CACHE_FOLDER: "yarn", npm_config_store_dir: "pnpm",
  PIP_CACHE_DIR: "pip", UV_CACHE_DIR: "uv", GOMODCACHE: "gomod", GOCACHE: "gobuild",
};

/** Debugger ports: a debugger listening there runs code outside the sandbox, whenever it opens. */
const DEBUGGER_PORTS = [9222, 9229];

/** System services commands may look up (from Codex's and sandbox-runtime's lists;
 * none that opens apps, sends Apple events, or reads the keychain or pasteboard).
 * trustd verifies TLS for pip, Go and Swift, and may fetch a certificate's
 * issuer itself; configd answers the proxy lookups uv and others make. */
const SERVICES = [
  "com.apple.system.opendirectoryd.libinfo", "com.apple.system.opendirectoryd.membership", "com.apple.system.DirectoryService.libinfo_v1",
  "com.apple.system.logger", "com.apple.logd", "com.apple.diagnosticd", "com.apple.system.notification_center",
  "com.apple.bsd.dirhelper", "com.apple.PowerManagement.control", "com.apple.cfprefsd.daemon", "com.apple.cfprefsd.agent",
  "com.apple.FontObjectsServer", "com.apple.fonts", "com.apple.trustd.agent", "com.apple.SystemConfiguration.configd",
];

/** sysctls commands may read (sandbox-runtime's list). */
const SYSCTLS = [
  "hw.activecpu", "hw.busfrequency_compat", "hw.byteorder", "hw.cacheconfig", "hw.cachelinesize_compat", "hw.cpufamily",
  "hw.cpufrequency", "hw.cpufrequency_compat", "hw.cputype", "hw.l1dcachesize_compat", "hw.l1icachesize_compat",
  "hw.l2cachesize_compat", "hw.l3cachesize_compat", "hw.logicalcpu", "hw.logicalcpu_max", "hw.machine", "hw.model", "hw.memsize",
  "hw.ncpu", "hw.nperflevels", "hw.packages", "hw.pagesize", "hw.pagesize_compat", "hw.physicalcpu", "hw.physicalcpu_max",
  "hw.tbfrequency_compat", "hw.vectorunit", "kern.argmax", "kern.bootargs", "kern.hostname", "kern.maxfiles",
  "kern.maxfilesperproc", "kern.maxproc", "kern.ngroups", "kern.osproductversion", "kern.osrelease", "kern.ostype",
  "kern.osvariant_status", "kern.osversion", "kern.iossupportversion", "kern.secure_kernel", "kern.sysv.semmns", "kern.tcsm_available", "kern.tcsm_enable",
  "kern.usrstack64", "kern.version", "kern.willshutdown", "machdep.cpu.brand_string", "machdep.ptrauth_enabled",
  "security.mac.lockdown_mode_state", "sysctl.proc_cputype", "vm.loadavg",
];
const SYSCTL_PREFIXES = ["hw.optional.", "hw.perflevel", "kern.proc.all", "kern.proc.pgrp.", "kern.proc.pid.", "machdep.cpu.", "net.routetable."];

const str = (s: string) => JSON.stringify(s);
const rx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const inside = (dir: string, path: string) => path === dir || path.startsWith(dir === "/" ? "/" : dir + sep);

/** A path as Seatbelt sees it: links resolved, as far as it exists. */
export function canonical(path: string): string {
  try { return realpathSync(path); }
  catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonical(parent), basename(path));
  }
}

/** What a desktop's next command may change. A desktop that has read
 * untrusted material writes only its own folder; otherwise also every project
 * no other desktop holds the lease on. projects/ itself is never written:
 * host-side git runs in what is there. */
export function confinement(ws: Workspace, desktop: string, untrusted: boolean): Confinement {
  const own = join(ws.desktops, checkDesktopId(desktop));
  mkdirSync(own, { recursive: true });
  const inPlace = untrusted ? [] : listProjects(ws).filter(p => [undefined, desktop].includes(leaseHolder(ws, p.name))).map(p => p.path);
  return { desktop, write: [own, ...inPlace], worktrees: listWork(ws, desktop).map(w => ({ path: w.path, branch: w.branch })), untrusted,
    ws: { desktops: ws.desktops, state: ws.state } };
}

/** A folder's git directories: its .git, the gitdir that names, and their common dir. */
function gitOf(dir: string): { gitdir: string; common: string } | undefined {
  const dotgit = join(dir, ".git");
  const stat = lstatSync(dotgit, { throwIfNoEntry: false });
  if (!stat) return undefined;
  try {
    if (!stat.isFile()) { const g = realpathSync(dotgit); return { gitdir: g, common: g }; }
    const named = /^gitdir: (.+)$/m.exec(readFileSync(dotgit, "utf8"))?.[1]?.trim();
    if (!named) return undefined;
    const gitdir = realpathSync(resolve(dir, named));
    const common = existsSync(join(gitdir, "commondir")) ? realpathSync(resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim())) : gitdir;
    return { gitdir, common };
  } catch { return undefined; }
}

export interface ProfileInput {
  /** Writable folders, and writable paths by pattern (a worktree's branch in its shared .git). */
  write: string[];
  writeRegex: string[];
  /** Folders never written (hooks). */
  protect: string[];
  /** Paths never written, moved or replaced (config, a .git, the files that say where a .git is), exactly and by pattern. */
  pin: string[];
  pinRegex: string[];
  /** Never read or written. */
  deny: string[];
  /** Folders whose entries are unreadable, but `except`. */
  hidden: Array<{ dir: string; except: string }>;
  /** Loopback ports never connected to. */
  ports: number[];
}

/** The Seatbelt profile. Seatbelt applies the last rule that matches. */
export function profile(p: ProfileInput): string {
  const any = (op: string, filters: string[]) => filters.length ? [`(${op}`, ...filters.map(f => `  ${f}`), ")"] : [];
  const sub = (d: string) => `(subpath ${str(d)})`, lit = (f: string) => `(literal ${str(f)})`, re = (r: string) => `(regex ${str(r)})`;
  const ancestors = new Set<string>();
  for (const f of [...p.protect, ...p.pin]) for (let d = dirname(f); d !== "/" && d !== "."; d = dirname(d)) ancestors.add(d);
  return [
    "(version 1)",
    "(deny default)",
    // children inherit this profile; signals and inspection stay inside it
    "(allow process-exec process-fork)",
    "(allow process-info* (target same-sandbox))",
    "(allow signal (target same-sandbox))",
    "(allow mach-priv-task-port (target same-sandbox))",
    ...any("allow sysctl-read", [...SYSCTLS.map(n => `(sysctl-name ${str(n)})`), ...SYSCTL_PREFIXES.map(n => `(sysctl-name-prefix ${str(n)})`)]),
    '(allow sysctl-write (sysctl-name "kern.tcsm_enable") (sysctl-name "kern.grade_cputype"))',
    ...any("allow mach-lookup", SERVICES.map(n => `(global-name ${str(n)})`)),
    "(allow user-preference-read)",
    '(allow ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs.") (ipc-posix-name "apple.shm.notification_center"))',
    '(allow ipc-posix-shm-read-data ipc-posix-shm-write-create ipc-posix-shm-write-unlink (ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$"))',
    "(allow ipc-posix-sem)",
    '(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))',
    "(allow iokit-get-properties)",
    "(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))",
    "(allow pseudo-tty)",
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/dtracehelper") (literal "/dev/tty") (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$"))',
    // reads: everywhere but the denied, and other desktops' folders
    "(allow file-read*)",
    ...any("deny file-read*", p.hidden.map(h => re(`^${rx(h.dir)}/.`))),
    ...any("allow file-read*", p.hidden.map(h => sub(h.except))),
    ...any("deny file-read*", p.deny.map(sub)),
    // writes
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (literal "/dev/dtracehelper") (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$") (regex #"^/dev/fd/[0-9]+$"))',
    ...any("allow file-write*", [...p.write.map(sub), ...p.writeRegex.map(re)]),
    ...any("deny file-write*", [...p.deny.map(sub), ...p.protect.map(sub), ...p.pin.map(lit), ...p.pinRegex.map(re)]),
    // nor by moving a folder above it aside
    ...any("deny file-write-unlink file-write-create", [...ancestors].sort().map(lit)),
    // network: loopback (any of this machine's addresses) but the denied
    // ports. Seatbelt ignores a port deny under an `ip` loopback allow, so
    // both name their protocols.
    '(allow network-bind (local ip "*:*"))',
    '(allow network-inbound (local ip "localhost:*"))',
    '(allow network-outbound (remote tcp4 "localhost:*") (remote tcp6 "localhost:*"))',
    ...any("deny network-outbound", p.ports.flatMap(n => [`(remote tcp4 "localhost:${n}")`, `(remote tcp6 "localhost:${n}")`])),
    "(allow system-socket (socket-domain AF_UNIX))",
    ...any("allow network-bind", p.write.map(d => `(local unix-socket ${sub(d)})`)),
    ...any("allow network-outbound", [...p.write.map(d => `(remote unix-socket ${sub(d)})`), lit("/private/var/run/syslog")]),
    "",
  ].join("\n");
}

/** The parts of one command's profile: what it writes, the .git files it must
 * not touch, and what it must not read. A folder that would expose the denied
 * (one holding the home folder or a credential store) is never writable. */
export function profileInput(c: Confinement, o: { deny: string[]; tmp: string; caches: string[]; ports: number[] }): ProfileInput {
  const deny = [...new Set([...o.deny, ...(c.ws ? [c.ws.state] : [])].map(canonical))];
  const home = canonical(homedir());
  const safe = (d: string) => d !== "/" && !inside(d, home) && !deny.some(x => inside(d, x) || inside(x, d));
  const write = [...new Set([...c.write, o.tmp, ...o.caches].map(canonical))].filter(safe);
  const writable = (path: string) => write.some(d => inside(d, path));
  const writeRegex: string[] = [], protect: string[] = [], pin: string[] = [], pinRegex: string[] = [];
  const guard = (common: string) => {
    protect.push(join(common, "hooks"), join(common, "modules"));
    pin.push(...["config", "config.worktree", "commondir"].map(f => join(common, f)));
    pinRegex.push(`^${rx(common)}/worktrees/[^/]+/(commondir|gitdir|config\\.worktree)$`);
  };
  for (const dir of c.write) {
    const real = canonical(dir), git = gitOf(real);
    if (!git || !writable(real)) continue;
    pin.push(join(real, ".git"));
    // a project that is itself a linked worktree commits into its repo's common dir
    if (!writable(git.common) && safe(git.common)) write.push(git.common);
    guard(git.common);
  }
  for (const w of c.worktrees) {
    const real = canonical(w.path), git = gitOf(real);
    if (!git || !writable(real)) continue;
    pin.push(join(real, ".git"), ...["commondir", "gitdir", "config.worktree"].map(f => join(git.gitdir, f)));
    guard(git.common);
    if (writable(git.common) || !safe(git.common) || !inside(join(git.common, "worktrees"), git.gitdir)) continue;
    // what a commit on the worktree's own branch writes, and nothing else of its
    // repo (git locks packed-refs too; packed-refs itself stays unwritable)
    write.push(join(git.common, "objects"), git.gitdir);
    writeRegex.push(`^${rx(git.common)}/(logs/)?refs/heads/${rx(w.branch)}(\\.lock)?$`, `^${rx(git.common)}/packed-refs\\.lock$`);
  }
  const hidden = [{ dir: dirname(o.tmp), except: o.tmp }, ...(c.ws ? [{ dir: canonical(c.ws.desktops), except: canonical(join(c.ws.desktops, c.desktop)) }] : [])];
  return { write, writeRegex, protect: [...new Set(protect)], pin: [...new Set(pin)], pinRegex: [...new Set(pinRegex)], deny, hidden, ports: o.ports };
}

/** The loopback port of the egress proxy commands reach the internet through. */
export interface Egress { port(): Promise<number> }

/** Commands confined by Seatbelt (macOS). Refuses when it can't confine. */
export class Seatbelt implements Launcher {
  constructor(private policy: SandboxPolicy, private egress: Egress,
    private options: { exec?: string; tmp?: string; platform?: NodeJS.Platform } = {}) {}

  private get exec(): string { return this.options.exec ?? SANDBOX_EXEC; }

  /** Why commands can't be confined here, if they can't. */
  unavailable(): string | undefined {
    if ((this.options.platform ?? process.platform) !== "darwin") return "Commands run only inside a sandbox, and BigBrain has one only on macOS, so this command did not run.";
    if (!existsSync(this.exec)) return `Commands run only inside macOS's sandbox, and ${this.exec} is missing, so this command did not run.`;
    return undefined;
  }

  /** A desktop's temp folder: TMPDIR for its commands, unreadable to other desktops'. */
  tmp(desktop: string): string {
    const dir = join(this.options.tmp ?? join(canonical(tmpdir()), "bigbrain-desktops"), checkDesktopId(desktop));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return canonical(dir);
  }

  async launch(job: { command: string; env: NodeJS.ProcessEnv; confine: Confinement; busy: number[] }): Promise<Launch> {
    const refused = this.unavailable();
    if (refused) throw new AgentsError(refused);
    const c = job.confine, tmp = this.tmp(c.desktop), proxy = await this.egress.port();
    // what the person lets projects reach directly on this machine, but never the host's own ports
    const local = new Set([...this.policy.hosts?.() ?? []].map(h => /^(?:localhost|127\.0\.0\.1):(\d{1,5})$/.exec(h.trim())?.[1]).filter(Boolean).map(Number));
    const ports = [...new Set([...[...job.busy, ...DEBUGGER_PORTS].filter(p => p !== proxy && !local.has(p)), ...this.policy.ports?.() ?? []])];
    const home = canonical(homedir());
    const caches = c.untrusted ? [] : (this.policy.caches ?? CACHES).map(p => isAbsolute(p) ? p : join(home, p));
    const text = profile(profileInput(c, { deny: [...this.policy.deny?.() ?? []], tmp, caches, ports }));
    // a profile that doesn't load runs nothing: say so, rather than a bare exit code
    const check = await run(this.exec, ["-p", text, "/usr/bin/true"], undefined, {}).catch((e: Error) => ({ code: 1, out: "", err: e.message }));
    if (check.code !== 0) throw new AgentsError(`The sandbox could not start (${(check.err.trim() || `exit ${check.code}`).slice(0, 300)}), so this command did not run.`);
    const url = `http://127.0.0.1:${proxy}`;
    const env: NodeJS.ProcessEnv = { ...job.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
      HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url, http_proxy: url, https_proxy: url, all_proxy: url,
      NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1",
      npm_config_proxy: url, npm_config_https_proxy: url, YARN_HTTP_PROXY: url, YARN_HTTPS_PROXY: url, NODE_USE_ENV_PROXY: "1" };
    // landing and pushing happen outside, with the person's credentials
    delete env.SSH_AUTH_SOCK; delete env.SSH_AGENT_PID;
    if (c.untrusted) for (const [name, dir] of Object.entries(OWN_CACHES)) env[name] = join(tmp, "cache", dir);
    return { file: this.exec, args: ["-p", text, "/bin/bash", "-c", job.command], env };
  }
}
