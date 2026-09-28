/**
 * meter.ts — the post-run spend meter: reads finished runs' journals by
 * convention (tend rounds, the pi era's assertion/queue runs) and normalizes
 * them into one per-run usage shape. `bin/econ.ts` sums it for `bigbrain
 * econ`. Extracted from the hosted warden (#262); the registry half —
 * attributing spend to a tenant — went with control/ (#566).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MeterReading, MeterWindow, RunMeter as MeterBracket } from "./meterTypes";
import { journalFiles } from "./run/journal";

/** One journal's own numbers. */
export interface PerRun {
  run_id: string;
  /** `pi` or `claude-cli` — the era marker readers filter on. */
  engine: string;
  /** The model that spent it. Journaled since the beginning and NOT promoted
   * into the ledger until now, which made the one question a COGS table
   * exists to answer — did the model swap help? — unanswerable. */
  model: string;
  /** The sampling record, e.g. `pi:thinking=medium`. Thinking bills as output
   * AND lengthens every later turn, so it moves both sides of the bill. */
  sampling: string;
  turns: number;
  tool_calls: number;
  tool_result_bytes: number;
  cost_usd: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  ingest: number;
  wall_ms: number;
  failed: number;
  /** The journal's own `startedAt` (ISO), "" when a journal predates the
   * field — what lets a reader window spend by time (#324) instead of
   * treating the directory as one undated pile. */
  at: string;
  /** The plan meter bracketing the run (lib/run/claudeOut.ts) — present
   * on subscription-auth runs since the runners moved to stream-json
   * (2026-08-27); absent on api auth and on every older journal. */
  meter?: MeterBracket;
}

/** The pass↔journal-subdir bijection — editor's subdir is `queue` (the
 * historical name), memory's is its own name, the assertion intake pass
 * journals under `assertions` (#475). One mapping, read in either
 * direction, so a subdir can't drift out of sync with the pass it names —
 * the old shape had `journalSubdir` map pass→subdir while `meterRun`
 * separately hand-inverted subdir→pass with its own ternary. */
type MeteredPass = "editor" | "memory" | "assertion" | "tend";
const PASS_SUBDIR: Record<MeteredPass, string> = {
  editor: "queue",
  memory: "memory",
  assertion: "assertions",
  tend: "tend",
};

/** A pass's journal subdir — the editor's is `queue` (the historical name). */
export const journalSubdir = (pass: MeteredPass): string => PASS_SUBDIR[pass];

/** The assertion pass's two journal shapes (lib/assertionAgent.ts): a run
 * record (`bigbrain-assertion-agent-run/v1`) and a rejection
 * (`bigbrain-assertion-agent-rejection/v1`). Named differently from the
 * §4.8 shape the other passes share — `wall_ms`/`started_at` in snake case,
 * a structured `error`, `auth` + `reasoning` in place of `engine` +
 * `sampling` — so they are normalized here rather than taught to every
 * reader (#473). A rejection is a FAILED run with whatever it spent; a
 * run's ingest is the arrivals it handled.
 *
 * Nothing writes the `bigbrain-assertion-agent-*` shapes any more; this
 * path is live only for `bigbrain-tend-run/v1` and for history on disk. */
interface AssertionJournal {
  format: string;
  engine?: unknown;
  sampling?: unknown;
  insertion_ids?: unknown;
  model?: unknown;
  auth?: unknown;
  reasoning?: unknown;
  started_at?: unknown;
  wall_ms?: unknown;
  usage?: {
    cost_usd?: unknown;
    input_tokens?: unknown;
    output_tokens?: unknown;
    /** #640 and after. */
    cache_read_tokens?: unknown;
    /** Before it, and every retired assertion-agent record. */
    cached_input_tokens?: unknown;
    cache_write_tokens?: unknown;
    turns?: unknown;
  };
  tools?: { total?: unknown; result_bytes?: unknown };
  error?: { name?: unknown; message?: unknown } | null;
  meter?: unknown;
}
const isAssertionJournal = (j: unknown): j is AssertionJournal =>
  typeof (j as { format?: unknown })?.format === "string" &&
  ((j as { format: string }).format.startsWith("bigbrain-assertion-agent-") ||
    (j as { format: string }).format === "bigbrain-tend-run/v1");

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A journal's `meter` block, validated field by field — a half-written or
 * hand-edited journal must not crash the meter, and a reading missing its
 * numbers is no reading. */
function meterOf(v: unknown): MeterBracket | undefined {
  if (!isObj(v)) return undefined;
  const window = (w: unknown): MeterWindow | undefined =>
    isObj(w) && typeof w.utilization === "number" && Number.isFinite(w.utilization) && typeof w.resets_at === "string"
      ? { utilization: w.utilization, resets_at: w.resets_at }
      : undefined;
  const reading = (r: unknown): MeterReading | undefined => {
    if (!isObj(r)) return undefined;
    const five_hour = window(r.five_hour);
    const seven_day = window(r.seven_day);
    if (!five_hour && !seven_day) return undefined;
    return { ...(five_hour ? { five_hour } : {}), ...(seven_day ? { seven_day } : {}) };
  };
  const before = reading(v.before);
  const after = reading(v.after);
  return before && after ? { before, after } : undefined;
}

