/** backtest.ts — run a chain over a vault's past as if it were live (#51).
 *
 * A backtest replays a SOURCE vault's arrivals, in arrival order, into a
 * SANDBOX vault and advances a simulated clock, running the chain at each
 * step. Two properties hold by construction:
 *
 * - No peeking ahead. At simulated time t the sandbox holds only arrivals
 *   from before t, so nothing the chain or its agent reads can be from the
 *   future.
 * - A clean room. The sandbox holds the source's insertions and the chain's
 *   own logs, nothing else: no classic assertions, memory or graph.
 *
 * The source vault is only ever READ, through its log readers (never the
 * projection, whose sync writes `.state/`). The sandbox is its own git
 * repository, because event logs commit with git from wherever they live.
 *
 * v1 runs the goal chain with its source stage RECORDED: the goal events the
 * live chain already wrote are replayed as their arrivals land, so only the
 * picture stage runs. Those events were extracted against the LIVE pictures,
 * not the backtest's — a confound worth naming when reading the results.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { stringify } from "yaml";
import { dueGoalSources, goalChain, latestPicture, pictureRecords, pictureWindow, runGoals, type GoalWindowResult } from "./goalChain";
import { appendGoalEvent, createGoalEvent, readGoalLog, type GoalEvent } from "./goalLog";
import { appendSourceInsertionEvent, readSourceInsertionLog, type SourceInsertion } from "./insertionLog";
import { loadManifest } from "./manifest";
import type { ModelRunRequest } from "./run/request";
import { runAgent } from "./run/agent";

type Runner = typeof runAgent;

export interface GoalBacktestOpts {
  /** The vault whose record is replayed. Read-only. */
  source: string;
  /** The backtest's directory; the sandbox vault is `<out>/vault`. */
  out: string;
  /** Replay windows that end on or before this date (YYYY-MM-DD). */
  through: string;
  pictureMode?: "single" | "agent";
  /** The model runner (tests script it). */
  runner?: Runner;
  onWindow?: (lines: string[]) => void;
}

export interface GoalBacktestResult {
  sandbox: string;
  windows: GoalWindowResult[];
  /** Arrivals the live chain never gardened because a later revision
   * superseded them first; marked in the sandbox, never in the source. */
  superseded: number;
  /** Why the replay stopped before `through`, if it did. */
  stopped?: string;
}

const at = (s: SourceInsertion): string => s.received_at ?? s.occurred_at ?? "";

const inside = (dir: string, root: string): boolean => {
  const rel = relative(resolve(root), resolve(dir));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
};

/** The sandbox's vault.yaml: the source's goal chain configuration and auth,
 * nothing else — no integrations, no firewall, no classic models. */
function sandboxManifest(source: string, pictureMode?: "single" | "agent"): string {
  const m = loadManifest(source);
  const cfg = m.chains.goals;
  if (!cfg) throw new Error(`backtest: ${source} has no chains.goals to replay`);
  const stage = (c: { adapter: string; provider: string; model: string; reasoning?: string }) =>
    ({ adapter: c.adapter, provider: c.provider, model: c.model, ...(c.reasoning ? { reasoning: c.reasoning } : {}) });
  return stringify({
    auth: m.auth,
    assertions: { native: true },
    chains: {
      goals: {
        goals: cfg.goals, since: cfg.since, concurrency: cfg.concurrency, batch: cfg.batch,
        source: stage(cfg.source),
        picture: { ...stage(cfg.picture), interval: cfg.interval, mode: pictureMode ?? cfg.pictureMode },
      },
    },
  });
}

function gitInit(dir: string): void {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.name", "bigbrain backtest");
  git("config", "user.email", "backtest@localhost");
}

/** In recorded mode the source stage never calls a model: every arrival's
 * goal event is replayed. A source call reaching the runner is a bug. */
