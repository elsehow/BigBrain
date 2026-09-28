#!/usr/bin/env bun
/**
 * retrieval.ts — `bigbrain retrieval`: read the retrieval ledger back.
 *
 *   bigbrain retrieval              # headline numbers
 *   bigbrain retrieval --misses     # searches nobody acted on — where retrieval failed
 *   bigbrain retrieval --heat       # per-note demand: what gets read (--days N to window)
 *   bigbrain retrieval --json       # every label, for BigBrainBench
 *
 * The ledger is written by the search doors (lib/retrieval.ts); this is the
 * only reader a person needs. Plumbing tier: the numbers matter to us, not
 * to a user filing a note.
 *
 * `--misses` is the useful view. A search whose hits were all ignored is the
 * one signal that says the index answered the wrong question, and it is the
 * scarce half of the label set — successes we would have guessed.
 *
 * `--heat` reads demand, not labels: every use in the window, counted by
 * path — the profile that heat-weighted curation (#325) and the econ
 * report (#324) consume.
 */

import { requireVaultRoot } from "../lib/engine";
import { heat, labels, readLedger, summary } from "../lib/retrieval";
import { flagValue, hasFlag } from "../lib/cliflags";

const argv = process.argv.slice(2);
const root = requireVaultRoot();

const records = readLedger(root);

if (hasFlag(argv, "heat")) {
  // The cap keeps days * 86_400_000 inside Date range; anything absurd or
  // unparseable degrades to all-time, and the header says which one ran.
  const days = Number(flagValue(argv, "days"));
  const since =
    Number.isFinite(days) && days > 0 && days <= 100_000
      ? new Date(Date.now() - days * 86_400_000)
      : undefined;
  const h = heat(records, since);
  if (hasFlag(argv, "json")) {
    console.log(JSON.stringify(h, null, 2));
    process.exit(0);
  }
  if (!h.notes.length) {
    console.error(since ? "heat: no reads in the window" : "heat: no reads recorded yet");
    process.exit(0);
  }
  const total = h.notes.reduce((n, r) => n + r.reads, 0);
  const window = since ? `last ${days}d` : "all time";
  console.log(
    `reads           ${total}  (${window}; HTTP doors only — CLI/agent reads are off-instrument)`
  );
  console.log("by tree:");
  for (const t of h.trees) console.log(`  ${String(t.reads).padStart(5)}  ${t.tree}`);
  console.log("hot notes:");
  for (const n of h.notes.slice(0, 20))
    console.log(`  ${String(n.reads).padStart(5)}  ${n.path}  (last ${n.lastAt.slice(0, 10)})`);
  process.exit(0);
}

// Below the heat block: --heat never needs the O(searches²) label join.
const ls = labels(records);

if (hasFlag(argv, "json")) {
  console.log(JSON.stringify(ls, null, 2));
  process.exit(0);
}

if (!ls.length) {
  console.error("retrieval: no searches recorded yet");
  process.exit(0);
}

if (hasFlag(argv, "misses")) {
  // cli labels are shown-only where no read hook runs — their `used` is
  // unobserved, not empty, and listing them as misses would be a lie in a
  // report. answeredByList and seenRecently (#359) are excluded too: the
  // first is a name check the hit list itself answered, the second was
  // already in the reader's hands. What remains is the honest failure set.
  const misses = ls.filter((l) => l.via !== "cli" && l.outcome === "miss");
  if (!misses.length) {
    console.log("every observable search was acted on");
    process.exit(0);
  }
  for (const m of misses) {
    console.log(`${m.at}  ${m.via}  "${m.q}"`);
    console.log(
      m.shown.length ? `  showed: ${m.shown.slice(0, 5).join(", ")}` : "  showed: nothing"
    );
  }
  process.exit(0);
}

const s = summary(ls);
const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
// The honest rate (#359): acted over acted-plus-missed, with the two
// non-demand outcomes out of the denominator.
const honest = s.withUse + s.misses ? s.withUse / (s.withUse + s.misses) : 0;
console.log(`searches        ${s.searches}`);
console.log(`  acted on      ${s.withUse}  (${pct(s.hitRate)} of the observable ones)`);
console.log(`  answered by list ${s.answeredByList}  (name check; the hit list was the answer)`);
console.log(`  seen recently ${s.seenRecently}  (a hit was read just before the search)`);
console.log(`  missed        ${s.misses}  → honest hit rate ${pct(honest)}`);
console.log(`  relaxed       ${s.relaxed}  (zero-hit queries the any-term rung rescued)`);
console.log(`  showed nothing ${s.zeroResult}`);
console.log(`MRR             ${s.mrr.toFixed(2)}`);
console.log();
console.log(
  "`--misses` lists the searches nobody acted on; `--heat` counts reads per note; `--json` dumps every label."
);
