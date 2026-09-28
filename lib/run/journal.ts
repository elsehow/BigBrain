/**
 * journal.ts — run ids, the §4.8 model-run journal block, and the one
 * typed reader over the historical run journals (#498: what survives of
 * the editor's paper trail — `journal/queue/` and its legacy siblings are
 * frozen history that noteLog and /v1/status still read; the writers died
 * with the pass, and new runs journal under `journal/tend/`).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { executionJournalFields } from "../modelResolution";
import type { AgentRunResult, ModelRunResult } from "./model";

/** Mint a run's id: the wall-clock instant, filesystem-safe, plus four
 * random chars so two runs starting the same millisecond stay distinct. */
export const newRunId = (now = new Date()): string =>
  `${now.toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;

/** The §4.8 parity block every run journal carries when a model actually
 * ran: which runner, under what sampling and tool policy, at what cost,
 * inside what containment — answerable per run, never inferred from
 * vault.yaml later. One builder, both writers (the queue journal in
 * worker.ts, the memory journal in memoryRun.ts), so the field set cannot
 * drift between them again. The pi transcript profile (`tools`) is NOT
 * here: the queue journal records it, the memory journal never has, and
 * this builder changes neither shape. */
export function modelRunJournalFields(run: ModelRunResult | AgentRunResult): Record<string, unknown> {
  return {
    ...(run.runId ? { model_run: run.runId } : {}),
    ...(run.execution ? executionJournalFields(run.execution) : "engine" in run ? { engine: run.engine, sampling: run.sampling } : {}),
    // the session the run was: names its transcript, and is the id the
    // agent-chat doors were told to skip (#605)
    ...(run.sessionId ? { session: run.sessionId } : {}),
    ...(run.usage ? { usage: run.usage } : {}),
    // Preserve historical account readings without attributing quota to this run.
    ...(run.meter ? { meter: run.meter } : {}),
  };
}

// ── reading a run journal back (#265) ───────────────────────────────────────
// Three call sites used to JSON.parse(readFileSync(...)) this file ad hoc,
// each casting to `Record<string, unknown>` and reaching for its own subset
// of fields: lib/api.ts's /v1/status.last_run, lib/noteLog.ts's runRole/
// journalModelFor/journalLogRows. One shape, one loader, next to the writer
// that defines it.

/** The fields runQueue's journal(extra) writes for `journal/queue/<runId>.json`,
 * PLUS the legacy pre-#263 shapes still on disk in `journal/{triage,deep,
 * intake,librarian}/<runId>.json` (the lane split's own writer, long since
 * removed, wrote `lane`/`verb` where the queue era writes none). Every
 * field is optional: a reader has no business assuming an old record
 * carries a field a newer writer added, or the reverse. Deliberately not
 * exhaustive — `arrivals`, `sampling`, `disallowedTools`, `engineCommit`
 * and friends exist on disk but no reader has needed them individually
 * yet; add a field here when one does, rather than widening this to
 * mirror the writer's full literal. */
export interface QueueJournalRecord {
  run?: string;
  startedAt?: string;
  messages?: string[];
  model?: string;
  auth?: string;
  engine?: string;
  wallMs?: number;
  commit?: string | null;
  outcomes?: string[];
  report?: string;
  /** Set on a stage pre-pass record (#308, the retired stage pre-passes) — same ledger, same
   * shape, but NOT an editor execution: the run surfaces (status.last_run,
   * the queue view's executions, note history) skip records carrying it. */
  stage?: string;
  /** Retired lane split (removed 2026-08-02) — legacy records only. */
  lane?: string;
  /** Legacy triage/deep records' action word; the queue era has no
   * equivalent field (its actions come from `outcomes`). */
  verb?: string;
}

/** One journal file, read once: the parsed record (typed, loosely) AND the
 * raw text — noteLog.ts's journalLogRows matches a note's path/id against
 * the raw JSON text for legacy records whose shape predates any indexable
 * field, so callers that don't need it can just ignore `raw`. Undefined on
 * ANY failure (missing file, unreadable, not valid JSON, not an object) —
 * a journal entry is disposable audit trail, never worth a throw. */
export function readQueueJournalFile(
  path: string
): { raw: string; record: QueueJournalRecord } | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    return { raw, record: parsed as QueueJournalRecord };
  } catch {
    return undefined;
  }
}

/** Every journal file under `journal/<sub>/`, as (runId, path) — the flat
 * layout the editor and memory passes write (`<sub>/<runId>.json`) AND the
 * month-sharded one the assertion pass writes (`<sub>/<YYYY-MM>/<id>.json`,
 * lib/assertionAgent.ts). One level deep, by convention; the runId is the
 * file stem either way (invocation ids are globally unique, so a month
 * prefix would add nothing but a second spelling of the same run).
 * Path-sorted ascending — run ids are ISO-stamped, so reversing this is
 * newest-first. [] on an unreadable dir, never a throw. */
export function journalFiles(dir: string): { runId: string; path: string }[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { runId: string; path: string }[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      let inner: string[];
      try {
        inner = readdirSync(join(dir, e.name));
      } catch {
        continue;
      }
      for (const f of inner)
        if (f.endsWith(".json")) out.push({ runId: f.slice(0, -5), path: join(dir, e.name, f) });
    } else if (e.name.endsWith(".json")) {
      out.push({ runId: e.name.slice(0, -5), path: join(dir, e.name) });
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
