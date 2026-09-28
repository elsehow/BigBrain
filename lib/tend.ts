import { choiceJournalFields } from "./modelResolution";
/** Scheduled gardener rounds use the selected provider through the shared job contract, followed by the bounded memory pass. */
import { startGardenerProgress } from "./gardenerProgress";
import type { ToolObserver } from "./run/toolActivity";
import type { PiSDK } from "./run/piSession";
type PiLoader = () => Promise<PiSDK>;
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  acquireAssertionLock,
  ASSERTION_AGENT_TIMEOUT_MS,
  ownerLabelsFor,
  releaseAssertionLock,
} from "./assertionAgent";
import type { RunMeter } from "./meterTypes";
import { runAgent } from "./run/agent";
import { type RunUsage, type AgentRunResult } from "./run/model";
import { modelRunJournalFields, newRunId } from "./run/journal";
import { ENGINE_ROOT } from "./engine";
import { ensureDir, writeAtomic } from "./fsx";
import type { Manifest } from "./manifest";
import { memoryDue, readMemoryStamp, writeMemoryStamp } from "./memory";
import { runMemory, type MemoryRunOpts, type MemoryRunResult } from "./memoryRun";
import { render } from "./prompts";
import { stagedIds } from "./stage";
import { dueIntakeIds } from "./work";

const TEND_PROMPT_VERSION = "tend/v3";
export const TEND_JOURNAL_DIR = "journal/tend";

/** Bounded rounds per tick: each round is one provider session draining
 * available `next` batches. A backlog drains tick by tick; a stuck model that
 * settles nothing ends the run after ONE wasted round, not four. */
export const TEND_MAX_ROUNDS = 4;

/** Render the engine-owned gardener prompt. */
export function tendPrompt(ownerLabels: readonly string[]): string {
  const template = readFileSync(join(ENGINE_ROOT, "prompts", "tend.md"), "utf8");
  const owner = ownerLabels.length
    ? `The vault owner is known by these labels: ${ownerLabels.join(", ")}. Use these to identify the owner; check source authorship before attributing words to them.`
    : "No vault-owner identity labels were supplied.";
  return render(template, { OWNER: owner });
}

/** A gardener round settles work through its role-scoped session tools. */
async function gardenerCall(
  root: string,
  manifest: Manifest,
  prompt: string,
  loadPi?: PiLoader,
  onTool?: ToolObserver
): Promise<AgentRunResult> {
  return runAgent({ root, role: "tend", auth: manifest.auth, prompt,
    target: manifest.gardener,
    capabilities: "gardener", timeoutMs: ASSERTION_AGENT_TIMEOUT_MS, onTool,
  }, loadPi);

}

/** One round's journal record — meter-normalizable (lib/meter.ts
 * reads this format beside the assertion journals; engine/sampling ride
 * explicitly so telemetry labels the era without inference). */
export interface TendRunRecord {
  format: "bigbrain-tend-run/v1";
  invocation_id: string;
  /** The insertions THIS round settled (due before, not due after). */
  insertion_ids: string[];
  /** The staged arrivals this round admitted or passed (#744). */
  staged_ids?: string[];
  model: string;
  auth: string;
  engine: string;
  sampling: string;
  reasoning: string;
  prompt_version: string;
  started_at: string;
  completed_at: string;
  wall_ms: number;
  usage?: RunUsage;
  meter?: RunMeter;
  error?: { message: string };
}

function journalRecord(root: string, record: TendRunRecord): string {
  const rel = `${TEND_JOURNAL_DIR}/${record.completed_at.slice(0, 7)}/${record.invocation_id}.json`;
  ensureDir(join(root, TEND_JOURNAL_DIR, record.completed_at.slice(0, 7)));
  writeAtomic(join(root, rel), `${JSON.stringify(record)}\n`);
  return rel;
}

/** Every tend journal file, newest first across the month shards
 * (`journal/tend/<YYYY-MM>/<id>.json`) — the reader beside the writer
 * above. door.json and anything else flat beside the shards is not a run
 * and is skipped. The one walk (#642) for the readers that used to each
 * re-implement it (/v1/status.last_run, the queue feed's executions). */
