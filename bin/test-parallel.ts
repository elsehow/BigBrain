#!/usr/bin/env bun
/** The unit suite, split across one `bun test` process per CPU.
 * Plain `bun test` runs every file in one process, one after another, and
 * mostly waits (on subprocesses, servers, timers) — about 1 CPU busy for
 * the suite's ~100s. A process per FILE was tried and lost on a 4-vCPU
 * runner: every start re-transpiles its imports, doubling the suite's CPU,
 * and the CLI-spawning tests then missed their 5s budgets. So: a few
 * long-lived processes, files dealt out by size. Each gets its own preload
 * scratch vault, and one still running after five minutes is killed and
 * the file it was in named, instead of holding the job to its timeout.
 * BIGBRAIN_TEST_JOBS sets the process count. */
import { availableParallelism } from "node:os";
import { statSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_ROOT } from "../lib/engine";
import { testJobs } from "../lib/env";

const SHARD_TIMEOUT_MS = 300_000;
// bun test's own discovery patterns.
const TEST_FILE = /(\.|_)(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;
// bun announces each file as `path:` (as `##[group]path:` under Actions).
const FILE_HEADER = /^(?:##\[group\])?(\S+):$/;

function testFiles(root: string): { file: string; size: number }[] {
  const listed = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root });
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  return listed.stdout.toString().split("\n")
    .filter(f => TEST_FILE.test(f) && !f.split("/").includes("node_modules"))
    .map(file => ({ file, size: statSync(join(root, file), { throwIfNoEntry: false })?.size ?? -1 }))
    .filter(({ size }) => size >= 0);
}

/** Largest file first into the lightest shard — size stands in for runtime. */
function deal(files: { file: string; size: number }[], n: number): string[][] {
  const shards = Array.from({ length: n }, () => ({ files: [] as string[], size: 0 }));
  for (const f of [...files].sort((a, b) => b.size - a.size)) {
    const lightest = shards.reduce((a, b) => (b.size < a.size ? b : a));
    lightest.files.push(f.file);
    lightest.size += f.size;
  }
  return shards.map(s => s.files).filter(s => s.length);
}

type Result = { ok: boolean; output: string; ms: number; files: number; pass: number; fail: number; failed: string[]; hungIn?: string };

async function runShard(root: string, files: string[]): Promise<Result> {
  const started = performance.now();
  const child = Bun.spawn(["bun", "test", ...files.map(f => `./${f}`)], { cwd: root, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, SHARD_TIMEOUT_MS);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  const output = stdout + stderr;
  // Attribute each `(fail)` to the file header above it.
  let current: string | undefined;
  const failed = new Set<string>();
  for (const line of output.split("\n")) {
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

if (import.meta.main) {
  const jobs = Math.max(1, testJobs() || availableParallelism());
  const started = performance.now();
  const results = await Promise.all(deal(testFiles(ENGINE_ROOT), jobs).map(files => runShard(ENGINE_ROOT, files)));
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
