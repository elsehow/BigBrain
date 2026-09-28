#!/usr/bin/env bun
import { allowVaultRequest } from "../lib/vaultBoundary";
/**
 * desktop.ts — the engine under the desktop app (#573, #574). ONE process
 * that runs the whole engine: the api and the viewer as long-lived
 * children, tend / publish / each enabled integration on its interval —
 * and stops all of it when stopped. Since #645 it is the only supervisor
 * there is; the launchd/systemd install it was modelled on is gone.
 *
 * It is a supervisor, not a rewrite: every job is the same script a person
 * runs by hand (`process.execPath <ENGINE_ROOT>/bin/x.ts`), with
 * the same env (`BIGBRAIN_VAULT`, the jobs' PATH) and the same log file under
 * `<vault>/.state/logs/`. The intervals come from `CADENCE`
 * (lib/desktopSchedule.ts) — one table, no longer regex-read out of the
 * launchd templates.
 *
 * The clock is lib/desktopSchedule.ts: one heartbeat a second, per-job
 * "next fire" stamps. A machine that slept gets one catch-up fire per
 * overdue job on the first beat after waking, like launchd. `tendDue`
 * inside the tend tick remains the only judge of whether there is work.
 *
 * The clock is also the one thing children need to reach, in both
 * directions (lib/supervisorClock.ts): a landing asks for the work it just
 * created — moving tend's clock forward, never spawning anything, so the
 * plan stays the one switch — and the beat publishes each job's next fire so
 * the queue view can name it instead of guessing.
 *
 * FIRST RUN (#575): with no vault — nothing at BIGBRAIN_VAULT, no pointer —
 * the supervisor does not die at import the way every other entry point
 * does. It opens the DOOR instead: a small server on the web port that
 * serves the viewer and `/api/setup`, so the app opens on a machine that
 * has nothing yet and asks its one question. The door's POST creates the
 * vault (lib/firstRun.ts), then the door closes and the engine comes up on
 * the same port. A switch from settings later is the same handover in
 * reverse: web/server.ts moves the pointer and sends SIGUSR2, and the
 * engine comes back up on the new vault. That is why the vault-bound
 * modules (manifest, remote) are imported lazily, per run — at import time
 * there may be no vault to bind to.
 *
 * Lifetime (#597): the Tauri shell spawns this as its one child, in its
 * own process group, and on quit SIGTERMs THE GROUP — this process and
 * every child it started — then SIGKILLs whatever is left; one signal,
 * asking nothing of a process that may no longer be able to run code. Two
 * belts under that, for a shell that dies without quitting: it holds the
 * other end of our stdin, so EOF there says it is gone; and we poll its
 * pid every beat (lib/parentWatch.ts), for the case where stdin is not
 * enough. Either way `stop()` takes the children down. And a child of ours
 * polls OUR pid the same way, so an api or viewer never outlives a
 * supervisor that was SIGKILLed — the shape that once left a viewer
 * serving a vault nothing was tending for 45 minutes. No model call
 * happens here — tend uses the same Pi session contract as the scheduled tick
 * does.
 *
 *   bun bin/desktop.ts [--dry-run]     env: BIGBRAIN_VAULT, BIGBRAIN_WEB_PORT (4747),
 *                                      BIGBRAIN_API_PORT (4748), BIGBRAIN_DEV (services
 *                                      under `bun --watch`)
 */

import { apiPort as envApiPort, isDesktop, isDev, webPort as envWebPort } from "../lib/env";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, openSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { cadence, Scheduler, durationLabel, wokeAfter } from "../lib/desktopSchedule";
import { discoverVaultRoot, ENGINE_ROOT, engineIdentity, vaultPointer } from "../lib/engine";
import { setupRoutes, setupState } from "../lib/firstRun";
import { feedbackRoutes } from "../lib/feedback";
import { allowLoopbackRequest, armor, dispatch, json, type Route } from "../lib/httpx";
import { ensureDir } from "../lib/fsx";
import { watchPid } from "../lib/parentWatch";
import { retireHostPluginDir } from "../lib/legacy";
import { jobsPath } from "../lib/preflight";
import { serveStatic } from "../lib/staticServe";
import { clearNextFires, takeWake, writeNextFires } from "../lib/supervisorClock";

