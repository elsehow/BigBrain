#!/usr/bin/env bun
/**
 * econ.ts — `bigbrain econ`: the per-vault unit-economics readout (#324).
 *
 *   bigbrain econ              # last 7 days
 *   bigbrain econ --days 30    # wider window
 *   bigbrain econ --all        # whole ledger, every journal
 *   bigbrain econ --json       # the assembled object, for rollups
 *
 * Joins the two ledgers that live side by side in the vault: the retrieval
 * ledger (the QUERY half — what was asked, what answered: lib/retrieval.ts,
 * lib/econ.ts) and the pass journals (the SPEND half — what the models
 * cost: every journal a pass spends through — PLAN_SUBDIRS: queue, memory,
 * assertions, tend). The headline division, cost per
 * correctly answered query, is an approximation and the readout says so:
 * CLI uses are unobserved, and subscription-auth runs bill as $0.
 *
 * Content stays home: query strings are content, so this runs ON THE BOX
 * per vault. Only names and counts ever leave it.
 */

import { flagValue, hasFlag } from "../lib/cliflags";
import { bursts, shapeCounts, vocabularyGaps } from "../lib/econ";
import { requireVaultRoot } from "../lib/engine";
import { heat, labels, readLedger, summary } from "../lib/retrieval";
// Pure over the vault's own journal files — one shared reader, so every
// consumer's metric definitions stay identical.
import { collectRunUsage, PLAN_SUBDIRS, type PerRun } from "../lib/meter";

import { providerMonitoring } from "../lib/providerMonitor";

const argv = process.argv.slice(2);
const root = requireVaultRoot();

// Same cap discipline as `retrieval --heat`: absurd or unparseable degrades
// to all-time, and the header says which one ran.
const days = Number(flagValue(argv, "days") ?? 7);
const windowed = !hasFlag(argv, "all") && Number.isFinite(days) && days > 0 && days <= 100_000;
const since = windowed ? new Date(Date.now() - days * 86_400_000) : undefined;
const cut = since?.toISOString() ?? null;

// ── query half ──────────────────────────────────────────────────────────────
const records = readLedger(root).filter((r) => !cut || r.at >= cut);
const ls = labels(records);
const s = summary(ls);
const misses = ls.filter((l) => l.via !== "cli" && !l.used.length).length;
const bs = bursts(ls);
const gaps = vocabularyGaps(bs).length;
const shapes = shapeCounts(ls);
const h = heat(records, since);
const reads = h.notes.reduce((n, r) => n + r.reads, 0);

// ── spend half ──────────────────────────────────────────────────────────────
// A journal predating `startedAt` (at:"") or carrying a garbage date belongs
// to all-time, never to a window — the same rule heat applies.
const inWindow = (r: PerRun): boolean =>
  !cut || (!!r.at && !Number.isNaN(Date.parse(r.at)) && r.at >= cut);
const byJournal = PLAN_SUBDIRS.map((subdir) => {
  const per = collectRunUsage(root, subdir).filter(inWindow);
  return { subdir, runs: per.length, per };
});
const per = byJournal.flatMap((p) => p.per);
const sum = (f: (r: PerRun) => number): number => per.reduce((n, r) => n + f(r), 0);
const spend = {
  runs: per.length,
  /** Historical pass-journal counts; live role usage is reported separately. */
  runsByJournal: Object.fromEntries(byJournal.map((p) => [p.subdir, p.runs])),
  failed: sum((r) => r.failed),
  cost_usd: sum((r) => r.cost_usd ?? 0),
  unknownCostRuns: per.filter((r) => r.cost_usd === null).length,
  input_tokens: sum((r) => r.input_tokens),
  output_tokens: sum((r) => r.output_tokens),
  cache_read_tokens: sum((r) => r.cache_read_tokens),
  cache_write_tokens: sum((r) => r.cache_write_tokens),
  ingest: sum((r) => r.ingest),
  /** Runs with no billed cost — subscription-auth journals an honest $0,
   * and a failed or usage-less journal lands here too. Counted so the cost
   * figure reads as a floor, not a total. */
  zeroBilledRuns: per.filter((r) => r.cost_usd === 0).length,
};

