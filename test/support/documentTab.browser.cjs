const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5217';
(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/sidebar-workbench.html#/session/pilot-11111111111111111111111111111111`);
    await page.getByRole('link', { name: 'Shared design review', exact: true }).click();
    await page.locator('.document-tab').waitFor();
    await page.waitForFunction(() => document.documentElement.dataset.sidebarTab === 'document');
    assert.equal(await page.locator('.document-tab').count(), 1);
    assert.match(await page.locator('.document-tab').innerText(), /Shared design review/);
    const tab = await page.locator('.document-tab').boundingBox();
    const gear = await page.getByRole('button', { name: 'Settings', exact: true }).boundingBox();
    assert(tab.x >= gear.x + gear.width, 'document follows icon tabs');
    for (const name of ['Agents', 'Recents', 'Search', 'Settings']) {
      await page.getByRole('button', { name, exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.document-tab.active'));
      assert.equal(await page.locator('.document-tab').count(), 1, `${name} retains the document`);
      await page.getByRole('button', { name: 'Shared design review', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.document-tab.active'));
      await page.getByRole('region', { name: 'Selected notes', exact: true }).waitFor();
    }
    await page.waitForTimeout(800);
    await page.screenshot({ path: '/tmp/text-document-tab.png' });
    await page.keyboard.press('Escape');
    await page.getByRole('region', { name: 'Pilot text tab', exact: true }).waitFor();
    assert.equal(await page.locator('.document-tab').count(), 0);
    await page.getByRole('link', { name: 'Shared design review', exact: true }).click();
    await page.getByRole('button', { name: 'Close document', exact: true }).click();
    await page.getByRole('region', { name: 'Pilot text tab', exact: true }).waitFor();
    await page.goto(`${base}/sidebar-workbench.html#/vault/sources/shared-design-review.md`);
    await page.locator('.document-tab').waitFor();
    await page.evaluate(() => { location.hash = '#/vault/projection/entities/ent_00000000000000000002.md'; });
    await page.waitForFunction(() => document.querySelector('.document-tab-title')?.textContent === 'Maya Chen');
    assert.equal(await page.locator('.document-tab').count(), 1, 'entity replaces the open source');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.documentElement.dataset.sidebarWorkbench === 'closed');
    assert.equal(await page.locator('.document-tab').count(), 0);
    await page.goto(`${base}/sidebar-workbench.html#/vault/sources/shared-design-review.md`);
    await page.locator('.document-tab').waitFor();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('#main > .settings').waitFor();
    await page.getByRole('button', { name: 'Close document', exact: true }).click();
    assert.equal(await page.locator('.document-tab').count(), 0);
    assert(await page.locator('#main > .settings').isVisible(), 'closing inactive document preserves current tab');
    assert.deepEqual(errors, []);
    console.log('Document tab: citation, tab switching, replacement, Escape and close button passed.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
