import { providerLabel } from "./providerPresentation";
import { readEnvValues } from "./envFile";
import { subscriptionConnected } from "./subscriptionConnection";
/** Settings diagnostics reads existing logs and current provider configuration.
 * Model connection tests run through the shared Pi session service. */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { intakeHolder, intakeRunning } from "./assertionAgent";
import { engineIdentity } from "./engine";
import { handoffProcessEnv } from "./env";
import { json, send, type Route } from "./httpx";
import { alive } from "./parentWatch";
import { loadManifest, type Auth } from "./manifest";
import { readMemoryStamp, memoryNeedsRebuild, MEMORY_PROTOCOL_VERSION } from "./memory";
import { previousRunFailure } from "./memoryContext";
import { clip } from "./text";
import { apiKeyPresent, jobsPath, type Check } from "./preflight";
import { nextFireFile } from "./supervisorClock";

/** The per-job logs the supervisor appends to (bin/desktop.ts). */
export const logsDir = (root: string): string => join(root, ".state", "logs");

/** Where tauri-plugin-log writes the shell's own log — the supervisor's
 * lines ride in it prefixed `engine:`. The plugin's default log dir per
 * platform, under the app's identifier (desktop/src-tauri/tauri.conf.json). */
export function shellLogPath(platform: string = process.platform, home: string = homedir()): string {
  const id = "cool.bigbrain.desktop";
  if (platform === "darwin") return join(home, "Library", "Logs", id, "BigBrain.log");
  return join(home, ".local", "share", id, "logs", "BigBrain.log");
}

export interface LogTail {
  /** `tend`, `api`, … — the file's stem; `shell` for the app's own log. */
  name: string;
  path: string;
  /** The last `shown` lines; empty with `missing` when the file is not there. */
  lines: string[];
  /** Lines in the whole file, when it was small enough to count. */
  total: number | null;
  bytes: number;
  modified: string | null;
  missing: boolean;
}

/** The last `n` lines of a file, reading no more than `maxBytes` off its
 * end — an api log on a busy vault runs to hundreds of MB, and the whole
 * point is to answer in a screen's time. */
