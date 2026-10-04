/** goalChain.ts — the goal chain (#51): gardening toward the owner's goals.
 *
 * Inputs are the owner's abstract goals (vault.yaml `chains.goals`). Two
 * stages, both non-agentic, both through the Pi runner:
 *
 * - SOURCE: one call per arrival (prompts/goals-source.md). It sees the goals,
 *   the current picture and the arrival's owner-only view, and answers with
 *   typed assertions — `assertion` holds only what the source says,
 *   `relevance` may lean on the picture. Each answer is one event in
 *   log/goal-assertions (lib/goalLog.ts); an arrival is due until one cites it.
 * - PICTURE: a short model of what the owner is pursuing
 *   (prompts/goals-picture.md), rebuilt from the previous picture plus the new
 *   `about_goals` assertions — their `assertion` field only, so nothing the
 *   picture told the gardener comes back to it as evidence.
 *
 * The picture's cadence counts in ARRIVAL time: each picture covers a window
 * of `interval`, and the next window's arrivals are gardened against it. A
 * backfill therefore replays week by week, and in steady state the window
 * catches up to today and the picture rebuilds once an interval has passed.
 * Every picture is journaled (journal/goals/), so none is ever overwritten.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ownerLabelsFor } from "./assertionAgent";
import {
  openAssertionProjectionReadonly,
  projectedSourcesById,
  syncAssertionProjection,
} from "./assertionProjection";
import { scheduledVerdict, type Chain, type ChainDue, type ChainRunOpts, type StageVerdict } from "./chain";
import { ENGINE_ROOT } from "./engine";
import { ensureDir, writeAtomic } from "./fsx";
import {
  appendGoalEvent, commitGoalEvents, createGoalEvent, GOAL_ASSERTION_TYPES, goalEventRel, readGoalLog,
  type GoalAssertion, type GoalEvent,
} from "./goalLog";
import type { SourceInsertion } from "./insertionLog";
import { loadManifest, type GoalChainConfig, type Manifest } from "./manifest";
import { choiceJournalFields } from "./modelResolution";
import { acquire, release } from "./pidLock";
import { render } from "./prompts";
import { runAgent } from "./run/agent";
import { modelRunJournalFields, newRunId } from "./run/journal";
import type { AgentRunResult, RunUsage } from "./run/model";
import { liveSourceSql } from "./sourceSupersede";
import { intakeBody } from "./work";

export const GOAL_JOURNAL_DIR = "journal/goals";
const SOURCE_PROMPT_VERSION = "goals-source/v1";
const PICTURE_PROMPT_VERSION = "goals-picture/v1";
const PICTURE_AGENT_PROMPT_VERSION = "goals-picture-agent/v1";
/** A hard bound on an agent picture; the prompt asks for 4,000 characters. */
const PICTURE_AGENT_MAX_CHARS = 16_000;
/** The owner-only view a source call reads, at most. */
export const GOAL_SOURCE_CHARS = 150_000;
/** A source whose call fails this many times in one run is recorded as failed. */
const SOURCE_ATTEMPTS = 3;
const NO_PICTURE = "none yet";

type Runner = typeof runAgent;

// ── the picture journal: the stage's record and its checkpoint ─────────────

export interface PictureRecord {
  format: "bigbrain-goal-picture/v1";
  invocation_id: string;
  /** The picture itself; unchanged from the last when nothing new arrived. */
  picture: string;
  /** The arrival-time window this picture closes: [from, through). */
  covers: { from: string; through: string };
  /** Goal events folded in by THIS picture — the checkpoint is their union. */
  events: string[];
  /** False when the window brought no goal assertions: no model was called. */
  rebuilt: boolean;
  prompt_version: string;
  started_at: string;
  completed_at: string;
  model?: string;
  usage?: RunUsage;
  error?: { message: string };
}

