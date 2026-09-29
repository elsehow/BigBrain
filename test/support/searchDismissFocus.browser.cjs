// Production AppShell: a deferred search re-focus must not undo Escape (#7).
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5200';
(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/sidebar-workbench.html`);
    await page.locator('canvas').first().waitFor();
    const focused = () => page.evaluate(() => document.activeElement?.matches('#topbar input') ?? false);
    const closed = () => page.waitForFunction(() => document.documentElement.dataset.sidebarWorkbench === 'closed', null, { timeout: 5000 });
    for (let round = 0; round < 3; round++) {
      // A slow frame, as on a loaded CI runner: rAF callbacks land 250ms late.
      await page.evaluate(() => {
        const raf = window.requestAnimationFrame.bind(window), caf = window.cancelAnimationFrame.bind(window), late = new Map();
        let next = 1e9; window.__raf = [raf, caf];
        window.requestAnimationFrame = cb => { const id = ++next; late.set(id, setTimeout(() => { late.delete(id); raf(cb); }, 250)); return id; };
        window.cancelAnimationFrame = id => { if (late.has(id)) { clearTimeout(late.get(id)); late.delete(id); } else caf(id); };
      });
      await page.keyboard.press('/');
      await page.getByRole('combobox', { name: 'Search the vault' }).fill('Atlas');
      assert.equal(await focused(), true);
      await page.keyboard.press('Escape');
      assert.equal(await focused(), false, 'Escape blurs the search');
      await page.waitForTimeout(400);
      assert.equal(await focused(), false, 'a late focus frame must not re-take the input');
      await page.evaluate(() => { [window.requestAnimationFrame, window.cancelAnimationFrame] = window.__raf; });
      await page.keyboard.press('Escape');
      await closed();
    }
    assert.deepEqual(errors, []);
    console.log('PASS: Escape dismissal survives a delayed search focus frame in AppShell');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
