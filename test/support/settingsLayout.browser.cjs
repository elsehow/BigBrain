// Settings, as Field shows them: a panel over the field. The models page keeps
// fixed provider rows, and a narrow window does not overflow.
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
      await page.locator('.v2').waitFor();
      await page.keyboard.press('ControlOrMeta+,');
      await page.locator('aside.panel .settings > .content').waitFor();
      const content = await page.locator('.settings > .content').boundingBox();
      const rail = await page.locator('.settings > .rail').boundingBox();
      assert(rail.x + rail.width <= content.x, `rail sits left of the content at ${width}`);
      await page.getByRole('button', { name: 'models', exact: true }).click();
      await page.getByText('Provider login', { exact: true }).waitFor();
      assert.equal(await page.locator('.providers > details').count(), 0);
      await page.screenshot({ path: join(tmpdir(), `bigbrain-settings-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 480, height: 900 });
    const narrow = await page.locator('.settings').evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    assert(narrow.scroll <= narrow.width, 'narrow settings do not overflow');
    assert.deepEqual(errors, []);
    console.log('PASS: settings sit in Field\'s panel at 1440/1864px; fixed provider rows; narrow settings do not overflow.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
