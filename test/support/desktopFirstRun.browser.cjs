// Built production base and Field served by the real supervisor, with no vault.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, rmSync, existsSync, realpathSync } = require('node:fs');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { chromium } = require('./browserHarness.cjs');

(async () => {
  const engine = realpathSync(resolve(__dirname, '../..'));
  const home = mkdtempSync(join(tmpdir(), 'bb-first-run-browser-'));
  const vault = join(home, 'new-vault');
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn('bun', [join(engine, 'bin/desktop.ts')], {
    cwd: home,
    env: { HOME: home, PATH: process.env.PATH, BIGBRAIN_VAULT: vault, BIGBRAIN_WEB_PORT: String(port), BIGBRAIN_DESKTOP: '1', BIGBRAIN_DEV: '1' },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  const exited = once(child, 'exit');
  let stderr = '', browser;
  child.stderr.on('data', data => { stderr += data; });
  try {
    const base = `http://127.0.0.1:${port}`;
    let identity;
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        const response = await fetch(`${base}/api/engine`, { signal: AbortSignal.timeout(500) });
        if (response.ok) { identity = await response.json(); break; }
      } catch { /* waiting for the supervisor */ }
      assert.equal(child.exitCode, null, stderr);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert(identity, `Setup door did not start: ${stderr}`);
    assert.equal(identity.engine, engine);
    assert.equal(identity.supervisor, child.pid);
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // Never mock /api/setup or /api/engine: these are the actual first-run routes.
    await page.goto(base);
    const wizard = page.getByRole('dialog', { name: 'Set up BigBrain' });
    await wizard.getByRole('heading', { name: 'Where should your vault live?', exact: true }).waitFor();
    await wizard.getByRole('button', { name: 'CREATE', exact: true }).click();
    await wizard.getByRole('button', { name: 'GO', exact: true }).waitFor();
    assert.equal(existsSync(vault), false);
    assert.deepEqual(errors, []);
    console.log('Real first-run supervisor identity and production base and Field setup passed.');
  } finally {
    if (browser) await browser.close();
    child.kill();
    await exited;
    rmSync(home, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