interface Job {
  name: string;
  script: string; // relative to ENGINE_ROOT
  /** Seconds between ticks; `null` = long-lived (restart if it exits). */
  interval: number | null;
  /** Run once at start, rather than one interval in. */
  atStart: boolean;
  env?: Record<string, string>;
}

const dryRun = process.argv.includes("--dry-run");
const webPort = String(envWebPort());
const apiPort = String(envApiPort());
const BEAT_MS = 1000;
const UI_DIST = join(ENGINE_ROOT, "web", "ui", "dist");
// Every child inherits this (childEnv spreads process.env) and watches the
// pid it names (lib/parentWatch.ts); the door's `/api/engine` reports it,
// so the shell can tell a live supervisor's engine from an orphan's.
process.env["BIGBRAIN_SUPERVISOR_PID"] = String(process.pid);

const stamp = (): string => new Date().toISOString().slice(11, 19);
const say = (msg: string): void => console.log(`desktop ${stamp()}: ${msg}`);

/** A root the engine can run: it exists and carries vault.yaml. The
 * discovery result alone is not that — the shell passes its ~/vault default
 * whether or not anything is there. */
const isVault = (root: string | null): root is string => !!root && existsSync(join(root, "vault.yaml"));

/** The pointer's target — read directly, because after a switch the env
 * still names the vault this process was started on. */
function pointedVault(): string | null {
  try {
    const p = readFileSync(vaultPointer(), "utf8").trim();
    return p && isAbsolute(p) ? p : null;
  } catch {
    return null;
  }
}

// ── the door: no vault yet ───────────────────────────────────────────────────

/** Serve the viewer and /api/setup on the web port until a vault exists;
 * resolve with its root once one does. The viewer itself decides to show
 * first run (it sees `vault: null`); every other route it tries answers
 * 404 and its views show their own empty states.
 *
 * The four setup routes are lib/firstRun.ts's, the same ones web/server.ts
 * mounts once a vault exists — this door and that viewer had each written
 * them out, and their answers had drifted (#639). What is left here is
 * what only a door can say: no vault, so no connect; the viewer; and who
 * this engine is. */
function door(suggested: string, problem?: { path: string; problem: string }): Promise<string> {
  return new Promise((resolveVault) => {
    // A verdict carried over from a run that failed (below): shown once,
    // under the rows, until the next choice replaces it.
    let pick = problem;
    const routes: Route[] = [
      {
        method: "GET",
        path: "/",
        handler: ({ res }) => {
          if (serveStatic(res, join(UI_DIST, "index.html"))) return;
          json(res, 503, { error: "the viewer is not built (bun run web:build)" });
        },
      },
      {
        method: "GET",
        path: "/assets/*",
        handler: ({ res, url }) => {
          if (url.pathname.includes("..")) return json(res, 404, { error: "no such asset" });
          if (serveStatic(res, join(UI_DIST, url.pathname.slice(1)))) return;
          json(res, 404, { error: "no such asset" });
        },
      },
      { method: "GET", path: "/api/engine", handler: ({ res }) => json(res, 200, engineIdentity()) },
      ...feedbackRoutes(),
      ...setupRoutes({
        root: null,
        state: () => setupState(null, { suggested, pick }),
        onChoice: () => {
          pick = undefined;
        },
        onVault: (v) => {
          say(`vault ${v.kind === "vault" ? "adopted" : "created"} at ${v.path} — closing the door`);
          server.close();
          server.closeAllConnections?.();
          resolveVault(v.path);
        },
      }),
    ];
    const server = createServer((req, res) => {
      armor(res);
      if (!allowLoopbackRequest(req, res)) return;
      if (!allowVaultRequest(req, res, "setup")) return;
      if (dispatch(routes, req, res)) return;
      json(res, 404, { error: "no vault yet" });
    });
    server.listen(Number(webPort), "127.0.0.1", () => say(`no vault at ${suggested} — the setup door is open on :${webPort}`));
  });
}

