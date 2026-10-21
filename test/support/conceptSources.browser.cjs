// Production shell and reader, using only the workbench's invented sources.
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5248';
(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/sidebar-workbench.html?conceptSources=1');
    const sources = page.getByRole('region', { name: 'Sources for Atlas' });
    await sources.waitFor();
    assert.equal(await sources.getByRole('button').count(), 2);
    assert(await page.locator('.v2-canvas').isVisible());
    assert.equal(await page.locator('.tokwrap').count(), 0);
    await sources.getByRole('button', { name: 'Read Atlas — September update' }).click();
    const reader = page.getByRole('complementary', { name: 'Reading' });
    await reader.waitFor();
    const bounds = await reader.boundingBox();
    assert(bounds.x < 50 && bounds.width <= 460, 'source stays in the left sidebar');
    assert.equal(await reader.locator('.view').count(), 0, 'no centred reader frame');
    await reader.getByText('Our proposed second location is on hold.', { exact: false }).waitFor();
    await reader.getByRole('button', { name: 'Back to Atlas', exact: false }).click();
    await sources.waitFor();
    await sources.getByRole('button', { name: 'Read A second home for Atlas' }).click();
    await reader.getByText('The expansion should make borrowing a tool', { exact: false }).waitFor();
    await page.keyboard.press('Escape');
    await sources.waitFor();
    // The same entry shell still supplies settings, and the normal field
    // workbench gets no study content without the explicit preview option.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('complementary', { name: 'Settings', exact: true }).waitFor();
    await page.goto(base + '/field-workbench.html');
    await page.getByRole('button', { name: 'Search', exact: false }).waitFor();
    assert.equal(await page.locator('.concept-sources').count(), 0);
    assert(await page.locator('.v2-canvas').isVisible());
    assert.deepEqual(errors, []);
    console.log('Concept sources: production shell, both source reads, return navigation, and opt-in isolation passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