export function tailFile(path: string, name: string, n = 200, maxBytes = 256 * 1024): LogTail {
  let st;
  try {
    st = statSync(path);
  } catch {
    return { name, path, lines: [], total: null, bytes: 0, modified: null, missing: true };
  }
  const start = Math.max(0, st.size - maxBytes);
  const buf = Buffer.alloc(st.size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  let text = buf.toString("utf8");
  if (start > 0) text = text.slice(text.indexOf("\n") + 1); // drop the torn first line
  const all = text.split("\n");
  if (all.at(-1) === "") all.pop();
  return {
    name,
    path,
    lines: all.slice(-n),
    total: start === 0 ? all.length : null,
    bytes: st.size,
    modified: st.mtime.toISOString(),
    missing: false,
  };
}

/** The first `cmd` on a PATH string, the way a child's spawn resolves it. */
export function findOnPath(cmd: string, path: string): string | null {
  for (const dir of path.split(":")) {
    if (!dir) continue;
    const p = join(dir, cmd);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

export interface DiagnosticsFacts {
  at: string;
  engine: string;
  bundle: string | null;
  supervisor: number | null;
  supervisorAlive: boolean;
  vault: string;
  platform: string;
  bun: string;
  jobsPath: string;
  /** `loggedIn` is Claude Code's own word (`claude auth status`), `account`
   * the email it names — the check the gardener's `claude -p` lives on
   * under `auth: max`. */
  claude: { path: string | null; loggedIn: boolean; account: string | null };
  /** vault.yaml's `auth`, and — under `api` — whether the key is where the
   * gardener will look. `mode` null when vault.yaml itself did not load.
   * A tester's rounds failed for a day on `auth: api` with no key, and
   * nothing on screen said so (2026-09-02). */
  curationAgent?: "claude" | "codex" | "pi";
  curationProvider?: string;
  connection?: {provider: string; connected: boolean};
  chatgpt?: { connected: boolean; runtime: boolean };
  auth: { mode: Auth | null; keyPresent: boolean };
  /** The memory pass's standing: when it last folded, when it may next,
   * and the newest journaled run when that run FAILED. A failed run takes
   * the interval's slot silently (lib/memoryRun.ts, 2026-09-03) — this is
   * where it shows. All null on a vault not yet on the clock (the first
   * run is `bigbrain tend --force`). */
  memory: MemoryStanding;
  /** Each scheduled job's next fire, epoch ms — null when no live supervisor
   * keeps the clock (lib/supervisorClock.ts). */
  nextFires: Record<string, number> | null;
  intake: { running: boolean; lockPid: number | null };
}

export interface DiagnosticsReport {
  facts: DiagnosticsFacts;
  logs: LogTail[];
}

export interface MemoryStanding {
  rebuildRecommended?: { current: number; target: number };
  lastRunAt: string | null;
  nextRunAt: string | null;
  failed: { run: string; at: string | null; error: string } | null;
}

/** The stamp's clock plus the newest journal record when it carries an
 * error — the same reader the next run is briefed by. The error is one
 * line, clipped: a `claude -p failed` message quotes stderr whole. */
export function memoryStanding(root: string): MemoryStanding {
  const stamp = readMemoryStamp(root);
  const f = previousRunFailure(root);
  return {
    ...(memoryNeedsRebuild(root, stamp)
      ? { rebuildRecommended: { current: stamp.protocolVersion ?? 0, target: MEMORY_PROTOCOL_VERSION } }
      : {}),
    lastRunAt: stamp.lastRunAt ?? null,
    nextRunAt: stamp.nextRunAt ?? null,
    failed: f ? { ...f, error: clip(f.error.replace(/\s+/g, " ").trim(), 300, " …") } : null,
  };
}

function nextFires(root: string): Record<string, number> | null {
  try {
    const stamp = JSON.parse(readFileSync(nextFireFile(root), "utf8")) as { pid?: unknown; jobs?: Record<string, number> };
    if (typeof stamp.pid !== "number" || !alive(stamp.pid)) return null;
    return stamp.jobs ?? null;
  } catch {
    return null;
  }
}

/** The lock says whether a round runs; its holder's record, only who. */
function intakeLock(root: string): { running: boolean; lockPid: number | null } {
  const running = intakeRunning(root);
  return { running, lockPid: running ? intakeHolder(root) : null };
}

/** The job logs, tend first (the one every stalled-intake question comes
 * down to), then the two long-lived services, then the rest by name, then
 * the shell's own. */
export function logOrder(names: readonly string[]): string[] {
  const lead = ["tend", "api", "web"];
  const rest = names.filter((n) => !lead.includes(n)).sort();
  return [...lead.filter((n) => names.includes(n)), ...rest];
}

export function diagnosticsReport(root: string, opts: { lines?: number; shellLog?: string } = {}): DiagnosticsReport {
  const id = engineIdentity();
  const path = jobsPath();
  const dir = logsDir(root);
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".log")).map((f) => f.slice(0, -4));
  } catch {
    /* no logs yet */
  }
  const n = opts.lines ?? 200;
  const logs = logOrder(names).map((name) => tailFile(join(dir, `${name}.log`), name, n));
  logs.push(tailFile(opts.shellLog ?? shellLogPath(), "shell", n));
  let mode: Auth | null = null;
  let curationAgent: "claude" | "codex" | "pi" = "pi";
  let curationProvider: string | undefined;
  try {
    const manifest = loadManifest(root);
    curationProvider = manifest.gardener.provider;
    mode = manifest.auth;
    curationAgent = manifest.gardener.adapter as "claude" | "codex" | "pi";
  } catch {
    /* a vault.yaml that does not load is its own diagnosis — the tend log says so */
  }
  return {
    facts: {
      at: new Date().toISOString(),
      engine: id.engine,
      bundle: id.bundle,
      supervisor: id.supervisor,
      supervisorAlive: id.supervisor !== null && alive(id.supervisor),
      vault: root,
      platform: `${process.platform} ${process.arch}`,
      bun: typeof Bun !== "undefined" ? Bun.version : process.version,
      jobsPath: path,
      claude: { path: null, loggedIn: false, account: null },
      connection: {provider:curationProvider ?? "unknown",connected:curationProvider === "anthropic" ? subscriptionConnected(root,"anthropic") : curationProvider === "openai-codex" ? subscriptionConnected(root,"chatgpt") : curationProvider === "openai" && !!readEnvValues(root).OPENAI_API_KEY},
      curationAgent, curationProvider,
      ...(curationAgent === "pi" && curationProvider === "openai-codex" && subscriptionConnected(root, "chatgpt") ? { chatgpt: { connected: true, runtime: true } } : {}),
      auth: { mode, keyPresent: apiKeyPresent(root) },
      memory: memoryStanding(root),
      nextFires: nextFires(root),
      intake: intakeLock(root),
    },
    logs,
  };
}

