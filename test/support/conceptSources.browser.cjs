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
    const openAtlas = async (state = '') => {
      await page.goto(base + '/sidebar-workbench.html?conceptSources=1' + (state ? `&sourceState=${state}` : ''));
      await page.getByRole('button', { name: 'Search', exact: false }).click();
      await page.getByRole('textbox').fill('Atlas');
      await page.keyboard.press('Enter');
    };
    await openAtlas();
    const sources = page.getByRole('region', { name: 'Sources for Atlas' });
    await sources.getByRole('button', { name: 'Read Atlas — September update' }).waitFor();
    assert.equal(await sources.getByRole('button').count(), 2);
    assert.match(await sources.getByRole('button').first().innerText(), /September update/);
    await sources.getByText('The lease fell through; the second location is postponed while Maya looks for another space.', { exact: true }).waitFor();
    await sources.getByText('The original expansion proposal: bring the tool library closer to more neighbors.', { exact: true }).waitFor();
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
    await openAtlas('many');
    await sources.getByRole('button', { name: 'Show more sources' }).waitFor();
    assert.equal(await sources.locator('button.source').count(), 8);
    await sources.getByRole('button', { name: 'Show more sources' }).click();
    assert.equal(await sources.locator('button.source').count(), 12);
    await sources.getByRole('button', { name: 'Read Atlas archive 10', exact: true }).click();
    await reader.getByRole('heading', { name: 'Atlas archive 10', exact: true }).waitFor();
    await openAtlas('error');
    await sources.getByRole('button', { name: 'Retry', exact: true }).click();
    await sources.getByRole('button', { name: 'Read Atlas — September update' }).waitFor();
    await openAtlas('empty');
    await sources.getByText('No linked sources yet.').waitFor();
    await openAtlas('summary-error');
    await sources.getByText('Summary unavailable', { exact: true }).first().waitFor();
    await sources.getByRole('button', { name: 'Read Atlas — September update' }).click();
    await reader.getByText('Our proposed second location is on hold.', { exact: false }).waitFor();
    await reader.getByText('Summary unavailable', { exact: true }).waitFor();
    await page.goto(base + '/field-workbench.html');
    await page.getByRole('button', { name: 'Search', exact: false }).waitFor();
    assert.equal(await page.locator('.concept-sources').count(), 0);
    assert(await page.locator('.v2-canvas').isVisible());
    assert.deepEqual(errors, []);
    console.log('Concept sources: production shell, both source reads, return navigation, Quick summaries, newest-added ordering, and fixture isolation passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
