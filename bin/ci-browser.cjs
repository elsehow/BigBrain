// One manifest and invocation for PR and compatibility coverage. No retries.
const { spawn } = require('node:child_process');
const { mkdirSync, rmSync, writeFileSync, appendFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { createServer } = require('node:net');
const { once } = require('node:events');
const suite = require('../test/browser-suite.json');
const root = resolve(__dirname, '..');
const artifacts = join(root, 'artifacts/browser');
const children = new Set();

function stop(child) {
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
}
function launch(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  for (const child of children) stop(child);
  process.exit(signal === 'SIGINT' ? 130 : 143);
});

async function runTests(tests, { env = process.env, timeout = 300_000, totalTimeout = Infinity, annotate = false, onResult = () => {} } = {}) {
  const results = [];
  const deadline = Date.now() + totalTimeout;
  for (const { name, file } of tests) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      results.push({ name, passed: false, timedOut: true, notRun: true, durationMs: 0 });
      onResult(results);
      console.error(`${name} not run: suite time budget exhausted`);
      continue;
    }
    const limit = Math.min(timeout, remaining);
    const directory = join(artifacts, name);
    mkdirSync(directory, { recursive: true });
    const started = Date.now();
    console.log(`::group::${name}`);
    const child = launch(process.execPath, [file], { env: { ...env, CI_BROWSER_ARTIFACTS: directory } });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
      process.stdout.write(data);
      appendFileSync(join(directory, 'process.log'), data);
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stop(child); }, limit);
    const killTimer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
    }, limit + 5000);
    let code;
    try { [code] = await once(child, 'close'); }
    finally { clearTimeout(timer); clearTimeout(killTimer); }
    const passed = code === 0 && !timedOut;
    results.push({ name, passed, timedOut, durationMs: Date.now() - started });
    onResult(results);
    if (passed) rmSync(directory, { recursive: true, force: true });
    else console.error(`${annotate ? `::error file=${file}::` : ''}${name} ${timedOut ? 'timed out' : 'failed'}; see failure artifacts`);
    console.log('::endgroup::');
  }
  return results;
}

async function main() {
  const requested = process.argv.slice(2);
  if (requested.includes('--list')) { console.log(suite.join('\n')); return; }
  if (requested.some(name => !suite.includes(name))) throw new Error(`Unknown suite member: ${requested.join(', ')}`);
  const names = requested.length ? requested : suite;
  rmSync(artifacts, { recursive: true, force: true });
  mkdirSync(artifacts, { recursive: true });
  // Allocate a loopback port so local runs can coexist with other worktrees.
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(done => probe.close(done));
  const base = `http://127.0.0.1:${port}`;
  const server = launch('bun', ['run', '--cwd', 'web/ui', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort']);
  const serverClosed = once(server, 'close');
  for (const stream of [server.stdout, server.stderr]) stream.on('data', data => appendFileSync(join(artifacts, 'server.log'), data));
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw new Error('Preview server exited before readiness; see server.log');
      try { ready = (await fetch(`${base}/sidebar-workbench.html`, { signal: AbortSignal.timeout(500) })).ok; } catch { /* starting */ }
      if (ready) break;
      await new Promise(done => setTimeout(done, 100));
    }
    if (!ready) throw new Error('Preview server did not become ready; see server.log');
    const results = await runTests(names.map(name => ({ name, file: join(root, 'test/support', `${name}.browser.cjs`) })), {
      env: { ...process.env, ...(process.platform === 'linux' ? { CI_BROWSER_REDUCED_MOTION: 'reduce' } : {}), SIDEBAR_PREVIEW_URL: base, VIEWER_URL: base },
      totalTimeout: (process.platform === 'linux' ? 18 : 7) * 60_000,
      annotate: true,
      onResult: results => writeFileSync(join(artifacts, 'results.json'), JSON.stringify(results, null, 2)),
    });
    writeFileSync(join(artifacts, 'results.json'), JSON.stringify(results, null, 2));
    console.table(results);
    if (results.some(result => !result.passed)) process.exitCode = 1;
  } finally {
    stop(server);
    const timer = setTimeout(() => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* exited */ } }, 5000);
    await serverClosed;
    clearTimeout(timer);
  }
}
module.exports = { runTests };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
