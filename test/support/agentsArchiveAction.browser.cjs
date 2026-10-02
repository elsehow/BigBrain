// Archive from the production Agents list against the fabricated workbench API.
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5246'}/sidebar-workbench.html`);
    // The toolbar hides after 2.5s idle, and a slow CI start can outlast that: exercise
    // the idle state, then reveal it as a user does (pointer input) before clicking.
    const agents = page.getByRole('button', { name: 'Agents', exact: true });
    await page.waitForFunction(() => document.documentElement.dataset.sidebarToolbar === 'false');
    const box = await agents.boundingBox();
    assert(box, 'Agents trigger is laid out');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await agents.focus();
    await agents.click();
    const rows = page.locator('.pilot-row');
    await rows.first().waitFor();
    const count = await rows.count();
    const id = await rows.first().getAttribute('data-pilot');
    await rows.first().focus();
    await page.evaluate(() => {
      const original = window.fetch.bind(window);
      window.archiveMode = 'fail'; window.archiveCalls = 0;
      window.fetch = async (input, init) => {
        if (String(input).includes('/api/pilot/chat/stop-tree')) {
          window.archiveCalls++;
          if (window.archiveMode === 'fail') return new Response(JSON.stringify({ error: 'Archive unavailable' }), { status: 503 });
          await new Promise(resolve => { window.releaseArchive = resolve; });
        }
        return original(input, init);
      };
    });
    await page.keyboard.press('Shift+Escape');
    await page.locator('.pilots-pane').getByRole('alert').filter({ hasText: 'Archive unavailable' }).waitFor();
    assert.equal(await rows.count(), count, 'failure retains the row');
    assert.equal(await page.locator('.pilot-row.selected').getAttribute('data-pilot'), id);
    await page.evaluate(() => { window.archiveMode = 'success'; });
    await page.keyboard.press('Shift+Escape');
    await page.waitForFunction(() => !!window.releaseArchive);
    await page.keyboard.press('Shift+Escape');
    assert.equal(await rows.count(), count, 'pending archive remains visible');
    assert.equal(await page.evaluate(() => window.archiveCalls), 2, 'duplicate archive is blocked');
    await page.evaluate(() => window.releaseArchive());
    await page.waitForFunction(id => !document.querySelector(`.pilot-row[data-pilot="${id}"]`), id);
    assert.equal(await rows.count(), count - 1);
    assert.equal(await page.locator('.pilot-row:focus').count(), 1, 'focus advances to the next row');
    assert.equal(await page.locator('.pilot-row.selected:focus').count(), 1, 'the next row stays selected');
    assert.equal(await page.locator('.pilot-panel').count(), 0, 'archiving does not open a chat');
    await page.getByRole('button', { name: 'Show archived', exact: true }).click();
    await page.locator(`.pilot-row[data-pilot="${id}"]`).waitFor();
    assert.equal(await page.locator(`.pilot-row[data-pilot="${id}"]`).locator('..').locator('.archive-agent').count(), 0);
    await page.getByRole('button', { name: 'Show archived', exact: true }).click();
    // The row control also works with native button keyboard activation.
    const next = await rows.first().getAttribute('data-pilot');
    await rows.first().locator('..').getByRole('button', { name: /^Archive / }).focus();
    await page.evaluate(() => { delete window.releaseArchive; });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !!window.releaseArchive);
    await page.evaluate(() => window.releaseArchive());
    await page.waitForFunction(id => !document.querySelector(`.pilot-row[data-pilot="${id}"]`), next);
    assert.equal(await page.locator('.pilot-panel').count(), 0);
    await page.screenshot({ path: '/tmp/agents-archive-action.png' });
    assert.deepEqual(errors, []);
    console.log('PASS: Agents archive shortcut, button, failure, pending, duplicate protection, focus and archived filter in AppShell');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