/**
 * Who is holding `port`, asked only when a long-lived child has just died
 * trying to bind it. `null` when nothing is (or when we cannot tell).
 *
 * REMOVE THIS once it stops earning its keep. It exists for one failure the
 * retired CLI host install used to cause (#645): launchd's `com.bigbrain.web`
 * and the app both wanting :4747, which showed up as an endless, unexplained
 * restart loop. Nothing can create those jobs any more, so the remaining
 * causes are a second copy of the app or a stray dev server — findable
 * without help. It also shells out to `lsof`, which is not everywhere and
 * which some sandboxed or hardened environments will prompt about; that is
 * another reason not to keep it around longer than the confusion it solves.
 */
function portHeldBy(port: string, ours: ReadonlySet<number>): string | null {
  const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "pc"], {
    encoding: "utf8",
    timeout: 3_000,
  });
  if (r.status !== 0 || !r.stdout) return null;
  let pid = 0;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1)) || 0;
    else if (line.startsWith("c") && pid && !ours.has(pid)) return `pid ${pid} (${line.slice(1)})`;
  }
  return null;
}

// ── a run: the engine on one vault ───────────────────────────────────────────

interface Run {
  /** Stop every child; resolves when they are gone (or killed). */
  stop(why: string): Promise<void>;
}

