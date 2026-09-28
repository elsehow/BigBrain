import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const { runTests } = require('../bin/ci-browser.cjs');

test('browser runner continues after failure, retains failed logs, and removes passing diagnostics', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'bb-ci-runner-'));
  const prefix = `runner-${process.pid}`;
  const failed = `${prefix}-failure`, passed = `${prefix}-success`;
  try {
    writeFileSync(join(fixture, 'failure.cjs'), "console.error('expected diagnostic'); process.exitCode = 1;");
    writeFileSync(join(fixture, 'success.cjs'), "console.log('next regression ran');");
    const results = await runTests([
      { name: failed, file: join(fixture, 'failure.cjs') },
      { name: passed, file: join(fixture, 'success.cjs') },
    ]);
    expect(results.map((result: { passed: boolean }) => result.passed)).toEqual([false, true]);
    expect(existsSync(resolve('artifacts/browser', failed, 'process.log'))).toBe(true);
    expect(existsSync(resolve('artifacts/browser', passed))).toBe(false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    for (const name of [failed, passed]) rmSync(resolve('artifacts/browser', name), { recursive: true, force: true });
  }
});

test('browser runner terminates a stalled test and reports a failure', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'bb-ci-timeout-'));
  const name = `runner-${process.pid}-timeout`;
  try {
    const file = join(fixture, 'stall.cjs');
    writeFileSync(file, 'setInterval(() => {}, 1000);');
    const [result] = await runTests([{ name, file }], { timeout: 200 });
    expect(result.passed).toBe(false);
    expect(result.timedOut).toBe(true);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(resolve('artifacts/browser', name), { recursive: true, force: true });
  }
});

test('suite budget records unfinished coverage and persists intermediate results', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'bb-ci-budget-'));
  const name = `runner-${process.pid}-budget`;
  const snapshots: number[] = [];
  try {
    const file = join(fixture, 'stall.cjs');
    writeFileSync(file, 'setInterval(() => {}, 1000);');
    const results = await runTests([
      { name, file },
      { name: `${name}-unrun`, file: join(fixture, 'must-not-start.cjs') },
    ], { totalTimeout: 200, onResult: (results: unknown[]) => snapshots.push(results.length) });
    expect(results[0].timedOut).toBe(true);
    expect(results[1].notRun).toBe(true);
    expect(results[1].passed).toBe(false);
    expect(snapshots).toEqual([1, 2]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(resolve('artifacts/browser', name), { recursive: true, force: true });
  }
});
