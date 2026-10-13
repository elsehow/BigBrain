#!/usr/bin/env bun
/**
 * tend.ts — `bigbrain tend`: run every chain with work once (#514, #51). The
 * supervisor ticks each chain with `--chain <job>` on that job's cadence
 * (lib/desktopSchedule.ts; the classic chain's job is `tend`, every 5m); the due-check decides, and a not-due
 * tick exits in milliseconds before any model call. Also the manual verb —
 * `bigbrain tend` after a drop burst, `--force` for the first-ever memory
 * run (a vault with no stamp is never auto-due).
 *
 * Exit 0: ran, nothing due, or another gardener holds the lock (normal
 * contention beside an interactive tend — one line, no error). Exit 1: a
 * round failed or the memory pass errored (journaled either way).
 */

import { flagValue, hasFlag } from "../lib/cliflags";
import { loadManifest } from "../lib/manifest";
import { VAULT_ROOT } from "../lib/vaultRoot";
import { chainHasWork } from "../lib/chain";
import { chainOfJob, CHAINS } from "../lib/chains";
import { tryHold, type Hold } from "../lib/sqliteLock";
import { join } from "node:path";
import { refreshSharedMemory } from "../lib/sharedMemory";

const argv = process.argv.slice(2);
const force = hasFlag(argv, "force");
const json = hasFlag(argv, "json");
// --chain <job>: the supervisor's tick of one chain (lib/chains.ts), on that
// job's cadence. Without it, every chain with work runs.
const only = hasFlag(argv, "chain") ? chainOfJob(flagValue(argv, "chain") ?? "") : undefined;
if (hasFlag(argv, "chain") && !only) {
  console.error(`tend: --chain wants one of ${CHAINS.map((c) => c.job).join(", ")}`);
  process.exit(2);
}

// --rounds N (#480): the interactive /bigbrain:tend and the SessionEnd
// bounded batch cap how many `claude -p` sessions one run may spawn. The
// runner's TEND_MAX_ROUNDS stays the scheduled tick's default.
let maxRounds: number | undefined;
if (hasFlag(argv, "rounds")) {
  const n = Number(flagValue(argv, "rounds"));
  if (!Number.isInteger(n) || n < 1) {
    console.error("tend: --rounds wants a positive integer");
    process.exit(2);
  }
  maxRounds = n;
}

const root = VAULT_ROOT;
const manifest = loadManifest(root);

// Memory folds every vault the user can read. The shared ones answer over
// HTTP, so read them once, here, into the cache the due check, the queue
// view and the run all share (lib/sharedMemory.ts). Unreachable is not an
// error: their last view stands.
if (!only || only === CHAINS[0]) await refreshSharedMemory(root).catch(() => {});

// Every registered chain is asked; the ones with work run side by side, each
// on its own lock. The first chain (classic) keeps its result at the top of
// --json; any other chain's rides under `chains`. The classic chain holds
// its own lock; another holds one here, so a manual tend and the
// supervisor's tick of it never run it twice.
const asked = only ? [only] : CHAINS;
const held: Hold[] = [];
const due = asked.filter((chain) => {
  if (!(force || chainHasWork(chain.due(root)))) return false;
  if (chain === CHAINS[0]) return true;
  const hold = tryHold(join(root, ".state", `chain-${chain.name}.lock.sqlite`), { name: chain.name });
  if (hold) held.push(hold);
  return !!hold;
});
if (!due.length) {
  if (json) console.log(JSON.stringify({ ran: false, reason: "nothing due" }));
  else console.log("tend: nothing due");
  process.exit(0);
}

const runs = await Promise.all(due.map(async (chain) => {
  const result = await chain.run({ root, manifest, force, ...(maxRounds ? { maxRounds } : {}) });
  return { chain, result, report: chain.report(result) };
})).finally(() => { for (const hold of held) hold.release(); });

if (json) {
  const [primary] = CHAINS;
  const top = runs.find((r) => r.chain === primary)?.result ?? { ran: false, reason: "nothing due" };
  const others = runs.filter((r) => r.chain !== primary);
  console.log(JSON.stringify({
    ...(top as object),
    ...(others.length ? { chains: Object.fromEntries(others.map((r) => [r.chain.name, r.result])) } : {}),
  }, null, 2));
}
for (const { report } of runs) {
  if (report.error) console.error(report.error);
  else if (!json) for (const line of report.lines) console.log(line);
}
if (runs.some((r) => r.report.error)) process.exit(1);
if (runs.some((r) => r.report.failed)) process.exitCode = 1;
