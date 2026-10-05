#!/usr/bin/env bun
/** The unit suite, one `bun test` process per file across a worker pool.
 * Plain `bun test` runs every file in one process, one after another, and
 * mostly waits (on subprocesses, servers, timers) — about 1 CPU busy for
 * the suite's ~100s. A file per process also gets its own preload scratch
 * vault and its own globals, and a file that hangs is killed and named
 * instead of eating the job's timeout. BIGBRAIN_TEST_JOBS sets the pool. */
import { availableParallelism } from "node:os";
import { statSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_ROOT } from "../lib/engine";
import { testJobs } from "../lib/env";

const FILE_TIMEOUT_MS = 180_000;
// bun test's own discovery patterns.
const TEST_FILE = /(\.|_)(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;

function testFiles(root = ENGINE_ROOT): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root });
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  return listed.stdout.toString().split("\n")
    .filter(f => TEST_FILE.test(f) && !f.split("/").includes("node_modules"))
    // Largest first, so the long files start early and the short ones fill in.
    .map(f => ({ f, size: statSync(join(root, f), { throwIfNoEntry: false })?.size ?? -1 }))
    .filter(({ size }) => size >= 0)
    .sort((a, b) => b.size - a.size)
    .map(({ f }) => f);
}

type Result = { file: string; ok: boolean; output: string; ms: number; pass: number; fail: number; timedOut: boolean };

async function runFile(root: string, file: string): Promise<Result> {
  const started = performance.now();
  const child = Bun.spawn(["bun", "test", `./${file}`], { cwd: root, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, FILE_TIMEOUT_MS);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  const output = stdout + stderr;
  const count = (word: string) => Number(output.match(new RegExp(`^\\s*(\\d+) ${word}$`, "m"))?.[1] ?? 0);
  return { file, ok: code === 0 && !timedOut, output, ms: performance.now() - started, pass: count("pass"), fail: count("fail"), timedOut };
}

async function runSuite(root = ENGINE_ROOT, jobs = availableParallelism()): Promise<Result[]> {
  const queue = testFiles(root);
  const results: Result[] = [];
  const worker = async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const r = await runFile(root, file);
      results.push(r);
      if (!r.ok) {
        console.log(`::group::FAIL ${file}`);
        console.log(r.timedOut ? `${file} still running after ${FILE_TIMEOUT_MS / 1000}s; killed\n${r.output}` : r.output);
        console.log("::endgroup::");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
  return results;
}

if (import.meta.main) {
  const jobs = testJobs() || availableParallelism();
  const started = performance.now();
  const results = await runSuite(ENGINE_ROOT, jobs);
  const failed = results.filter(r => !r.ok);
  const sum = (k: "pass" | "fail") => results.reduce((n, r) => n + r[k], 0);
  console.log("\nslowest files:");
  for (const r of [...results].sort((a, b) => b.ms - a.ms).slice(0, 5)) console.log(`  ${(r.ms / 1000).toFixed(1)}s ${r.file}`);
  console.log(`\n ${sum("pass")} pass\n ${sum("fail")} fail\nRan ${results.length} files in ${((performance.now() - started) / 1000).toFixed(1)}s on ${jobs} workers.`);
  if (failed.length) {
    console.log(`\nfailed: ${failed.map(r => r.file + (r.timedOut ? " (timed out)" : "")).join(", ")}`);
    process.exit(1);
  }
}