async function run(root: string): Promise<Run> {
  process.env["BIGBRAIN_VAULT"] = root;
  // Lazy on purpose (see the header): these bind VAULT_ROOT at import.
  const { loadManifest } = await import("../lib/manifest");

  const { integrationActive, MANAGED_INTEGRATIONS } = await import("../lib/integrationAccess");
  function plan(): Job[] {
    const manifest = loadManifest(root);
    const jobs: Job[] = [
      { name: "api", script: "bin/api.ts", interval: null, atStart: true, env: { PORT: apiPort } },
      { name: "web", script: "web/server.ts", interval: null, atStart: true, env: { PORT: webPort } },
    ];
    for (const name of ["tend", "publish"])
      jobs.push({ name, script: `bin/${name}.ts`, interval: cadence(name), atStart: false });
    for (const name of new Set([...Object.keys(manifest.integrations), ...MANAGED_INTEGRATIONS])) {
      if (!integrationActive(root, name)) continue;
      const script = join("integrations", name, "run.ts");
      if (!existsSync(join(ENGINE_ROOT, script))) continue; // config-only, or retired
      jobs.push({ name, script, interval: cadence(name), atStart: false });
    }
    return jobs;
  }

  const jobs = plan();
  const byName = new Map(jobs.map((j) => [j.name, j]));

  if (dryRun) {
    console.log(`desktop: vault ${root}\ndesktop: engine ${ENGINE_ROOT}\ndesktop: bun ${process.execPath}`);
    for (const j of jobs)
      console.log(`  ${j.name.padEnd(11)} ${j.interval === null ? "always" : `every ${j.interval}s`}${j.atStart ? " (+at start)" : ""}  ${j.script}`);
    process.exit(0);
  }

  const logDir = join(root, ".state", "logs");
  ensureDir(logDir);
  const childEnv = (extra?: Record<string, string>): NodeJS.ProcessEnv => ({
    ...process.env,
    BIGBRAIN_VAULT: root,
    BIGBRAIN_DESKTOP: "1",
    HOME: homedir(),
    PATH: jobsPath(),
    ...extra,
  });

  const running = new Map<string, ChildProcess>();
  const restarts = new Map<string, number>();
  const scheduler = new Scheduler(
    jobs.flatMap((j) => (j.interval === null ? [] : [{ name: j.name, interval: j.interval, atStart: j.atStart }])),
    Date.now()
  );
  let stopping = false;

  function start(job: Job): ChildProcess {
    const fd = openSync(join(logDir, `${job.name}.log`), "a");
    const args = [join(ENGINE_ROOT, job.script)];
    // The dev loop (desktop/dev.sh): a long-lived job restarts itself when a
    // file it imports changes, so an edit to the api or the viewer's server
    // is live. Scheduled jobs start fresh every fire anyway.
    if (isDev() && job.interval === null) args.unshift("--watch", "--no-clear-screen");
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: childEnv(job.env),
      stdio: ["ignore", fd, fd],
    });
    running.set(job.name, child);
    // A spawn that fails asynchronously (the vault directory gone from
    // under a running engine, bun missing) raises `error` on the child;
    // unhandled, that is an uncaught exception that takes the supervisor
    // down and leaves every other child orphaned on its port.
    child.once("error", (e) => say(`${job.name} could not start: ${e.message}`));
    child.once("exit", (code, signal) => {
      running.delete(job.name);
      if (stopping) return;
      if (job.interval === null) {
        // A long-lived job died: back off and bring it back, like KeepAlive.
        const n = restarts.get(job.name) ?? 0;
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(5, n));
        restarts.set(job.name, n + 1);
        say(`${job.name} exited (${signal ?? code}) — restarting in ${delay / 1000}s`);
        // Once, on the first death: a job that cannot bind its port will
        // never come back, and the loop above says nothing about why.
        const port = job.env?.["PORT"];
        if (n === 0 && port) {
          const ours = new Set([process.pid, ...[...running.values()].map((c) => c.pid ?? 0)]);
          const held = portHeldBy(port, ours);
          if (held) say(`:${port} is held by ${held} — ${job.name} cannot start until that stops`);
        }
        setTimeout(() => {
          if (!stopping) start(job);
        }, delay);
      } else if (code !== 0) {
        say(`${job.name} exited ${signal ?? code} — see .state/logs/${job.name}.log`);
      }
    });
    return child;
  }

  /** The scheduled jobs, in plan order — who can be woken, and whose next
   * fire the queue view is allowed to name. */
  const scheduled = jobs.filter((j) => j.interval !== null).map((j) => j.name);

  /** Publish the clock for the other processes (lib/supervisorClock.ts).
   * Called at every point a next-fire moves: startup, a fire, a wake. */
  function publishClock(): void {
    const next: Record<string, number> = {};
    for (const name of scheduled) {
      const at = scheduler.nextAt(name);
      if (at !== undefined) next[name] = at;
    }
    writeNextFires(root, next);
  }

  /** Fire a scheduled job now and reset its clock. The scheduler already
   * refused anything still running — launchd skips overlapping StartInterval
   * fires the same way. */
  function fire(name: string, now: number): void {
    const job = byName.get(name);
    if (!job || stopping) return;
    scheduler.started(name, now);
    publishClock();
    start(job);
  }

  // The plan is read once, but vault.yaml is not written once: the settings
  // screen lists an integration in a running app (email's first inbox,
  // #749), and until it re-read the plan the new poller never fired. So a
  // stat of vault.yaml on every beat, and when its mtime moves the plan is
  // read again and any integration it gained joins the rotation, first
  // fire on the next beat. Nothing is ever removed: a disabled
  // integration's own run.ts exits at its gate (requireIntegrationEnabled).
  const manifestPath = join(root, "vault.yaml");
  const mtime = (): string => {
    let manifestTime=0, accounts='';
    try { manifestTime=statSync(manifestPath).mtimeMs; } catch { /* First-run transition. */ }
    try { accounts=readFileSync(join(root,'.spool','integration-account-revision'),'utf8'); } catch { /* No account policies yet. */ }
    return `${manifestTime}:${accounts}`;
  };
  let manifestMtime = mtime();
  function replan(now: number): void {
    const m = mtime();
    if (m === manifestMtime) return;
    manifestMtime = m;
    let fresh: Job[];
    try {
      fresh = plan();
    } catch (e) {
      say(`Integration settings changed but could not be read — plan unchanged (${e instanceof Error ? e.message : e})`);
      return;
    }
    let joined = false;
    for (const j of fresh) {
      if (j.interval === null || byName.has(j.name)) continue;
      byName.set(j.name, j);
      scheduled.push(j.name);
      scheduler.add({ name: j.name, interval: j.interval, atStart: true }, now);
      say(`${j.name} joined the plan (integration settings changed) — every ${j.interval}s, first run now`);
      joined = true;
    }
    if (joined) publishClock();
  }

  say(`vault ${root}; engine ${ENGINE_ROOT}; ${jobs.length} jobs (${jobs.map((j) => j.name).join(", ")})`);
  for (const job of jobs) if (job.interval === null) start(job);
  publishClock();

  let lastBeat = Date.now();
  const beat = setInterval(() => {
    if (stopping) return;
    const now = Date.now();
    const gap = wokeAfter(lastBeat, now, BEAT_MS);
    lastBeat = now;
    if (gap) say(`away for ${durationLabel(gap)} (sleep?) — firing what is overdue, once each`);
    // Wake requests first, so an arrival that landed since the last beat is
    // due on THIS one rather than a tick later. A few stats a second against
    // `.state/wake/` — the beat was already awake doing nothing else.
    let woke = false;
    for (const name of scheduled)
      if (takeWake(root, name)) {
        scheduler.poke(name, now);
        woke = true;
      }
    if (woke) publishClock();
    replan(now);
    for (const name of scheduler.due(now, new Set(running.keys()))) fire(name, now);
  }, BEAT_MS);

  return {
    stop(why: string): Promise<void> {
      if (stopping) return Promise.resolve();
      stopping = true;
      clearInterval(beat);
      clearNextFires(root); // no clock outlives the supervisor that kept it
      say(`stopping (${why}) — ${running.size} child${running.size === 1 ? "" : "ren"}`);
      for (const [, c] of running) c.kill("SIGTERM");
      return new Promise((resolve) => {
        const deadline = setTimeout(() => {
          for (const [, c] of running) c.kill("SIGKILL");
          resolve();
        }, 5_000);
        const poll = setInterval(() => {
          if (running.size === 0) {
            clearTimeout(deadline);
            clearInterval(poll);
            resolve();
          }
        }, 100);
      });
    },
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

let root = discoverVaultRoot();
const suggested = root ?? join(homedir(), "vault");
if (!isVault(root)) {
  if (dryRun) {
    console.log(`desktop: no vault at ${suggested} — the setup door would open on :${webPort}`);
    process.exit(0);
  }
  root = await door(suggested);
}
let current: Run | null = null;
let exiting = false;

/** Run on `root`; if the engine cannot come up there, say why and open the
 * door again with the reason under the rows — never sit with no servers and
 * no door, which reads in the window as an empty vault. */
async function serve(at: string): Promise<void> {
  for (;;) {
    try {
      root = at;
      current = await run(at);
      return;
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      say(`engine could not start on ${at}: ${why} — the setup door is open again`);
      at = await door(suggested, { path: at, problem: `${at}: ${why}` });
    }
  }
}
await serve(root);

// Retire the old hosted plugin directory without invoking a native client.
if (!isDev()) {
  const retired = retireHostPluginDir(homedir());
  if (retired.status === "moved") say(`plugin: moved the retired hosted-era copy ${retired.from} → ${retired.to}; the settings.json grants that named it now approve nothing (#693)`);
}

function shutdown(why: string): void {
  if (exiting) return;
  exiting = true;
  const r = current;
  current = null;
  void (r ? r.stop(why) : Promise.resolve()).then(() => process.exit(0));
}

/** The vault moved (web/server.ts wrote the pointer on a switch from
 * settings): bring everything down and back up on the new one. */
async function reload(): Promise<void> {
  if (exiting || !current) return;
  const next = pointedVault();
  if (!isVault(next)) return say(`reload asked, but the pointer names no vault (${next ?? "unset"}) — staying on ${root}`);
  const r = current;
  current = null;
  await r.stop(`switching to ${next}`);
  await serve(next);
}

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => shutdown(sig));
// Whatever kills this process must take the children with it: orphaned api
// and web servers hold the ports and the next launch finds "already
// answering" and attaches to a corpse.
process.on("uncaughtException", (e) => {
  console.error(`desktop: uncaught — ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  shutdown("uncaught exception");
});
process.on("SIGUSR2", () => void reload());
// The shell that spawned us is gone without a signal reaching us (it crashed,
// or was killed -9): it held the other end of our stdin, so EOF there says
// so. Take the engine down rather than outlive the app the user thinks they
// quit.
process.stdin.on("end", () => shutdown("parent exited"));
process.stdin.on("close", () => shutdown("parent exited"));
process.stdin.resume();
// And the belt under that: poll the shell's pid once a second (#597). EOF
// needs this process to still be reading; the zero signal needs only that
// the shell be gone. (`process.ppid` is the pid at start — not re-read
// under bun after a reparenting — which is exactly the one to watch.)
// Only under the app: a hand-run `bun bin/desktop.ts` belongs to its
// terminal, and a terminal's exit is SIGHUP already.
if (isDesktop() && process.ppid > 1) watchPid(process.ppid, () => shutdown("parent exited"));
