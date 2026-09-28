const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5217';
    for (const path of ['sidebar-workbench.html', 'dev.html?c=briefings&s=ready&preview=1', 'type-app.html', 'context-demo.html', 'inbox-demo.html', 'meeting-demo.html']) {
      await page.goto(`${base}/${path}`);
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-sidebar-workbench'));
      await page.locator('#main').waitFor();
      const badge = await page.getByLabel('Preview source').textContent();
      assert.match(badge, /PREVIEW · \d+\.\d+\.\d+ · [a-f0-9]+/);
      assert.match(badge, /cached origin\/main/);
      await page.waitForTimeout(300);
      assert.deepEqual(errors, [], path);
    }
    // Historical layout studies remain explicit, visibly labeled comparisons.
    await page.goto(`${base}/left-sidebar.html`);
    assert.match(await page.getByLabel('Preview source').textContent(), /^VISUAL STUDY/);
    assert.deepEqual(errors, []);
    console.log('PASS: all full-app preview entries mount the desktop shell and show source provenance; legacy study is labeled.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
