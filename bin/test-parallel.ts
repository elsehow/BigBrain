#!/usr/bin/env bun
/** The unit suite, split across one `bun test` process per CPU.
 * Plain `bun test` runs every file in one process, one after another, and
 * mostly waits (on subprocesses, servers, timers) — about 1 CPU busy for
 * the suite's ~100s. A process per FILE was tried and lost on a 4-vCPU
 * runner: every start re-transpiles its imports, doubling the suite's CPU,
 * and the CLI-spawning tests then missed their 5s budgets. So: a few
 * long-lived processes, files dealt out by their recorded durations
 * (test/timings.json; `--record` re-measures them, a file at a time). Each
 * gets its own preload scratch vault, and one still running after five
 * minutes is killed and the file it was in named, instead of holding the
 * job to its timeout. BIGBRAIN_TEST_JOBS sets the process count. */
import { availableParallelism } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_ROOT } from "../lib/engine";
import { testJobs } from "../lib/env";

const SHARD_TIMEOUT_MS = 300_000;
const TIMINGS = "test/timings.json";
// bun test's own discovery patterns.
const TEST_FILE = /(\.|_)(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;
// bun announces each file as `path:` (as `::group::path:` under Actions),
// and closes a failing run by repeating every failure under `N tests failed:`.
const FILE_HEADER = /^(?:::group::)?(\S+):$/;
const FAILURE_RECAP = /^\d+ tests? failed:$/;
// bun's 5s default per test is a hang detector, and a test that spawns the
// real CLI a few times can pass it alone yet miss it beside three busy
// shards. Hangs are SHARD_TIMEOUT_MS's job; a test's own timeout still wins.
const TEST_TIMEOUT_MS = 30_000;

function testFiles(root: string): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root });
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  return listed.stdout.toString().split("\n")
    .filter(f => TEST_FILE.test(f) && !f.split("/").includes("node_modules") && Bun.file(join(root, f)).size > 0);
}

/** Seconds per file from the last `--record`; a missing or broken file is {}. */
function readTimings(root: string): Record<string, number> {
  try { return JSON.parse(readFileSync(join(root, TIMINGS), "utf8")); }
  catch { return {}; }
}

/** Longest file first into the least-loaded shard. A file with no recorded
 * time (new since the last --record) counts as the median one. The 0.05s
 * floor is each file's share of start-up, and keeps the instant files from
 * all piling into one shard. */
function deal(files: string[], n: number, timings: Record<string, number>): string[][] {
  const known = Object.values(timings).sort((a, b) => a - b);
  const median = known[Math.floor(known.length / 2)] ?? 1;
  const weight = (f: string) => Math.max(0.05, timings[f] ?? median);
  const shards = Array.from({ length: n }, () => ({ files: [] as string[], load: 0 }));
  for (const f of [...files].sort((a, b) => weight(b) - weight(a))) {
    const lightest = shards.reduce((a, b) => (b.load < a.load ? b : a));
    lightest.files.push(f);
    lightest.load += weight(f);
  }
  return shards.map(s => s.files).filter(s => s.length);
}

/** Every file in its own process, `jobs` at a time, timed into TIMINGS. */
async function record(root: string, jobs: number): Promise<void> {
  const queue = testFiles(root);
  const timings: Record<string, number> = {};
  const failed: string[] = [];
  await Promise.all(Array.from({ length: jobs }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const r = await runShard(root, [f]);
      timings[f] = Math.round(r.ms / 100) / 10;
      if (!r.ok) failed.push(f);
    }
  }));
  const sorted = Object.fromEntries(Object.entries(timings).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(join(root, TIMINGS), `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`recorded ${Object.keys(sorted).length} files into ${TIMINGS}`);
  if (failed.length) {
    console.log(`failed while recording: ${failed.join(", ")}`);
    process.exit(1);
  }
}

type Result = { ok: boolean; output: string; ms: number; files: number; pass: number; fail: number; failed: string[]; hungIn?: string };

async function runShard(root: string, files: string[]): Promise<Result> {
  const started = performance.now();
  const child = Bun.spawn(["bun", "test", "--timeout", String(TEST_TIMEOUT_MS), ...files.map(f => `./${f}`)], { cwd: root, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, SHARD_TIMEOUT_MS);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  const output = stdout + stderr;
  // Attribute each `(fail)` to the file header above it.
  let current: string | undefined;
  const failed = new Set<string>();
  for (const line of output.split("\n")) {
    if (FAILURE_RECAP.test(line)) break;
    const header = FILE_HEADER.exec(line)?.[1];
    if (header && TEST_FILE.test(header)) current = header;
    else if (line.startsWith("(fail)") && current) failed.add(current);
  }
  const count = (word: string) => Number(output.match(new RegExp(`^\\s*(\\d+) ${word}$`, "m"))?.[1] ?? 0);
  return {
    ok: code === 0 && !timedOut, output, ms: performance.now() - started, files: files.length,
    pass: count("pass"), fail: count("fail"), failed: [...failed], hungIn: timedOut ? current ?? "(before any file)" : undefined,
  };
}

if (import.meta.main && process.argv.includes("--record")) {
  // One at a time unless told otherwise: parallel files time each other's contention.
  await record(ENGINE_ROOT, Math.max(1, testJobs() || 1));
} else if (import.meta.main) {
  const jobs = Math.max(1, testJobs() || availableParallelism());
  const started = performance.now();
  const shards = deal(testFiles(ENGINE_ROOT), jobs, readTimings(ENGINE_ROOT));
  const results = await Promise.all(shards.map(files => runShard(ENGINE_ROOT, files)));
  results.forEach((r, i) => {
    if (r.ok) return;
    console.log(`::group::FAIL shard ${i + 1}`);
    console.log(r.output);
    if (r.hungIn) console.log(`shard still running after ${SHARD_TIMEOUT_MS / 1000}s, in ${r.hungIn}; killed`);
    console.log("::endgroup::");
  });
  const sum = (k: "pass" | "fail" | "files") => results.reduce((n, r) => n + r[k], 0);
  console.log(`\nshards: ${results.map(r => `${r.files} files ${(r.ms / 1000).toFixed(1)}s`).join(" | ")}`);
  console.log(`\n ${sum("pass")} pass\n ${sum("fail")} fail\nRan ${sum("files")} files in ${((performance.now() - started) / 1000).toFixed(1)}s on ${results.length} processes.`);
  const failed = results.flatMap(r => [...r.failed, ...(r.hungIn ? [`${r.hungIn} (hung)`] : [])]);
  if (results.some(r => !r.ok)) {
    console.log(`\nfailed: ${failed.length ? failed.join(", ") : "see shard output above"}`);
    process.exit(1);
  }
}
