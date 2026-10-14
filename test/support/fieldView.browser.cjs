// Field on the base (web/ui/field-workbench.html, a fabricated vault): the
// feed walks with j/k and opens a source to read; nothing starts an agent;
// lenses stand as cubes and a click opens one; the gear lists vaults only; settings open as a panel over the
// field and give the keys back; Settings offers no Classic; a new vault says
// what to do. Search finds sources by title, not only entities by name. A
// long feed comes a page at a time.
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
    // Enter opens the source to read: the source alone, no message box
    await page.keyboard.press('Enter');
    const reader = page.locator('aside.side.reader');
    await reader.waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Message' }).count(), 0, 'reading a source starts no conversation');
    // ⌘O hands the source's origin to the OS: a page goes to the browser (a new tab here).
    // The hint is keyText()'s, so it reads Ctrl+O off a Mac, as the key is pressed.
    assert.match(await reader.innerText(), process.platform === 'darwin' ? /⌘O Open original/ : /Ctrl\+O Open original/);
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.keyboard.press('ControlOrMeta+o')]);
    await popup.waitForEvent('domcontentloaded').catch(() => {});
    assert.equal(popup.url(), 'https://example.com/ins_b');
    await popup.close();
    await reader.waitFor();
    // Esc goes back to the feed, on the same row
    await page.keyboard.press('Escape');
    await reader.waitFor({ state: 'detached' });
    assert.match(await page.locator('.feed.sorted .row.at').innerText(), /Atlas survey/);

    // nothing here starts an agent: Shift+Enter and ⌘N are no one's, and the bar has no +
    const conversations = await page.locator('.strip .tok').count();
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.press('ControlOrMeta+n');
    await page.keyboard.press('n');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.strip .tok').count(), conversations);
    assert.equal(await page.locator('.chat').count(), 0);
    assert.equal(await page.locator('.strip .new').count(), 0);

    // settings: a panel over the field; Esc closes it and the field has its keys again
    await page.keyboard.press('ControlOrMeta+,');
    await page.locator('aside.panel .settings').waitFor();
    await page.keyboard.press('j');
    assert.match(await page.locator('.feed.sorted .row.at').innerText(), /Atlas survey/, 'keys under the panel stay with the panel');
    await page.keyboard.press('Escape');
    await page.locator('aside.panel').waitFor({ state: 'detached' });
    await page.keyboard.press('j');
    assert.match(await page.locator('.feed.sorted .row.at').innerText(), /orrery repair estimate/, 'the field has its keys back');

    // the view is not a setting: Settings offers no Classic
    await page.keyboard.press('ControlOrMeta+,');
    await page.locator('aside.panel .settings').waitFor();
    assert.equal(await page.getByRole('button', { name: 'CLASSIC', exact: true }).count(), 0);
    await page.keyboard.press('Escape');

    // search finds a source by its title, not only an entity by its name: one
    // the field draws at once, an older one when the vault's search answers
    await page.keyboard.press('/');
    const find = page.getByRole('textbox', { name: 'Find by name' });
    await find.waitFor();
    const results = page.locator('.search [role=option]');
    await find.fill('invoice');
    await results.filter({ hasText: 'Quill press invoice' }).waitFor();
    assert.match(await results.first().innerText(), /Quill press invoice\s+Source/);
    await find.fill('lighthouse');
    await results.filter({ hasText: "Lighthouse keeper's log" }).waitFor();
    assert.equal(await page.getByText(/Nothing in your vault is called/).count(), 0);
    await find.fill('zzqx');
    await page.getByText('Nothing in your vault is called “zzqx”.').waitFor();
    // Enter opens the found source, as the feed's row does
    await find.fill('invoice');
    await results.filter({ hasText: 'Quill press invoice' }).waitFor();
    await page.keyboard.press('Enter');
    await reader.waitFor();
    await page.keyboard.press('Escape');
    await reader.waitFor({ state: 'detached' });

    // a new vault
    await page.goto(`${base}/field-workbench.html?view=field&empty`);
    await page.getByText('Nothing here yet').waitFor();
    await page.getByRole('button', { name: 'Connect an integration' }).click();
    await page.locator('aside.panel .settings').first().waitFor();

    // the latest assertions: a click selects what one mentions and makes the
    // claim the title; the gardener's rows are named by their model
    await page.goto(`${base}/field-workbench.html?view=field&claims`);
    const claims = page.locator('.feed .row');
    await claims.nth(5).waitFor();
    assert.equal(await claims.nth(1).locator('.a').innerText(), 'gpt-6-astra');
    await claims.nth(5).click();
    assert.match(await page.locator('.hud h1').innerText(), /^On October 4, 2026, Briar Lowe confirmed/);
    assert.match(await page.locator('.hud .eyebrow').innerText(), /claude-sonnet-5-5/i);
    assert.equal(await page.locator('.feed .row.open').count(), 1);
    await claims.nth(5).click();
    await page.locator('.hud').waitFor({ state: 'detached' });
    await claims.nth(2).click();
    assert.match(await page.locator('.hud h1').innerText(), /^Harbor lab's Lantern grant/);
    await page.keyboard.press('Escape');
    await page.locator('.hud').waitFor({ state: 'detached' });

    // out of usage credits: the base says so over the view, and Retry clears it
    await page.goto(`${base}/field-workbench.html?view=field&credits`);
    await page.getByText('Out of usage credits with Anthropic.').waitFor();
    assert.match(await page.locator('.credits').innerText(), /Paused: filing, summaries/);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.locator('.credits').waitFor({ state: 'detached' });

    // lenses stand in the field as cubes; the gear lists vaults only
    await page.goto(`${base}/field-workbench.html?view=field&servers`);
    const cubes = page.locator('.v2-lens');
    await page.waitForFunction(() => document.querySelectorAll('.v2-lens').length === 3);
    assert.deepEqual((await cubes.allInnerTexts()).sort(), ['Garden logistics', 'Reading', 'Seed library']);
    await page.locator('.gear').hover();
    const vaults = page.getByRole('group', { name: 'Vaults' });
    await vaults.waitFor();
    assert.deepEqual(await vaults.getByRole('button').allInnerTexts(), ['Personal', 'Garden club']);
    assert.equal(await vaults.getByRole('button', { name: 'Personal' }).getAttribute('aria-pressed'), 'true');
    await page.mouse.move(700, 600);
    // a cube's name clicked: the lens is on, its panel says what it holds
    await page.locator('.v2-lens', { hasText: 'Garden logistics' }).click();
    const panel = page.getByRole('region', { name: 'Lens: Garden logistics' });
    await panel.waitFor();
    assert.match(await panel.innerText(), /Plans, rotas and repairs for the community garden\./);
    assert.match(await panel.innerText(), /paused until you review/i);
    assert.equal(await panel.getByRole('list', { name: 'In this lens' }).getByRole('button').count(), 9);
    assert.equal(await page.locator('.v2-lens.on').innerText(), 'Garden logistics');
    // the panel sits clear of the feed beneath it
    const [pb, fb] = await Promise.all([panel.boundingBox(), page.locator('.feed.sorted').boundingBox()]);
    assert.ok(pb.y + pb.height <= fb.y + 1, `the lens panel (bottom ${pb.y + pb.height}) stays above the feed (top ${fb.y})`);
    // a note in it opens to read; Esc comes back to the lens, and Esc again lets it go
    await panel.getByRole('button', { name: /Seed swap sign-up/ }).click();
    await reader.waitFor();
    await page.keyboard.press('Escape');
    await panel.waitFor();
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.v2-lens.on').count(), 0);
    // a server's field is its own: no lenses drawn over it (yet)
    await page.locator('.gear').hover();
    await vaults.getByRole('button', { name: 'Garden club' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.v2-lens').length === 0);
    await page.locator('.gear').hover();
    await vaults.getByRole('button', { name: 'Personal' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.v2-lens').length === 3);

    // a long feed comes a page at a time: walking up past the oldest row
    // loaded brings the page before in and steps onto it
    await page.goto(`${base}/field-workbench.html?view=field&longFeed`);
    await rows.nth(99).waitFor();
    assert.equal(await rows.count(), 100);
    for (let i = 0; i < 101; i++) await page.keyboard.press('k');
    await page.locator('.feed.sorted .row.at', { hasText: 'Field note 98:' }).waitFor();
    assert.equal(await rows.count(), 200);
    // scrolled to the top, the page before comes in above, and the row that
    // was at the top stays where it was
    await page.goto(`${base}/field-workbench.html?view=field&longFeed`);
    await rows.nth(99).waitFor();
    const strip = page.locator('.feed.sorted');
    const oldest = await rows.first().locator('.x').innerText();
    // where it sits, read in the same task the scroll is set in: the load
    // starts from the scroll event, after it
    const before = await strip.evaluate((el) => {
      el.scrollTop = 0;
      return el.querySelector('.row').getBoundingClientRect().top - el.getBoundingClientRect().top;
    });
    await rows.nth(199).waitFor();
    const after = await strip.evaluate((el, text) => [...el.querySelectorAll('.row')]
      .find((r) => r.querySelector('.x').textContent === text).getBoundingClientRect().top - el.getBoundingClientRect().top, oldest);
    assert.ok(Math.abs(after - before) < 2, `the row read before stays put (${before}px from the top, then ${after}px)`);
    assert.equal(await rows.count(), 200);

    assert.deepEqual(errors, []);
    console.log('PASS: Field walks and opens the feed, a source opens to read and starts nothing, ⌘O opens the original, lenses stand as cubes that filter the field and open what they hold, the gear lists vaults only, settings sit over it and return its keys, Settings offers no Classic, search finds sources by title, a new vault says what to do, an assertion clicked is selected and titled, running out of credits is said once, and a long feed loads the page before, by key or by scroll, without moving what is read.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