function assertionPerRun(runId: string, j: AssertionJournal): PerRun {
  const rejected = j.format === "bigbrain-assertion-agent-rejection/v1";
  const one: PerRun = {
    run_id: runId,
    // `engine` is a LABEL, not a filter (#503): the readers show every era
    // and group by this word. The pi loop's api journals write "pi";
    // anything else keeps its own auth word so eras stay distinguishable.
    // A journal that names its engine wins (tend writes "claude-code");
    // the pi-era inference from auth covers everything older.
    engine: str(j.engine) || (j.auth === "anthropic-api" ? "pi" : str(j.auth)),
    model: str(j.model),
    sampling: str(j.sampling) || (str(j.reasoning) ? `pi:thinking=${str(j.reasoning)}` : ""),
    turns: num(j.usage?.turns),
    tool_calls: num(j.tools?.total),
    tool_result_bytes: num(j.tools?.result_bytes),
    cost_usd: (j.usage?.cost_usd === null || (j.engine === "codex" && j.usage?.cost_usd === undefined)) ? null : num(j.usage?.cost_usd),
    input_tokens: num(j.usage?.input_tokens),
    output_tokens: num(j.usage?.output_tokens),
    // One number, two spellings on disk. The tend journal said
    // `cached_input_tokens` until #640 gave both spawns one usage shape;
    // records written before that, and every retired assertion-agent
    // record, still carry the old key.
    cache_read_tokens: num(j.usage?.cache_read_tokens ?? j.usage?.cached_input_tokens),
    cache_write_tokens: num(j.usage?.cache_write_tokens),
    wall_ms: num(j.wall_ms),
    ingest: rejected || !Array.isArray(j.insertion_ids) ? 0 : j.insertion_ids.length,
    failed: rejected ? 1 : 0,
    at: str(j.started_at),
  };
  const meter = meterOf(j.meter);
  if (meter) one.meter = meter;
  return one;
}

/**
 * Every run's spend under `journal/<sub>/`, one PerRun per journal file.
 * An editor-era run drains the queue and may write several
 * `journal/queue/<runId>.json` files (one per execution). A memory run
 * (#71) writes one `journal/memory/<runId>.json` with the same §4.8
 * `usage.cost_usd` shape and no `outcomes` (its ingest is always 0). An
 * assertion intake run (#475) writes `journal/assertions/<month>/<id>.json`
 * in its own shape, normalized by `assertionPerRun`.
 *
 * Per-run, never summed: the totals this returned until 2026-08-30 (and the
 * `priorRunIds` set that scoped them to one spawn) were the hosted warden's
 * breaker inputs, and both readers left here — `bigbrain econ` and the plan
 * meter — group the rows themselves. Pure over the filesystem: no registry,
 * no network.
 */
export function collectRunUsage(vaultPath: string, sub = "queue"): PerRun[] {
  const dir = join(vaultPath, "journal", sub);
  const out: PerRun[] = [];
  for (const { runId, path } of journalFiles(dir)) {
    let j: {
      usage?: {
        cost_usd?: number | null;
        input_tokens?: number;
        output_tokens?: number;
        cache_read_tokens?: number;
        cache_write_tokens?: number;
        turns?: number;
      };
      tools?: { total?: number; result_bytes?: number };
      engine?: unknown;
      model?: unknown;
      sampling?: unknown;
      startedAt?: unknown;
      wallMs?: number;
      outcomes?: unknown;
      error?: unknown;
      meter?: unknown;
    };
    try {
      j = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue; // a half-written journal — skip it, never throw in the meter
    }
    if (isAssertionJournal(j)) {
      out.push(assertionPerRun(runId, j));
      continue;
    }
    const one: PerRun = {
      run_id: runId,
      engine: typeof j.engine === "string" ? j.engine : "",
      model: typeof j.model === "string" ? j.model : "",
      sampling: typeof j.sampling === "string" ? j.sampling : "",
      turns: num(j.usage?.turns),
      tool_calls: num(j.tools?.total),
      tool_result_bytes: num(j.tools?.result_bytes),
      cost_usd: (j.usage?.cost_usd === null || (j.engine === "codex" && j.usage?.cost_usd === undefined)) ? null : num(j.usage?.cost_usd),
      input_tokens: num(j.usage?.input_tokens),
      output_tokens: num(j.usage?.output_tokens),
      cache_read_tokens: num(j.usage?.cache_read_tokens),
      cache_write_tokens: num(j.usage?.cache_write_tokens),
      wall_ms: num(j.wallMs),
      ingest: Array.isArray(j.outcomes)
        ? j.outcomes.filter((o) => typeof o === "string" && o.includes(" absorbed")).length
        : 0,
      failed: j.error !== undefined && j.error !== null && j.error !== "" ? 1 : 0,
      at: typeof j.startedAt === "string" ? j.startedAt : "",
    };
    const meter = meterOf(j.meter);
    if (meter) one.meter = meter;
    out.push(one);
  }
  return out;
}


/** Historical pass journals retained for the economics readout. */
export const PLAN_SUBDIRS = ["queue", "memory", "assertions", "tend"] as const;