export function tendJournalFiles(root: string): { runId: string; path: string }[] {
  const base = join(root, TEND_JOURNAL_DIR);
  let months: string[];
  try {
    months = readdirSync(base)
      .filter((m) => /^\d{4}-\d{2}$/.test(m))
      .sort()
      .reverse();
  } catch {
    return [];
  }
  const out: { runId: string; path: string }[] = [];
  for (const month of months) {
    let names: string[];
    try {
      names = readdirSync(join(base, month))
        .filter((f) => f.endsWith(".json"))
        .sort()
        .reverse();
    } catch {
      continue;
    }
    for (const f of names) out.push({ runId: f.slice(0, -5), path: join(base, month, f) });
  }
  return out;
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
    intake: dueIntakeIds(root).length,
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

export interface TendRound {
  runId: string;
  settled: number;
  remaining: number;
  usage?: RunUsage;
  error?: string;
}

export interface TendResult {
  ran: boolean;
  reason?: string;
  /** A run-stopping fault (distinct from `reason`, which is a normal skip). */
  error?: string;
  rounds: TendRound[];
  memory?: MemoryRunResult;
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
  maxRounds?: number;
  now?: () => Date;
}

/**
 * One tend run: single-flight via the pid-liveness lock (the #479 revision:
 * the LOCK is the concurrency story, `next` is a pure read), bounded intake
 * rounds, then the memory pass when due. Partial progress is durable —
 * every submitted event landed the moment the model called submit; a killed
 * run loses at most one un-submitted batch.
 */
export async function runTend(opts: TendOpts): Promise<TendResult> {
  const { root, manifest } = opts;
  const loadPi = opts.loadPi;
  const now = opts.now ?? (() => new Date());
  const maxRounds = opts.maxRounds ?? TEND_MAX_ROUNDS;
  if (!acquireAssertionLock(root))
    return { ran: false, reason: "another gardener holds the lock", rounds: [] };
  try {
    const rounds: TendRound[] = [];
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
    let before = dueIntakeIds(root);
    let beforeStaged = stagedIds(root);
    const labels = ownerLabelsFor(root);
    for (let round = 0; round < maxRounds && before.length + beforeStaged.length; round++) {
      const runId = newRunId(now());
      const startedAt = now().toISOString();
      let call: AgentRunResult | undefined;
      let error: string | undefined;
      const progress = startGardenerProgress(root);
      try {
        call = await gardenerCall(root, manifest, tendPrompt(labels), loadPi, progress.observe);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      } finally { progress.finish(); }
      const after = dueIntakeIds(root);
      const stillDue = new Set(after);
      const settledIds = before.filter((id) => !stillDue.has(id));
      const afterStaged = stagedIds(root);
      const stillStaged = new Set(afterStaged);
      const settledStaged = beforeStaged.filter((id) => !stillStaged.has(id));
      journalRecord(root, {
        format: "bigbrain-tend-run/v1",
        invocation_id: runId,
        insertion_ids: settledIds,
        ...(settledStaged.length ? { staged_ids: settledStaged } : {}),
        ...choiceJournalFields(manifest.gardener),
        auth: manifest.gardener.adapter === "pi" ? "pi-managed" : manifest.auth,
        prompt_version: TEND_PROMPT_VERSION,
        started_at: startedAt,
        completed_at: now().toISOString(),
        wall_ms: call?.wallMs ?? 0,
        ...(call ? modelRunJournalFields(call) : {}),
        ...(call?.meter ? { meter: call.meter } : {}),
        ...(error ? { error: { message: error.slice(0, 2_000) } } : {}),
      });
      rounds.push({
        runId, settled: settledIds.length + settledStaged.length, remaining: after.length + afterStaged.length,
        ...(call ? modelRunJournalFields(call) : {}), ...(error ? { error } : {}),
      });
      if (error) break;
      // No progress means a bigger batch won't help — a claim the journal
      // now evidences. The next tick retries fresh. (Settled, not counted:
      // an admitted arrival leaves the stage and joins the due set, so the
      // total can hold steady in a round that did real work.)
      if (!settledIds.length && !settledStaged.length) break;
      before = after;
      beforeStaged = afterStaged;
    }
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
        root, manifest, warmBriefings: true,
        ...(opts.force ? { force: true } : {}),
        ...(opts.loadPi ? { loadPi: opts.loadPi } : {}),
      });
    }
    return { ran: true, rounds, ...(memory ? { memory } : {}) };
  } finally {
    releaseAssertionLock(root);
  }
}