const recordedOnly = (runner: Runner): Runner => async (req: ModelRunRequest, loadPi) => {
  if (req.output?.schema) throw new Error("backtest: recorded mode makes no source calls");
  return runner(req, loadPi);
};

export async function backtestGoals(opts: GoalBacktestOpts): Promise<GoalBacktestResult> {
  const source = resolve(opts.source);
  const sandbox = join(resolve(opts.out), "vault");
  if (inside(opts.out, source)) throw new Error("backtest: --out must not be inside the source vault");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.through)) throw new Error("backtest: --through must be YYYY-MM-DD");
  if (!existsSync(join(sandbox, "vault.yaml"))) {
    mkdirSync(sandbox, { recursive: true });
    writeFileSync(join(sandbox, "vault.yaml"), sandboxManifest(source, opts.pictureMode));
    gitInit(sandbox);
  }
  const through = new Date(`${opts.through}T23:59:59.999Z`).toISOString();
  const arrivals = readSourceInsertionLog(source).sort((a, b) => at(a).localeCompare(at(b)) || a.id.localeCompare(b.id));
  const recorded = new Map<string, GoalEvent>(readGoalLog(source).map((e) => [e.insertion_id, e]));
  // An arrival a later revision superseded may never have been gardened
  // live: the chain only reads the live version, and the revision existed by
  // the time it ran. Replaying it as due would ask for a model call the live
  // record never made.
  const revised = new Set(arrivals.flatMap((s) => {
    const sup = s.envelope?.["supersedes"];
    return typeof sup === "string" ? [sup] : Array.isArray(sup) ? sup.filter((x): x is string => typeof x === "string") : [];
  }));
  let superseded = 0;
  const runner = recordedOnly(opts.runner ?? runAgent);
  const windows: GoalWindowResult[] = [];
  let landed = 0;
  for (;;) {
    const manifest = loadManifest(sandbox);
    const cfg = manifest.chains.goals!;
    const { end } = pictureWindow(cfg, latestPicture(sandbox));
    if (end > through) return { sandbox, windows, superseded };
    // Land everything that had arrived by the window's end — identity
    // declarations included, which the owner's labels are read from — and
    // replay the goal event the live chain wrote for each.
    for (; landed < arrivals.length && at(arrivals[landed]!) < end; landed++) {
      const arrival = arrivals[landed]!;
      appendSourceInsertionEvent(sandbox, arrival, { wake: false });
      const event = recorded.get(arrival.id);
      if (event) appendGoalEvent(sandbox, event);
    }
    const now = new Date(end);
    const arrived = new Map(arrivals.slice(0, landed).map((s) => [s.id, s]));
    for (const id of dueGoalSources(sandbox, cfg, now).filter((i) => revised.has(i))) {
      const s = arrived.get(id)!;
      appendGoalEvent(sandbox, createGoalEvent({
        insertion_id: id, source_id: s.source_id, assertions: [],
        author: { kind: "model", id: "backtest", invocation_id: "recorded" },
        created_at: now.toISOString(),
        produced_by: { procedure: "backtest/superseded-unrecorded", version: "v1" },
      }));
      superseded++;
    }
    const unrecorded = dueGoalSources(sandbox, cfg, now);
    if (unrecorded.length)
      return { sandbox, windows, superseded, stopped: `${unrecorded.length} arrival(s) before ${end.slice(0, 10)} have no recorded goal event (e.g. ${unrecorded[0]})` };
    const before = pictureRecords(sandbox).length;
    const result = await runGoals({ root: sandbox, manifest, runner, now: () => now });
    windows.push(...result.windows);
    opts.onWindow?.(goalChain.report(result).lines);
    if (pictureRecords(sandbox).length === before)
      return { sandbox, windows, superseded, stopped: `no picture closed the window ending ${end.slice(0, 10)}` };
    if (result.windows.some((w) => w.picture?.error)) return { sandbox, windows, superseded, stopped: "a picture build failed" };
  }
}
