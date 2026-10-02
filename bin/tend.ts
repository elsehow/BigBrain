#!/usr/bin/env bun
/**
 * tend.ts — `bigbrain tend`: run the gardener once (#514). The scheduled
 * `tend` unit ticks this every 5m; the due-check decides, and a not-due
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
import { runTend, tendDue, tendHasWork } from "../lib/tend";
import { refreshSharedMemory } from "../lib/sharedMemory";

const argv = process.argv.slice(2);
const force = hasFlag(argv, "force");
const json = hasFlag(argv, "json");

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
await refreshSharedMemory(root).catch(() => {});

const due = tendDue(root);
if (!tendHasWork(due) && !force) {
  if (json) console.log(JSON.stringify({ ran: false, reason: "nothing due" }));
  else console.log("tend: nothing due");
  process.exit(0);
}

const result = await runTend({ root, manifest, force, ...(maxRounds ? { maxRounds } : {}) });

if (result.error) {
  if (json) console.log(JSON.stringify(result, null, 2));
  console.error(`tend: ${result.error}`);
  process.exit(1);
}
if (json) console.log(JSON.stringify(result, null, 2));
else if (!result.ran) console.log(`tend: ${result.reason}`);
else {
  for (const r of result.rounds)
    console.log(
      `tend: round ${r.runId} — ${r.settled} settled, ${r.remaining} remaining` +
        (r.usage ? ` ($${(r.usage.cost_usd?.toFixed(4) ?? "unavailable")}, ${r.usage.turns} turns)` : "") +
        (r.error ? ` — ERROR: ${r.error}` : "")
    );
  if (result.memory)
    console.log(
      `tend: memory — ${result.memory.ran ? "ran" : "declined"}${result.memory.error ? ` — ERROR: ${result.memory.error}` : ""}`
    );
  if (!result.rounds.length && !result.memory) console.log("tend: nothing due");
}

const failed =
  (result.ran && result.rounds.some((r) => r.error)) || Boolean(result.memory?.error);
if (failed) process.exitCode = 1;
