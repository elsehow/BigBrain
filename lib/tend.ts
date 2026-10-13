/** The classic chain (#51): intake, then the memory pass, then the feed
 * (lib/stages/intake.ts, lib/stages/memory.ts, lib/stages/feed.ts), one after the
 * other under the gardener's lock, each handed the model runner. */
import type { PiSDK } from "./run/piSession";
type PiLoader = () => Promise<PiSDK>;
import { basename, join } from "node:path";
import { acquireAssertionLock } from "./assertionAgent";
import type { Chain } from "./chain";
import { ENGINE_ROOT } from "./engine";
import { loadManifest, type Manifest } from "./manifest";
import { memoryDue, readMemoryStamp, writeMemoryStamp } from "./memory";
import { feedDue, runFeed, type FeedRunResult } from "./stages/feed";
import { runMemory, type MemoryRunOpts, type MemoryRunResult } from "./stages/memory";
import { stagedIds } from "./stage";
import { creditsPaused } from "./providerCredits";
import { runJournalFiles, TEND_JOURNAL_DIR } from "./runJournal";
import { dueIntake, intakeStage, type TendRound } from "./stages/intake";
import { modelRunner } from "./stages/runner";

export { TEND_JOURNAL_DIR, type TendRound };

/** Every tend journal file, newest first across the month shards
 * (`journal/tend/<YYYY-MM>/<id>.json`) — the reader beside the writer
 * above. door.json and anything else flat beside the shards is not a run
 * and is skipped. The one walk (#642) for the readers that used to each
 * re-implement it (/v1/status.last_run, the queue feed's executions). */
export function tendJournalFiles(root: string): { runId: string; path: string }[] {
  return runJournalFiles(root, TEND_JOURNAL_DIR).reverse().map((rel) => ({ runId: basename(rel, ".json"), path: join(root, rel) }));
}

/** The tick's cheap gate: is there anything to do at all? */
export interface TendDue {
  intake: number;
  /** Staged arrivals waiting for an admit or a pass (#744) — due work the
   * same as intake: a round runs for them alone. */
  staged: number;
  memory: boolean;
}

export function tendDue(root: string): TendDue {
  return {
    intake: dueIntake(root).length,
    staged: stagedIds(root).length,
    memory: memoryDue(root).due,
  };
}

/** The tick's one question, answered in one place: is any of it due? The
 * CLI used to spell this as `intake || memory` and left staged mail
 * waiting until something else arrived (0.1.40, caught the same evening). */
export function tendHasWork(due: TendDue): boolean {
  return due.intake > 0 || due.staged > 0 || due.memory;
}

export interface TendResult {
  ran: boolean;
  reason?: string;
  /** A run-stopping fault (distinct from `reason`, which is a normal skip). */
  error?: string;
  rounds: TendRound[];
  memory?: MemoryRunResult;
  feed?: FeedRunResult;
}

export interface TendOpts {
  root: string;
  manifest: Manifest;
  /** Memory force-through (first-ever memory run is deliberate). */
  force?: boolean;
  /** SDK loader — tests replace transport, keeping the production session path. */
  loadPi?: PiLoader;
  /** memory-pass seam — tests stub the whole pass. */
  memoryRunner?: (opts: MemoryRunOpts) => Promise<MemoryRunResult>;
  /** feed-stage seam — tests stub the whole stage. */
  feedRunner?: typeof runFeed;
  maxRounds?: number;
  now?: () => Date;
}

/**
 * One tend run: single-flight via the intake lock (the #479 revision:
 * the LOCK is the concurrency story, `next` is a pure read), bounded intake
 * rounds, then the memory pass when due. Partial progress is durable —
 * every submitted event landed the moment the model called submit; a killed
 * run loses at most one un-submitted batch.
 */