export function pictureRecords(root: string): PictureRecord[] {
  const base = join(root, GOAL_JOURNAL_DIR);
  let months: string[];
  try {
    months = readdirSync(base).filter((m) => /^\d{4}-\d{2}$/.test(m)).sort();
  } catch {
    return [];
  }
  const out: PictureRecord[] = [];
  for (const month of months)
    for (const f of readdirSync(join(base, month)).filter((n) => n.endsWith(".json")).sort()) {
      try {
        out.push(JSON.parse(readFileSync(join(base, month, f), "utf8")) as PictureRecord);
      } catch { /* a damaged record is skipped, never fatal */ }
    }
  return out.sort((a, b) => a.covers.through.localeCompare(b.covers.through) || a.completed_at.localeCompare(b.completed_at));
}

/** The pictures that closed their window — a failed build closes nothing. */
const closed = (records: PictureRecord[]): PictureRecord[] => records.filter((r) => !r.error);

/** The goal events some picture has folded in: the stage's checkpoint. */
const foldedEvents = (records: PictureRecord[]): Set<string> => new Set(closed(records).flatMap((r) => r.events));

/** The newest picture that closed its window. */
export function latestPicture(root: string): PictureRecord | undefined {
  return closed(pictureRecords(root)).at(-1);
}

function journalPicture(root: string, record: PictureRecord): string {
  const month = record.completed_at.slice(0, 7);
  const rel = `${GOAL_JOURNAL_DIR}/${month}/${record.invocation_id}.json`;
  ensureDir(join(root, GOAL_JOURNAL_DIR, month));
  writeAtomic(join(root, rel), `${JSON.stringify(record, null, 1)}\n`);
  return rel;
}

// ── the window and the due view ────────────────────────────────────────────

const dayStart = (date: string): string => new Date(`${date}T00:00:00.000Z`).toISOString();
const plus = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

/** The window the next picture closes: from the last picture's end (or
 * `since`), one interval long. */
export function pictureWindow(cfg: GoalChainConfig, last: PictureRecord | undefined): { from: string; end: string } {
  const from = last?.covers.through ?? dayStart(cfg.since);
  return { from, end: plus(from, cfg.intervalMs) };
}

/** Intake arrivals in [since, before), oldest first — the same intake set the
 * classic chain drains (lib/intakeClass.ts), read from the projection. */
function intakeIdsBefore(root: string, since: string, before: string): string[] {
  syncAssertionProjection(root);
  const db = openAssertionProjectionReadonly(root);
  try {
    return (db.query(`SELECT s.insertion_id AS id FROM sources s
      WHERE s.intake_priority IS NOT NULL AND ${liveSourceSql("s")}
        AND s.intake_at >= ? AND s.intake_at < ?
      ORDER BY s.intake_at, s.insertion_id`).all(since, before) as { id: string }[]).map((r) => r.id);
  } finally { db.close(); }
}

/** Arrivals the goal log does not yet cite, up to the window's end (or now). */
export function dueGoalSources(root: string, cfg: GoalChainConfig, now = new Date(), events = readGoalLog(root)): string[] {
  const { end } = pictureWindow(cfg, latestPicture(root));
  const before = end < now.toISOString() ? end : now.toISOString();
  const settled = new Set(events.map((e) => e.insertion_id));
  return intakeIdsBefore(root, dayStart(cfg.since), before).filter((id) => !settled.has(id));
}

/** The picture is the chain's scheduled stage, judged by the one rule
 * (lib/chain.ts): its clock is the window's end, and its work is a window
 * whose arrivals have all been gardened. */
export function pictureDue(root: string, cfg: GoalChainConfig, opts: { now?: Date; force?: boolean } = {}): StageVerdict {
  const now = opts.now ?? new Date();
  const records = pictureRecords(root);
  const { end } = pictureWindow(cfg, closed(records).at(-1));
  return scheduledVerdict({
    ...opts, now, nextRunAt: end,
    work: () => {
      if (dueGoalSources(root, cfg, now).length) return undefined;
      const folded = foldedEvents(records);
      const fresh = readGoalLog(root).filter((e) => !folded.has(e.id)).length;
      return fresh ? `${fresh} new goal event(s)` : "an empty window to close";
    },
    idle: "arrivals in this window are still being gardened",
  });
}

