/**
 * worthGate.ts — "worth gardening?" (#80): one gate in front of the gardener
 * for what integrations find, scored by Jev against the gardener's own past
 * verdicts. Admission (lib/integrationAdmission.ts) asks it.
 *
 * Every staged item from a gated source is scored (`gateDecide`): a rule in
 * words, plus examples drawn from what the gardener did with that source's
 * earlier arrivals: filed (an assertion cites it) or declined. At or above
 * the cut-off it is admitted as before. Under it, it is passed, except a
 * random `sample` share that still goes to the gardener to check the cut-off.
 *
 * The cut-off is homeostatic and has no state of its own (`gateThreshold`):
 * it is recomputed from the gate's journal joined to the gardener's later
 * verdicts. It starts at 0, so turning the gate on drops nothing, and rises
 * only as far as it would still keep `recall` of what the gardener files. A
 * sampled item counts 1/sample times: it stands for the ones that weren't.
 *
 * The journal (journal/gate/<month>.jsonl) is every decision, so a drop is
 * never silent: `bigbrain gate` lists them. The gate is not a security
 * control (that's the firewall): when it cannot score, it admits.
 */

import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openAssertionProjectionReadonly, syncAssertionProjection } from "./assertionProjection";
import { ensureDir } from "./fsx";
import { teachingExamples, type TeachingExample } from "./inclusionExamples";
import type { InclusionLabel, InclusionSource } from "./inclusionPolicy";
import { optionalJevKey } from "./jevSettings";
import type { GateConfig } from "./manifest";
import { evaluateJev } from "./sharedJev";
import { liveSourceSql } from "./sourceSupersede";
import { withCredits } from "./providerCredits";

export const GATE_JOURNAL_DIR = "journal/gate";

export interface GateDecision {
  at: string;
  /** The staged item. */
  id: string;
  source: string;
  title: string;
  /** Jev's score, or null when it could not score (the item is admitted). */
  score: number | null;
  threshold: number;
  admitted: boolean;
  /** Under the cut-off, sent to the gardener anyway to check it. */
  sampled?: boolean;
  /** The arrival an admitted item became, so its verdict can be found. */
  insertion_id?: string;
  error?: string;
}

export function gateDecisions(root: string): GateDecision[] {
  const dir = join(root, GATE_JOURNAL_DIR);
  let files: string[];
  try { files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch { return []; }
  return files.flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").flatMap((line) => {
    try { return line.trim() ? [JSON.parse(line) as GateDecision] : []; } catch { return []; }
  }));
}

export function recordGateDecision(root: string, d: GateDecision): void {
  ensureDir(join(root, GATE_JOURNAL_DIR));
  appendFileSync(join(root, GATE_JOURNAL_DIR, `${d.at.slice(0, 7)}.jsonl`), `${JSON.stringify(d)}\n`);
}

/** Does the gate score this integration's arrivals? Every one, unless `sources` names some. */
export const gated = (cfg: GateConfig, source: string): boolean => !cfg.sources || cfg.sources.includes(source);

export interface Verdict { insertion_id: string; title: string; body: string; kept: boolean }

/** The gardener's verdicts on a source's arrivals, newest first: filed (an
 * assertion cites it) or declined. Arrivals it hasn't answered yet are left out. */
export function gardenerVerdicts(root: string, source: string, limit = 1000): Verdict[] {
  syncAssertionProjection(root);
  const db = openAssertionProjectionReadonly(root);
  try {
    const rows = db.query(`SELECT * FROM (SELECT s.insertion_id, s.title, s.body, s.received_at,
        EXISTS (SELECT 1 FROM assertion_sources a WHERE a.insertion_id = s.insertion_id) AS kept,
        EXISTS (SELECT 1 FROM declines d WHERE d.insertion_id = s.insertion_id) AS declined
      FROM sources s WHERE s.envelope_source = ? AND ${liveSourceSql("s")})
      WHERE kept OR declined ORDER BY received_at DESC LIMIT ?`).all(source, limit) as { insertion_id: string; title: string; body: string; kept: number }[];
    return rows.map((r) => ({ insertion_id: r.insertion_id, title: r.title, body: r.body, kept: !!r.kept }));
  } finally { db.close(); }
}

/** The highest cut-off that keeps `recall` of what the gardener filed, over
 * the last 500 scored, admitted and answered items; 0 until `min` of them. */
export function gateThreshold(cfg: GateConfig, decisions: readonly GateDecision[], kept: ReadonlyMap<string, boolean>): number {
  const seen = decisions.filter((d) => d.admitted && d.score != null && d.insertion_id && kept.has(d.insertion_id)).slice(-500);
  if (seen.length < cfg.min) return 0;
  const weight = (d: GateDecision) => (d.sampled ? 1 / cfg.sample : 1);
  const filed = seen.filter((d) => kept.get(d.insertion_id!));
  const total = filed.reduce((n, d) => n + weight(d), 0);
  if (!total) return 0;
  let best = 0;
  for (let step = 1; step < 20; step++) {
    const t = step / 20;
    const lost = filed.filter((d) => d.score! < t).reduce((n, d) => n + weight(d), 0);
    if (lost / total > 1 - cfg.recall) break;
    best = t;
  }
  return best;
}

/** A source's cut-off now, and the verdicts it was computed from. */
export function currentGate(root: string, cfg: GateConfig, source: string): { threshold: number; verdicts: Verdict[]; kept: Map<string, boolean> } {
  const verdicts = gardenerVerdicts(root, source);
  const kept = new Map(verdicts.map((v) => [v.insertion_id, v.kept]));
  return { threshold: gateThreshold(cfg, gateDecisions(root).filter((d) => d.source === source), kept), verdicts, kept };
}

export type GateScorer = (rule: string, item: InclusionSource, examples: TeachingExample[]) => Promise<number>;

const jevScorer = (store: string): GateScorer => async (rule, item, examples) => {
  const key = optionalJevKey(store);
  if (!key) throw new Error("no Jev key: add one in model settings");
  return (await evaluateJev(key, rule, [], { title: item.title, body: item.body }, fetch, examples)).relevant;
};

/** One staged item's decision. Not yet journaled: the caller records it once
 * it knows what the item became. */
export async function gateDecide(opts: {
  root: string; store: string; cfg: GateConfig; source: string; item: InclusionSource;
  score?: GateScorer; random?: () => number; now?: () => Date;
}): Promise<GateDecision> {
  const { root, cfg, source, item } = opts;
  const { threshold, verdicts } = currentGate(root, cfg, source);
  const base = { at: (opts.now ?? (() => new Date()))().toISOString(), id: item.id, source, title: item.title.slice(0, 200), threshold };
  const labels: InclusionLabel[] = verdicts.slice(0, 300).map((v) => ({ source: { id: v.insertion_id, title: v.title, body: v.body, origin: source }, include: v.kept }));
  let score: number;
  try {
    score = await withCredits(root, "typesafe", "gate", () => (opts.score ?? jevScorer(opts.store))(cfg.rule, item, teachingExamples(labels, item)));
  } catch (e) {
    return { ...base, score: null, admitted: true, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
  if (score >= threshold) return { ...base, score, admitted: true };
  return (opts.random ?? Math.random)() < cfg.sample ? { ...base, score, admitted: true, sampled: true } : { ...base, score, admitted: false };
}
