const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5279';
    for (const width of [1440, 1864]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${base}/sidebar-workbench.html`);
      await page.waitForFunction(() => document.documentElement.dataset.sidebarWorkbench === 'closed');
      await page.keyboard.press('a');
      await page.locator('.pilot-row').first().waitFor();
      await page.locator('.pilot-row').filter({ hasText: 'Atlas planning' }).click();
      await page.locator('.pilot-panel .reading-column').waitFor();
      const chat = await page.locator('.pilot-panel .reading-column').boundingBox();
      await page.locator('.pilot-panel [contenteditable=true]').evaluate(el => el.blur());
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.documentElement.dataset.sidebarWorkbench === 'closed');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
      await page.locator('.settings > .content').waitFor();
      const content = await page.locator('.settings > .content').boundingBox();
      const rail = await page.locator('.settings > .rail').boundingBox();
      assert(Math.abs(content.x + content.width / 2 - width / 2) < 1, `settings centered at ${width}: ${JSON.stringify(content)}`);
      assert(Math.abs(content.x - chat.x) < 1, `settings/chat left edge at ${width}: ${JSON.stringify(content)} / ${JSON.stringify(chat)}`);
      assert(Math.abs(content.width - chat.width) < 1, `settings/chat width at ${width}: ${content.width} / ${chat.width}`);
      assert(rail.x + rail.width < content.x, 'rail fits in left gutter');
      await page.getByRole('button', { name: 'models', exact: true }).click();
      await page.getByText('Provider login', { exact: true }).waitFor();
      assert.equal(await page.locator('.providers > details').count(), 0);
      await page.screenshot({ path: join(tmpdir(), `bigbrain-settings-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 480, height: 900 });
    const narrow = await page.locator('.settings').evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    assert(narrow.scroll <= narrow.width, 'narrow settings do not overflow');
    const content = await page.locator('.settings > .content').boundingBox();
    const rail = await page.locator('.settings > .rail').boundingBox();
    assert(rail.y + rail.height <= content.y, 'narrow navigation moves above content');
    assert.deepEqual(errors, []);
    console.log('PASS: settings match actual chat width and centering at 1440/1864px; fixed provider rows and narrow navigation work.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