// ── the source stage ───────────────────────────────────────────────────────

const ASSERTIONS_SCHEMA = {
  type: "object",
  properties: {
    assertions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...GOAL_ASSERTION_TYPES] },
          assertion: { type: "string" },
          relevance: { type: "string" },
        },
        required: ["type", "assertion", "relevance"],
        additionalProperties: false,
      },
    },
  },
  required: ["assertions"],
  additionalProperties: false,
};

const ownerName = (root: string): string => ownerLabelsFor(root)[0] ?? "the owner";
const goalList = (cfg: GoalChainConfig): string => cfg.goals.map((g, i) => `${i + 1}. ${g}`).join("\n");
const template = (name: string): string => readFileSync(join(ENGINE_ROOT, "prompts", name), "utf8");

/** The one rendering of an arrival the source stage reads. `from_kind` is
 * the door's grade of the sender (lib/voice.ts): `person`, `agent` or
 * `service`, stamped from the verified credential — without it, an agent's
 * relay of what the owner "decided" reads like the owner's own words. */
export function renderGoalSource(insertion: SourceInsertion): string {
  const env = insertion.envelope ?? {};
  const str = (k: string) => (typeof env[k] === "string" ? env[k] : "");
  return [
    "SOURCE",
    `title: ${insertion.title ?? ""}`,
    `from: ${str("from")}`,
    `from_kind: ${str("from_kind")}`,
    `via: ${str("source")}`,
    `date: ${insertion.occurred_at ?? insertion.received_at ?? ""}`,
    "",
    intakeBody(insertion).slice(0, GOAL_SOURCE_CHARS),
  ].join("\n");
}

function parseAssertions(text: string): GoalAssertion[] {
  const json = text.trim().replace(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/, "$1").trim();
  const value = JSON.parse(json) as { assertions: GoalAssertion[] };
  return value.assertions.filter((a) => a.assertion.trim());
}

interface SourceOutcome { id: string; event?: GoalEvent; error?: string; usage?: RunUsage }

async function gardenSource(
  ctx: { root: string; manifest: Manifest; cfg: GoalChainConfig; instructions: string; picture?: string; runner: Runner; runId: string },
  insertion: SourceInsertion,
): Promise<SourceOutcome> {
  let error = "";
  let cost = 0;
  for (let attempt = 0; attempt < SOURCE_ATTEMPTS; attempt++) {
    let run: AgentRunResult | undefined;
    try {
      run = await ctx.runner({
        root: ctx.root, role: "goals", auth: ctx.manifest.auth, target: ctx.cfg.source,
        instructions: ctx.instructions, prompt: renderGoalSource(insertion), capabilities: "none",
        output: { requireText: true, schema: ASSERTIONS_SCHEMA },
      });
      cost += run.usage?.cost_usd ?? 0;
      const assertions = parseAssertions(run.text);
      const event = createGoalEvent({
        insertion_id: insertion.id, source_id: insertion.source_id, assertions,
        ...(ctx.picture ? { picture: ctx.picture } : {}),
        author: { kind: "model", id: ctx.cfg.source.model, invocation_id: ctx.runId },
        created_at: new Date().toISOString(),
        produced_by: { procedure: "goals/source", version: "v1", prompt_version: SOURCE_PROMPT_VERSION, invocation_id: ctx.runId },
      });
      appendGoalEvent(ctx.root, event);
      return { id: insertion.id, event, ...(run.usage ? { usage: { ...run.usage, cost_usd: cost } } : {}) };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  return { id: insertion.id, error };
}

async function gardenSources(
  root: string, manifest: Manifest, cfg: GoalChainConfig, ids: string[], runner: Runner, runId: string,
): Promise<SourceOutcome[]> {
  const last = latestPicture(root);
  const instructions = render(template("goals-source.md"), {
    OWNER: ownerName(root), GOALS: goalList(cfg), PICTURE: last?.picture ?? NO_PICTURE,
  });
  const sources = projectedSourcesById(root, ids);
  const ctx = { root, manifest, cfg, instructions, runner, runId, ...(last ? { picture: last.invocation_id } : {}) };
  const outcomes: SourceOutcome[] = [];
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const insertion = sources.get(ids[next++]!);
      if (insertion) outcomes.push(await gardenSource(ctx, insertion));
    }
  };
  await Promise.all(Array.from({ length: Math.min(cfg.concurrency, ids.length) }, worker));
  return outcomes;
}

