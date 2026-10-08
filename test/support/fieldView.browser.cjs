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
    // Enter opens the source as a draft desktop: the source beside an empty chat
    await page.keyboard.press('Enter');
    const draft = page.getByText('Not kept until you send');
    await draft.waitFor();
    // ⌘O hands the source's origin to the OS: a page goes to the browser (a new tab here).
    // The hint is keyText()'s, so it reads Ctrl+O off a Mac, as the key is pressed.
    assert.match(await draft.innerText(), process.platform === 'darwin' ? /⌘O Open original/ : /Ctrl\+O Open original/);
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.keyboard.press(process.platform === 'darwin' ? 'Meta+o' : 'Control+o')]);
    await popup.waitForEvent('domcontentloaded').catch(() => {});
    assert.equal(popup.url(), 'https://example.com/ins_b');
    await popup.close();
    await draft.waitFor();
    // @ in the composer lists recently added items; typing searches the vault
    const editor = page.getByRole('textbox', { name: 'Message' });
    await editor.click();
    await page.keyboard.type('see @');
    const menu = page.locator('.mention-menu');
    await menu.waitFor();
    assert.match(await menu.locator('.menu-label').first().innerText(), /recent/i);
    await menu.locator('[role=option]').first().waitFor();
    await page.keyboard.press('Enter');
    await menu.waitFor({ state: 'detached' });
    assert.equal(await editor.locator('.mention-chip').count(), 1);
    await page.keyboard.type(' @atlas');
    await menu.waitFor();
    await page.waitForFunction(() => /search results/i.test(document.querySelector('.mention-menu .menu-label')?.textContent ?? ''));
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
    await page.keyboard.press('Backspace');
    // Esc before a first message goes back to the feed, on the same row
    await page.keyboard.press('Escape');
    await draft.waitFor({ state: 'detached' });

    // ⌘N starts a new desktop (the workbench counts it rather than starting one)
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+n' : 'Control+n');
    await page.waitForFunction(() => window.desktopsCreated === 1);

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
    await page.locator('aside.panel .settings').first().waitFor();

    // out of usage credits: the base says so over the view, and Retry clears it
    await page.goto(`${base}/field-workbench.html?view=field&credits`);
    await page.getByText('Out of usage credits with Anthropic.').waitFor();
    assert.match(await page.locator('.credits').innerText(), /Paused: filing, summaries/);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.locator('.credits').waitFor({ state: 'detached' });

    assert.deepEqual(errors, []);
    console.log('PASS: Field walks and opens the feed, ⌘O opens the original, settings sit over it and return its keys, Settings offers no Classic, a new vault says what to do, and running out of credits is said once.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
