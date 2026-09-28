/** Production UI regression: no backend, vault, or real desktop updater.
 * Build web/ui first. PLAYWRIGHT_MODULE may point to an installed Playwright.
 * Runs Chromium and WebKit; delayed graph loading must not block the banner.
 */
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dist = path.resolve(__dirname, '../../web/ui/dist');
const origin = 'http://127.0.0.1:53919';

async function check(engine, name) {
  const browser = await engine.launch({ headless: true, ...(name === 'Chromium' ? { channel: 'chrome' } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    let releaseGraph;
    const graphReady = new Promise(resolve => { releaseGraph = resolve; });
    await page.addInitScript(() => {
      window.installAttempts = 0;
      window.__TAURI__ = { core: { invoke: async command => {
        if (command === 'update_check') return { version: '99.0.0', notes: 'Test update' };
        if (command === 'update_install') { window.installAttempts++; throw new Error('Intercepted test installation'); }
        if (command === 'window_is_maximized') return true;
        return null;
      } } };
      window.EventSource = class extends EventTarget { close() {} };
    });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(dist, 'index.html')) });
      if (url.pathname.startsWith('/assets/')) return route.fulfill({
        contentType: url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.woff2') ? 'font/woff2' : 'text/javascript',
        body: fs.readFileSync(path.join(dist, 'assets', path.basename(url.pathname))),
      });
      if (url.pathname === '/api/graph') {
        await graphReady;
        return route.fulfill({ json: { hash: 'update-banner', nodes: [
          { id: 'a', title: 'Alpha', group: 'entity', degree: 1, x: -100, y: 0 },
          { id: 'b', title: 'Beta', group: 'entity', degree: 1, x: 100, y: 0 },
        ], edges: [{ source: 'a', target: 'b' }] } });
      }
      if (['/api/pilot/chat', '/api/pilot/work'].includes(url.pathname)) return route.fulfill({ json: { sessions: [] } });
      if (url.pathname === '/api/source/read-state') return route.fulfill({ json: { sources: [], scope: 'stored_sources' } });
      if (url.pathname === '/api/recent') return route.fulfill({ json: { recent: [], nextOffset: null } });
      if (url.pathname === '/api/vault') return route.fulfill({ json: { queue: {}, view: { entities: 2, references: 0 }, inbox: { pending: 0, unsorted: 0 }, requests: { open: 0, done: 0 } } });
      return route.fulfill({ status: 404, json: { error: 'Disabled in banner test' } });
    });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const update = page.getByRole('button', { name: 'Update & relaunch', exact: true });
    await update.waitFor();
    const bar = page.locator('#topbar');
    const hitTarget = button => button.evaluate(el => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    });
    async function hideBar() {
      await page.mouse.move(700, 500);
      await page.waitForTimeout(320);
      assert.equal(await bar.evaluate(el => getComputedStyle(el).opacity), '0');
      assert.equal(await bar.evaluate(el => getComputedStyle(el).pointerEvents), 'none');
    }
    await hideBar();
    assert(await hitTarget(update), `${name}: update hit target before graph load`);
    await update.click();
    await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.installAttempts), 1);
    releaseGraph();
    await page.locator('.lg-wrap > canvas:not([aria-hidden])').waitFor();
    await hideBar();
    const retry = page.getByRole('button', { name: 'Try again', exact: true });
    assert(await hitTarget(retry), `${name}: update hit target after graph load`);
    // The banner shifts the lower search field beyond the old 92px boundary.
    await page.mouse.move(700, 10);
    await page.waitForTimeout(320);
    const box = await bar.boundingBox();
    assert(box.y + box.height - 8 > 92);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 8);
    await page.waitForTimeout(320);
    assert.equal(await bar.evaluate(el => getComputedStyle(el).opacity), '1', `${name}: lower bar retains hover`);
    // The banner stays on top during the bar's upward slide, not just at rest.
    await page.mouse.move(700, 500);
    assert(await hitTarget(retry), `${name}: update hit target during transition`);
    await retry.click();
    await page.waitForFunction(() => window.installAttempts === 2);
    await page.getByRole('button', { name: 'Not now', exact: true }).click();
    await page.locator('.nudge').waitFor({ state: 'detached' });
    await page.mouse.move(700, 500);
    await page.keyboard.press('/');
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'combobox');
    assert.deepEqual(errors, []);
    console.log(`${name}: update/retry/dismiss clicks, delayed graph load, hover bounds, transition stacking, and keyboard search pass.`);
  } finally { await browser.close(); }
}
(async () => { await check(chromium, 'Chromium'); await check(webkit, 'WebKit'); })().catch(error => { console.error(error); process.exitCode = 1; });