// ── the picture stage ──────────────────────────────────────────────────────

async function buildPicture(
  root: string, manifest: Manifest, cfg: GoalChainConfig, runner: Runner, now: Date,
): Promise<PictureRecord> {
  const records = pictureRecords(root);
  const last = closed(records).at(-1);
  const { from, end } = pictureWindow(cfg, last);
  const through = end < now.toISOString() ? end : now.toISOString();
  const folded = foldedEvents(records);
  const fresh = readGoalLog(root).filter((e) => !folded.has(e.id));
  const sources = projectedSourcesById(root, fresh.map((e) => e.insertion_id));
  const agent = cfg.pictureMode === "agent";
  const lines = fresh.flatMap((e) => {
    const s = sources.get(e.insertion_id);
    const date = (s?.occurred_at ?? s?.received_at ?? "").slice(0, 10);
    // The agent sees where each assertion came from, so it can tell the
    // owner's words from a relay; the single call sees the text alone.
    const env = (k: string) => (typeof s?.envelope?.[k] === "string" ? s.envelope[k] : "?");
    const tag = agent ? `[${e.insertion_id} · ${date} · ${env("source")} · ${env("from_kind")}]` : `(${date})`;
    return e.assertions.filter((a) => a.type === "about_goals").map((a) => `- ${tag} ${a.assertion}`);
  });
  const startedAt = new Date().toISOString();
  const base = {
    format: "bigbrain-goal-picture/v1" as const, invocation_id: newRunId(now),
    covers: { from, through }, events: fresh.map((e) => e.id),
    prompt_version: agent ? PICTURE_AGENT_PROMPT_VERSION : PICTURE_PROMPT_VERSION,
    started_at: startedAt,
  };
  if (!lines.length)
    return { ...base, picture: last?.picture ?? NO_PICTURE, rebuilt: false, completed_at: new Date().toISOString() };
  const input = agent
    ? [`AS OF ${through.slice(0, 10)}`, "", "ABSTRACT GOALS", goalList(cfg), "", "PREVIOUS MODEL", last?.picture ?? NO_PICTURE, "", "NEW GOAL ASSERTIONS", ...lines].join("\n")
    : ["ABSTRACT GOALS", goalList(cfg), "", "CURRENT PICTURE", last?.picture ?? NO_PICTURE, "", "ASSERTIONS", ...lines].join("\n");
  try {
    const run = await runner(agent
      ? {
        root, role: "goals-picture", auth: manifest.auth, target: cfg.picture, capabilities: "goals",
        instructions: render(template("goals-picture-agent.md"), { OWNER: ownerName(root) }),
        prompt: input, output: { requireText: true, maxCharacters: PICTURE_AGENT_MAX_CHARS },
      }
      : {
        root, role: "goals", auth: manifest.auth, target: cfg.picture, capabilities: "none",
        instructions: render(template("goals-picture.md"), { OWNER: ownerName(root) }),
        prompt: input, output: { requireText: true },
      });
    return {
      ...base, picture: run.text.trim(), rebuilt: true, completed_at: new Date().toISOString(),
      model: cfg.picture.model, ...modelRunJournalFields(run) as { usage?: RunUsage },
    };
  } catch (e) {
    return {
      ...base, picture: last?.picture ?? NO_PICTURE, rebuilt: false, completed_at: new Date().toISOString(),
      ...choiceJournalFields(cfg.picture), error: { message: (e instanceof Error ? e.message : String(e)).slice(0, 2_000) },
    };
  }
}

// ── the chain ──────────────────────────────────────────────────────────────

