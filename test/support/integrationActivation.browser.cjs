// Run after `cd web/ui && bun run build:integrations`.
// Exercises the ACTUAL static entry, not a test-only mount that can mask init bugs.
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve('web/ui/dist-integrations');

(async () => {
  const served = [];
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    served.push(pathname);
    try {
      const filename = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      assert.ok(filename.startsWith(root + path.sep));
      const bytes = await readFile(filename);
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mjs': 'text/javascript' }[path.extname(filename)];
      res.writeHead(200, { 'content-type': type || 'application/octet-stream' }); res.end(bytes);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : { channel: 'chrome' }), headless: true,
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [], violations = [], unexpected = [];
    const origin = `http://127.0.0.1:${server.address().port}`;
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', msg => { if (msg.type() === 'error' && /Content Security Policy/.test(msg.text())) violations.push(msg.text()); });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || !(url.pathname === '/index.html' || url.pathname.startsWith('/assets/'))) {
        unexpected.push(url.href); return route.abort();
      }
      return route.continue();
    });
    await page.goto(`${origin}/index.html?scene=inactive&theme=default`);
    const granola = page.getByRole('region', { name: 'Granola', exact: true });
    const activate = granola.getByRole('button', { name: 'Activate', exact: true });
    await activate.waitFor();
    assert.equal(await page.locator('.rail-row.on').innerText(), 'integrations');
    assert.equal(await page.locator('html').getAttribute('data-sidebar-settings'), 'true');
    assert.equal(await page.locator('#main > .settings > .rail').count(), 1);
    assert.equal(await page.locator('.waiting').count(), 0);
    await activate.focus(); await page.keyboard.press('Enter');
    await granola.getByRole('button', { name: 'Connect Granola' }).click();
    assert.equal(await granola.getByText('Inactive', { exact: true }).count(), 1);
    await granola.getByRole('button', { name: 'Cancel', exact: true }).click();
    await activate.click();
    await granola.getByRole('button', { name: 'Connect Granola' }).click();
    await granola.getByRole('button', { name: 'Allow access' }).click();
    const rule = page.getByLabel('Granola remembering rule');
    await rule.fill('');
    assert.equal(await page.getByRole('button', { name: 'Finish & activate' }).isDisabled(), true);
    await rule.fill('Remember new full transcripts.');
    await granola.getByRole('button', { name: 'Back', exact: true }).click();
    assert.equal(await granola.getByText('Inactive', { exact: true }).count(), 1);
    await granola.getByRole('button', { name: 'Connect Granola' }).click();
    await granola.getByRole('button', { name: 'Allow access' }).click();
    assert.equal(await rule.inputValue(), 'Remember new full transcripts.');
    await granola.getByRole('button', { name: 'Finish & activate' }).click();
    await granola.getByText('Active', { exact: true }).waitFor();
    await granola.getByRole('button', { name: 'Deactivate' }).click();
    await activate.click();
    await granola.getByRole('button', { name: 'Connect Granola' }).click();
    await granola.getByRole('button', { name: 'Allow access' }).click();
    assert.equal(await rule.inputValue(), 'Remember new full transcripts.');
    // Leaving settings cancels incomplete setup, and real theme selection still works.
    await page.locator('.rail-row').filter({ hasText: /^general$/ }).click();
    await page.getByRole('button', { name: 'nurebairo', exact: true }).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dusk');
    await page.locator('.rail-row').filter({ hasText: /^integrations$/ }).click();
    await activate.waitFor();
    assert.equal(await granola.getByText('Inactive', { exact: true }).count(), 1);
    assert.equal(await page.getByLabel('Granola remembering rule').count(), 0);
    await page.goto(`${origin}/index.html?scene=inactive&auth=fail&theme=dusk`);
    await activate.click();
    await granola.getByRole('button', { name: 'Connect Granola' }).click();
    await granola.getByRole('alert').waitFor();
    assert.equal(await granola.getByText('Inactive', { exact: true }).count(), 1);
    await granola.getByRole('button', { name: 'Try again' }).click();
    await granola.getByRole('button', { name: 'Allow access' }).click();
    await granola.getByRole('button', { name: 'Finish & activate' }).click();
    await granola.getByText('Active', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    const tracks = page.getByRole('region', { name: 'That Tracks', exact: true });
    await tracks.getByRole('button', { name: 'Activate', exact: true }).click();
    await tracks.getByRole('button', { name: 'Connect That Tracks' }).click();
    await tracks.getByRole('button', { name: 'Allow access' }).click();
    const previewWidth = await page.locator('.settings').evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    assert.ok(previewWidth.scroll <= previewWidth.client);
    await tracks.getByRole('button', { name: 'Finish & activate' }).click();
    await tracks.getByText('Active · Proposed', { exact: true }).waitFor();
    // The unmodified production rail is fixed-width even at phone sizes.
    // Measure General too: don't silently import a custom shell fix into this study.
    await page.locator('.rail-row').filter({ hasText: /^general$/ }).click();
    await page.getByRole('region', { name: 'Themes', exact: true }).waitFor();
    const generalWidth = await page.locator('.settings').evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    console.log('390px shell measurements:', { integrations: previewWidth, productionGeneral: generalWidth });
    await page.setViewportSize({ width: 800, height: 900 });
    await page.locator('.rail-row').filter({ hasText: /^integrations$/ }).click();
    await tracks.getByText('Active · Proposed', { exact: true }).waitFor();
    assert.equal(await page.locator('.settings').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    assert.deepEqual(errors, []);
    assert.deepEqual(violations, []);
    assert.deepEqual(unexpected, []);
    assert.ok(served.every(url => url === '/index.html' || url.startsWith('/assets/')));
    console.log('PASS: real static entry/AppShell/Integrations; keyboard activation, cancel/back/blank/failure gates, retry, deactivation/re-entry, theme picker, narrow That Tracks; static assets only, no runtime errors/CSP violations.');
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