// ── the joins ───────────────────────────────────────────────────────────────
const perAnsweredQuery = s.withUse ? spend.cost_usd / s.withUse : null;
const perAbsorbedRef = spend.ingest ? spend.cost_usd / spend.ingest : null;

const report = {
  window: cut ? { since: cut, days } : null,
  queries: {
    searches: s.searches,
    withUse: s.withUse,
    hitRate: s.hitRate,
    mrr: s.mrr,
    zeroResult: s.zeroResult,
    misses,
    bursts: bs.length,
    vocabularyGaps: gaps,
    shapes,
  },
  demand: { reads, topNotes: h.notes.slice(0, 5), trees: h.trees },
  spend,
  providers: providerMonitoring(root),
  unit: { perAnsweredQuery, perAbsorbedRef },
};

if (hasFlag(argv, "json")) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
const usd = (n: number): string => `$${n.toFixed(n >= 1 ? 2 : 3)}`;
const tok = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(0)}k`
      : `${n}`;

console.log(`econ — ${root}`);
console.log(
  cut ? `window          last ${days}d (since ${cut.slice(0, 10)})` : "window          all time"
);
console.log();
console.log("queries (retrieval ledger)");
console.log(
  `  searches      ${s.searches}   acted on ${s.withUse} (${pct(s.hitRate)} of observable) · MRR ${s.mrr.toFixed(2)} · zero-result ${s.zeroResult}`
);
console.log(`  misses        ${misses}   (zero-result searches count here too)`);
console.log(`  bursts        ${bs.length}   vocabulary gaps ${gaps}   (#327 tripwire)`);
console.log(
  `  shapes        entity ${shapes.entity} · time ${shapes.time} · other ${shapes.other} · unknown ${shapes.unknown}`
);
console.log();
console.log("demand (heat, journal/ excluded)");
console.log(`  reads         ${reads}`);
for (const n of h.notes.slice(0, 3)) console.log(`  ${String(n.reads).padStart(5)}  ${n.path}`);
console.log();
console.log("spend (pass journals)");
console.log(
  `  runs          ${spend.runs} (${byJournal.map((p) => `${p.subdir} ${p.runs}`).join(" · ")}) · failed ${spend.failed}`
);
console.log(
  `  cost          ${usd(spend.cost_usd)}${spend.unknownCostRuns ? `   (${spend.unknownCostRuns} runs have unavailable cost; total excludes them)` : ""}${spend.zeroBilledRuns ? `   (${spend.zeroBilledRuns} runs carry no billed cost — cost is a floor)` : ""}`
);
console.log(
  `  tokens        in ${tok(spend.input_tokens)} · out ${tok(spend.output_tokens)} · cache ${tok(spend.cache_read_tokens)}r/${tok(spend.cache_write_tokens)}w`
);
console.log(`  refs absorbed ${spend.ingest}`);
console.log();
console.log("model usage (reported tokens, runs started in the last 7 days)");
for (const monitor of Object.values(report.providers)) {
  if (!monitor.roles.length) continue;
  console.log(`  ${monitor.provider}: ${monitor.roles.map(r => `${r.role} ${r.measuredRuns ? tok(r.tokens) + " tokens" : "unavailable"}${r.partial ? " (partial)" : ""}`).join(" · ")}`);
  for (const w of monitor.quota.windows)
    console.log(`    account ${w.window}: ${pct(w.used)} used · observed ${w.asOf} · resets ${w.resetsAt}${(w.stale ?? monitor.quota.state === "stale") ? " (stale)" : ""}`);
}
console.log();
console.log("unit economics (approximate — CLI uses unobserved, $0 runs uncosted)");
console.log(
  `  per answered query  ${perAnsweredQuery === null ? "—  (no answered queries in window)" : usd(perAnsweredQuery)}`
);
console.log(
  `  per absorbed ref    ${perAbsorbedRef === null ? "—  (nothing absorbed in window)" : usd(perAbsorbedRef)}`
);