export interface GoalWindowResult {
  covers: { from: string; through: string };
  gardened: number;
  assertions: number;
  failed: string[];
  picture?: { run: string; rebuilt: boolean; chars: number; error?: string };
  cost_usd: number;
}

export interface GoalResult {
  ran: boolean;
  reason?: string;
  windows: GoalWindowResult[];
}

const goalLockDir = (root: string): string => join(root, ".state", "goals.lock");

/** One run gardens at most `cfg.batch` arrivals, so a backfill drains tick by
 * tick and never holds the supervisor's `tend` tick — which the classic chain
 * shares — for longer than a batch takes. */
export async function runGoals(
  opts: ChainRunOpts & { runner?: Runner; now?: () => Date },
): Promise<GoalResult> {
  const { root, manifest } = opts;
  const cfg = manifest.chains.goals;
  if (!cfg) return { ran: false, reason: "no chains.goals in vault.yaml", windows: [] };
  ensureDir(join(root, ".state"));
  if (!acquire(goalLockDir(root), "goals")) return { ran: false, reason: "another goal run holds the lock", windows: [] };
  const runner = opts.runner ?? runAgent;
  const now = opts.now ?? (() => new Date());
  const windows: GoalWindowResult[] = [];
  try {
    let budget = cfg.batch;
    for (;;) {
      const runId = newRunId(now());
      const { from, end } = pictureWindow(cfg, latestPicture(root));
      const ids = dueGoalSources(root, cfg, now()).slice(0, budget);
      budget -= ids.length;
      const outcomes = await gardenSources(root, manifest, cfg, ids, runner, runId);
      const landed = outcomes.flatMap((o) => (o.event ? [o.event] : []));
      if (landed.length)
        commitGoalEvents(root, landed.map(goalEventRel), `goals: ${landed.length} gardened`);
      const window: GoalWindowResult = {
        covers: { from, through: end }, gardened: landed.length,
        assertions: landed.reduce((n, e) => n + e.assertions.length, 0),
        failed: outcomes.filter((o) => o.error).map((o) => o.id),
        cost_usd: outcomes.reduce((n, o) => n + (o.usage?.cost_usd ?? 0), 0),
      };
      if (pictureDue(root, cfg, { now: now() }).due) {
        const record = await buildPicture(root, manifest, cfg, runner, now());
        journalPicture(root, record);
        window.covers = record.covers;
        window.picture = { run: record.invocation_id, rebuilt: record.rebuilt, chars: record.picture.length, ...(record.error ? { error: record.error.message } : {}) };
        window.cost_usd += record.usage?.cost_usd ?? 0;
        windows.push(window);
        if (record.error) break;
        continue;
      }
      if (ids.length) windows.push(window);
      break;
    }
    return { ran: true, windows };
  } finally {
    release(goalLockDir(root));
  }
}

export const goalChain: Chain<GoalResult> = {
  name: "goals",
  due(root: string, opts: { now?: Date } = {}): ChainDue {
    const cfg = loadManifest(root).chains.goals;
    if (!cfg) return { source: 0, scheduled: {} };
    return {
      source: dueGoalSources(root, cfg, opts.now).length,
      scheduled: { picture: pictureDue(root, cfg, opts) },
    };
  },
  run: runGoals,
  report(result: GoalResult) {
    if (!result.ran) return { lines: [`goals: ${result.reason}`], failed: false };
    const lines = result.windows.map((w) =>
      `goals: ${w.covers.from.slice(0, 10)}–${w.covers.through.slice(0, 10)} — ${w.gardened} gardened, ${w.assertions} assertions` +
        (w.failed.length ? `, ${w.failed.length} failed` : "") +
        (w.picture ? `; picture ${w.picture.rebuilt ? `rebuilt (${w.picture.chars} chars)` : "unchanged"}` : "") +
        (w.picture?.error ? ` — ERROR: ${w.picture.error}` : "") +
        ` ($${w.cost_usd.toFixed(2)})`);
    if (!lines.length) lines.push("goals: nothing due");
    return { lines, failed: result.windows.some((w) => w.failed.length || w.picture?.error) };
  },
};
