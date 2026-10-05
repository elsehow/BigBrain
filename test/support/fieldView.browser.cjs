// Field on the base (web/ui/field-workbench.html, a fabricated vault): the
// feed walks with j/k and opens a source; settings open as a panel over the
// field and give the keys back; Settings → General switches to Classic and
// back; a new vault says what to do.
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5279';
    await page.goto(`${base}/field-workbench.html?view=field`);
    const rows = page.locator('.feed.sorted .row');
    await rows.nth(2).waitFor();
    assert.equal(await rows.count(), 3);

    // the walk: k takes the newest (the bottom row), Enter opens its source
    await page.keyboard.press('k');
    await page.locator('.feed.sorted .row.at').waitFor();
    assert.match(await page.locator('.feed.sorted .row.at').innerText(), /orrery repair estimate/);
    await page.keyboard.press('k');
    assert.match(await page.locator('.feed.sorted .row.at').innerText(), /Atlas survey/);
    await page.keyboard.press('Enter');
    await page.locator('.hud h1', { hasText: 'Atlas survey update' }).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.hud').waitFor({ state: 'detached' });

    // settings: a panel over the field; Esc closes it and the field has its keys again
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
    await page.locator('aside.panel .settings').waitFor();
    await page.keyboard.press('j');
    assert.match(await page.locator('.feed.sorted .row.at').innerText(), /Atlas survey/, 'keys under the panel stay with the panel');
    await page.keyboard.press('Escape');
    await page.locator('aside.panel').waitFor({ state: 'detached' });
    await page.keyboard.press('j');
    assert.match(await page.locator('.feed.sorted .row.at').innerText(), /orrery repair estimate/, 'the field has its keys back');

    // the view is a setting: Classic, then Field again
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
    await page.getByRole('button', { name: 'CLASSIC', exact: true }).click();
    await page.locator('#topbar').waitFor();
    assert.equal(await page.locator('.v2').count(), 0);
    await page.getByRole('button', { name: 'FIELD', exact: true }).click();
    await page.locator('aside.panel .settings').waitFor();
    assert.equal(await page.locator('#topbar').count(), 0);

    // a new vault
    await page.goto(`${base}/field-workbench.html?view=field&empty`);
    await page.getByText('Nothing here yet').waitFor();
    await page.getByRole('button', { name: 'Connect an integration' }).click();
    await page.locator('aside.panel .settings').waitFor();

    assert.deepEqual(errors, []);
    console.log('PASS: Field walks and opens the feed, settings sit over it and return its keys, the view switches both ways, and a new vault says what to do.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
