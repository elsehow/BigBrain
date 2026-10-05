// Field on the base (web/ui/field-workbench.html, a fabricated vault): the
// feed walks with j/k and opens a source; settings open as a panel over the
// field and give the keys back; Settings offers no Classic; a new vault says
// what to do.
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
    // ⌘O reads the source's note in full; Esc puts it away and leaves the source open
    assert.match(await page.locator('.hud .eyebrow').innerText(), /⌘O OPEN/i);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+o' : 'Control+o');
    await page.locator('.reader .vbody', { hasText: 'The full text, as filed.' }).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.reader').waitFor({ state: 'detached' });
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

    // the view is not a setting: Settings offers no Classic
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
    await page.locator('aside.panel .settings').waitFor();
    assert.equal(await page.getByRole('button', { name: 'CLASSIC', exact: true }).count(), 0);
    await page.keyboard.press('Escape');

    // a new vault
    await page.goto(`${base}/field-workbench.html?view=field&empty`);
    await page.getByText('Nothing here yet').waitFor();
    await page.getByRole('button', { name: 'Connect an integration' }).click();
    await page.locator('aside.panel .settings').waitFor();

    // out of usage credits: the base says so over the view, and Retry clears it
    await page.goto(`${base}/field-workbench.html?view=field&credits`);
    await page.getByText('Out of usage credits with Anthropic.').waitFor();
    assert.match(await page.locator('.credits').innerText(), /Paused: filing, summaries/);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.locator('.credits').waitFor({ state: 'detached' });

    assert.deepEqual(errors, []);
    console.log('PASS: Field walks and opens the feed, ⌘O reads a source in full, settings sit over it and return its keys, Settings offers no Classic, a new vault says what to do, and running out of credits is said once.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