export async function runTend(opts: TendOpts): Promise<TendResult> {
  const { root, manifest } = opts;
  const loadPi = opts.loadPi;
  const now = opts.now ?? (() => new Date());
  // Out of usage credits (lib/providerCredits.ts): hold off rather than pay
  // for a failed round every tick; arrivals wait in the stage. One probe
  // every half hour, or Retry in the app, tries again.
  if (creditsPaused(root, manifest.gardener.provider, now().getTime()))
    return { ran: false, reason: `paused: out of usage credits with ${manifest.gardener.provider}`, rounds: [] };
  const lock = acquireAssertionLock(root);
  if (!lock) return { ran: false, reason: "another gardener holds the lock", rounds: [] };
  try {
    // Preflight the MCP server's own dependency: a `git pull` without
    // `bun install` leaves the Claude SDK tool adapter unbootable, and the session then
    // runs TOOLLESS — a paid round that can settle nothing (observed on
    // the 2026-08-23 parity run). Fail loudly instead.
    try {
      await import("@modelcontextprotocol/sdk/server/index.js");
    } catch {
      return {
        ran: false, rounds: [],
        error: `engine dependencies missing — run \`bun install\` in ${ENGINE_ROOT} (the MCP server cannot boot)`,
      };
    }
    // one runner, handed to each stage in turn
    const model = modelRunner(loadPi);
    const intake = intakeStage({ root, manifest, maxRounds: opts.maxRounds, now });
    await intake.run({ model, write: { append() { /* the gardener's tools write */ } } }, []);
    const rounds = intake.rounds;
    // Memory AFTER intake, so a sweep folds the assertions this run just
    // landed. runMemory declines on its own (lock, due-check) — the pre-check
    // only saves loading the pass when nothing could run.
    let memory: MemoryRunResult | undefined;
    // Connections from the transitional ChatGPT flow may predate first-sweep
    // scheduling. Once intake has been filed, initialize it exactly once.
    if (manifest.memory.adapter === "pi" && rounds.some(r => r.settled > 0)) {
      const stamp = readMemoryStamp(root);
      if (!stamp.nextRunAt && !stamp.lastRunAt) writeMemoryStamp(root, { ...stamp, nextRunAt: new Date().toISOString() });
    }
    const due = memoryDue(root, { force: opts.force ?? false });
    if (due.due) {
      const runner = opts.memoryRunner ?? runMemory;
      memory = await runner({
        root, manifest,
        ...(opts.force ? { force: true } : {}),
        ...(opts.loadPi ? { loadPi: opts.loadPi } : {}),
        model,
      });
    }
    // Feed AFTER memory, so it sorts what this run filed against the working
    // set this run kept. Off unless vault.yaml has a feed: block.
    let feed: FeedRunResult | undefined;
    if (feedDue(root, manifest.feed, { now: now() }).due)
      feed = await (opts.feedRunner ?? runFeed)({ root, manifest, now, runner: model });
    return { ran: true, rounds, ...(memory ? { memory } : {}), ...(feed ? { feed } : {}) };
  } finally {
    lock.release();
  }
}

/** The classic chain (#51): agentic intake rounds over the entity-linked
 * assertion log, then the memory pass, then (when configured) the feed
 * stage. Its source work is due intake plus staged arrivals, which this
 * chain admits or passes. */
export const classicChain: Chain<TendResult> = {
  name: "classic",
  job: "tend",
  due(root: string, opts: { now?: Date } = {}) {
    return {
      source: dueIntake(root).length + stagedIds(root).length,
      scheduled: { memory: memoryDue(root, opts), feed: feedDue(root, loadManifest(root).feed, opts) },
    };
  },
  run: runTend,
  report(result: TendResult) {
    if (result.error) return { lines: [], failed: true, error: `tend: ${result.error}` };
    if (!result.ran) return { lines: [`tend: ${result.reason}`], failed: false };
    const lines = result.rounds.map((r) =>
      `tend: round ${r.runId} — ${r.settled} settled, ${r.remaining} remaining` +
        (r.usage ? ` ($${(r.usage.cost_usd?.toFixed(4) ?? "unavailable")}, ${r.usage.turns} turns)` : "") +
        (r.error ? ` — ERROR: ${r.error}` : ""));
    if (result.memory)
      lines.push(`tend: memory — ${result.memory.ran ? "ran" : "declined"}${result.memory.error ? ` — ERROR: ${result.memory.error}` : ""}`);
    if (result.feed) {
      const f = result.feed;
      const sorted = f.calls.reduce((n, c) => n + c.sources, 0);
      const error = f.calls.find((c) => c.error)?.error;
      lines.push(`tend: feed — ${f.ran ? `${sorted} source(s) sorted in ${f.calls.length} call(s)` : f.reason}${error ? ` — ERROR: ${error}` : ""}`);
    }
    if (!result.rounds.length && !result.memory && !result.feed) lines.push("tend: nothing due");
    return {
      lines,
      failed: result.rounds.some((r) => r.error) || Boolean(result.memory?.error) || Boolean(result.feed?.calls.some((c) => c.error)),
    };
  },
};
