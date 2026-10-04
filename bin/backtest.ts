#!/usr/bin/env bun
/**
 * backtest.ts — `bigbrain backtest goals`: run the goal chain over a vault's
 * past as if it were live (lib/backtest.ts, #51).
 *
 *   bigbrain backtest goals --vault <path> --out <dir> [--through YYYY-MM-DD] [--picture single|agent]
 *
 * `--vault` is READ, never written: its arrivals and recorded goal events are
 * replayed into a fresh sandbox vault at `<out>/vault`. Both paths are explicit
 * on purpose — this command never resolves the vault on its own, because the
 * supervisor exports the real one into every child's environment.
 */

import { mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { backtestGoals } from "../lib/backtest";
import { flagValue } from "../lib/cliflags";
import { ENGINE_ROOT } from "../lib/engine";
import { pictureRecords } from "../lib/goalChain";

const argv = process.argv.slice(2);
const usage = "usage: bigbrain backtest goals --vault <path> --out <dir> [--through YYYY-MM-DD] [--picture single|agent]";
const vault = flagValue(argv, "vault");
const out = flagValue(argv, "out");
const picture = flagValue(argv, "picture");
if (argv[0] !== "goals" || !vault || !out || (picture && picture !== "single" && picture !== "agent")) {
  console.error(usage);
  process.exit(2);
}
if (!relative(resolve(ENGINE_ROOT), resolve(out)).startsWith("..")) {
  console.error("backtest: --out must be outside the engine checkout; a real vault's output never goes in the repo");
  process.exit(2);
}

const result = await backtestGoals({
  source: vault, out,
  through: flagValue(argv, "through") ?? new Date().toISOString().slice(0, 10),
  ...(picture ? { pictureMode: picture as "single" | "agent" } : {}),
  onWindow: (lines) => { for (const line of lines) console.log(line); },
});

// Each picture as its own file, in order, for reading side by side.
const dir = join(resolve(out), "pictures");
mkdirSync(dir, { recursive: true });
const records = pictureRecords(result.sandbox);
records.forEach((r, i) => {
  const name = `${String(i).padStart(2, "0")}_${r.covers.from.slice(0, 10)}.md`;
  Bun.write(join(dir, name), `${r.picture}\n`);
});
console.log(`backtest: ${records.length} picture(s) in ${dir}; ${result.superseded} superseded arrival(s) marked${result.stopped ? ` — stopped: ${result.stopped}` : ""}`);
if (result.stopped) process.exitCode = 1;