const fmtIn = (ms: number): string => {
  const m = Math.round(ms / 60_000);
  return m <= 0 ? "now" : m < 90 ? `in ${m}m` : `in ${Math.floor(m / 60)}h ${m % 60}m`;
};
const fmtAgo = (ms: number): string => {
  const m = Math.round(ms / 60_000);
  if (m <= 0) return "just now";
  if (m < 90) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ago`;
};

/** One line: last fold, next sweep, and the last attempt when it failed —
 * against the report's own clock (`at`). Shared with the viewer's row in
 * spirit; the text is the bundle's. */
export function memoryLine(m: MemoryStanding, at: number): string {
  if (!m.lastRunAt && !m.nextRunAt && !m.failed && !m.rebuildRecommended) return "never run — the first run is `bigbrain tend --force`";
  const parts = [
    m.lastRunAt ? `last folded ${fmtAgo(at - Date.parse(m.lastRunAt))}` : "never folded",
    m.nextRunAt ? `next ${fmtIn(Date.parse(m.nextRunAt) - at)}` : "not on the clock",
  ];
  if (m.rebuildRecommended)
    parts.push("memory update available — rebuild with `bigbrain memory --from-scratch` (previous memory is backed up)");
  if (m.failed)
    parts.push(
      `last attempt FAILED${m.failed.at ? ` ${fmtAgo(at - Date.parse(m.failed.at))}` : ""} (run ${m.failed.run}): ${m.failed.error}`
    );
  return parts.join(" · ");
}

/** The whole report as one block of text — what COPY DEBUG BUNDLE puts on
 * the clipboard. `app` is the shell's version, which only the viewer knows. */
export function renderBundle(r: DiagnosticsReport, app: string | null): string {
  const f = r.facts;
  const at = Date.parse(f.at);
  const fires = f.nextFires
    ? Object.entries(f.nextFires).map(([job, t]) => `${job} ${fmtIn(t - at)}`).join(" · ") || "(none scheduled)"
    : "(no live supervisor keeps the clock)";
  const head = [
    `BigBrain diagnostics — ${f.at}`,
    `app         ${app ?? "(not the desktop app)"}`,
    `engine      ${f.engine}${f.bundle ? ` (${f.bundle.replace(/\n/g, ", ")})` : " (checkout)"}`,
    `vault       ${f.vault}`,
    `supervisor  ${f.supervisor === null ? "none" : `pid ${f.supervisor} (${f.supervisorAlive ? "alive" : "GONE"})`}`,
    `platform    ${f.platform} · bun ${f.bun}`,
    `model       ${f.connection?.provider ?? "unknown"} · Pi · ${f.connection?.connected ? "connected" : "check Models settings"}`,
    `memory      ${memoryLine(f.memory, at)}`,
    `jobs PATH   ${f.jobsPath}`,
    `next fires  ${fires}`,
    `intake      ${f.intake.running ? `RUNNING (lock pid ${f.intake.lockPid ?? "unknown"})` : "idle"}`,
  ];
  const logs = r.logs.map((l) => {
    const title = l.missing
      ? `── ${l.name}: ${l.path} (missing) ──`
      : `── ${l.name}: ${l.path} (last ${l.lines.length}${l.total !== null ? ` of ${l.total}` : ""} lines, ${Math.round(l.bytes / 1024)}KB, modified ${l.modified}) ──`;
    return [title, ...l.lines].join("\n");
  });
  return [...head, "", ...logs].join("\n") + "\n";
}

export function osOpen(target: string, platform: string = process.platform): boolean {
  return handOff(platform === "darwin" ? "open" : "xdg-open", [target]);
}

/** Show a file without opening it: selected in Finder; elsewhere, its folder. */
export function osReveal(target: string, platform: string = process.platform): boolean {
  return platform === "darwin" ? handOff("open", ["-R", target]) : handOff("xdg-open", [dirname(target)]);
}

function handOff(cmd: string, args: string[]): boolean {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", env: handoffProcessEnv() });
    child.once("error", () => { /* not installed — the path is on screen */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** `reveal` shows the logs folder — the OS's file browser in the app; a
 * test passes its own so no Finder window opens (see themesRoutes). */
async function probeCuration(root: string): Promise<Check> {
  const manifest = loadManifest(root);
  const role = manifest.gardener;
  const label = providerLabel(role.adapter === "pi" ? role.provider! : role.adapter);
  try {
    const { runAgent } = await import("./run/agent");
    const r = await runAgent({ root, role: "probe", auth: manifest.auth,
      target: role,
      capabilities: "none", prompt: "Reply with exactly: OK", output: { requireText: true }, timeoutMs: 120_000 });
    return { name: "model-probe", ok: /\bOK\b/i.test(r.text), level: "fail", detail: r.execution ? `${providerLabel(r.execution.provider)} · ${r.execution.choice.model} · ${r.execution.transport}: model check completed` : `${label} model check completed` };
  } catch (e) {
    return { name: "model-probe", ok: false, level: "fail", detail: e instanceof Error ? e.message : String(e), fix: `Check ${label} sign-in and the selected model in Models settings` };
  }
}
export function diagnosticsRoutes(root: string, reveal: (dir: string) => boolean = osOpen): Route[] {
  return [
    { method: "GET", path: "/api/diagnostics", handler: ({ res }) => json(res, 200, diagnosticsReport(root)) },
    {
      method: "GET",
      path: "/api/diagnostics.txt",
      handler: ({ res, url }) => send(res, 200, renderBundle(diagnosticsReport(root), url.searchParams.get("app")), "text/plain; charset=utf-8"),
    },
    { method: "POST", path: "/api/diagnostics/probe", handler: async ({ res }) => json(res, 200, await probeCuration(root)) },
    {
      method: "POST",
      path: "/api/diagnostics/reveal",
      handler: ({ res }) => {
        const dir = logsDir(root);
        json(res, 200, { ok: existsSync(dir) && reveal(dir), path: dir });
      },
    },
  ];
}
