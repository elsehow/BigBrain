// A contained desktop's header (docs/plans/2026-10-12-contained-desktops.md,
// "What the person sees"), on the field workbench's `?machine=<state>`
// scenes: the machine pill in each state, the copy line with Sync, Land… and
// Discard, the review's two flags, the network-off panel and its Allow
// network, Retry after a failed start, Cancel while preparing, Rebuild when
// out of date, a desktop from before machines, a sandboxed one, and Settings'
// machines section (the sidebar workbench's `?machines=on|fresh|off`). Every
// /api route is the workbench's, answered in the page, so no engine is reached.
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5279';
    const open = async state => {
      await page.goto(`${base}/field-workbench.html?view=field&machine=${state}`);
      await page.getByText('Orrery fixes').first().click();
      await page.locator('section header h2').waitFor();
    };
    const pill = () => page.locator('.machine .pill');
    const header = () => page.locator('section header').first();

    // running: the pill, and the copy line saying what the copy is
    await open('running');
    assert.equal(await pill().innerText(), 'Running');
    const line = await header().locator('.fork').innerText();
    assert.match(line, /orrery\s+copy at a1b2c3d \(main\) · taken \d\d:\d\d · your checkout is 2 ahead · 1 commit, 1 uncommitted/);
    for (const name of ['Sync', 'Land…', 'Discard']) await header().getByRole('button', { name, exact: true }).waitFor();

    // Sync says what came in
    await header().getByRole('button', { name: 'Sync', exact: true }).click();
    await page.getByText("orrery's copy now has your commits up to 9f8e7d6.").waitFor();

    // Land…: the review, with both flags, then Land
    await header().getByRole('button', { name: 'Land…', exact: true }).click();
    const review = page.locator('.review');
    await review.waitFor();
    assert.match(await review.innerText(), /1 commit on desktop\/d-0000cafe/);
    assert.match(await review.innerText(), /Runs code on its own: package\.json/);
    await review.getByRole('button', { name: 'Land these commits' }).click();
    await page.getByText('Brought desktop/d-0000cafe home to orrery.').waitFor();

    // network off: the panel names what it read and the host it was refused, and Allow network answers it
    await open('network-off');
    const panel = page.getByRole('group', { name: 'The network is off for this desktop' });
    await panel.waitFor();
    assert.match(await panel.innerText(), /It read the web, so its commands reach no site until you allow it/);
    assert.equal(await panel.locator('code').innerText(), 'registry.npmjs.org');
    assert.equal(await page.getByRole('group', { name: 'The shell is off for this desktop' }).count(), 0, 'a contained desktop keeps its shell');
    await header().getByRole('button', { name: 'Land…', exact: true }).click();
    assert.match(await page.locator('.review').innerText(), /It read material from outside you: the web/);
    await panel.getByRole('button', { name: 'Allow network' }).click();
    await panel.waitFor({ state: 'detached' });

    // preparing: progress, and Cancel
    await open('preparing');
    assert.equal(await pill().innerText(), 'Preparing the desktop machine · 118 of 319 MB');
    await page.locator('.machine').getByRole('button', { name: 'Cancel' }).click();
    await page.waitForFunction(() => document.querySelector('.machine .pill')?.textContent === 'Stopped');

    // failed: why, the console's tail, and Retry
    await open('failed');
    assert.equal(await pill().innerText(), 'Machine failed');
    assert.match(await page.locator('.machine .why').innerText(), /its guest never answered/);
    assert.match(await page.locator('pre.console').innerText(), /can't listen on vsock 7470/);
    await page.locator('.machine').getByRole('button', { name: 'Retry' }).click();
    await page.waitForFunction(() => document.querySelector('.machine .pill')?.textContent === 'Starting…');

    // out of date: Rebuild asks twice
    await open('out-of-date');
    assert.equal(await pill().innerText(), 'Out of date');
    const rebuild = page.locator('.machine').getByRole('button', { name: 'Rebuild' });
    await rebuild.click();
    await page.getByText(/Rebuilding gives this desktop a fresh machine/).waitFor();
    assert.equal(await pill().innerText(), 'Out of date', 'the first click only warns');
    await rebuild.click();
    await page.waitForFunction(() => document.querySelector('.machine .pill')?.textContent === 'Stopped');

    // stopped and starting read as such
    for (const [state, text] of [['stopped', 'Stopped'], ['starting', 'Starting…']]) {
      await open(state);
      assert.equal(await pill().innerText(), text);
    }

    // a desktop from before machines: what it says, and no pill
    await open('legacy');
    await page.getByText('This desktop predates contained desktops: land or discard its work, then start a new desktop.').waitFor();
    assert.equal(await pill().count(), 0);

    // a sandboxed desktop says so
    await open('sandboxed');
    await page.getByText('Sandboxed, not contained').waitFor();
    assert.equal(await pill().count(), 0);

    // Settings › Desktops: memory and how many at once save; Delete unused says what it freed; a computer without machines says why
    await page.goto(`${base}/sidebar-workbench.html?machines=on#/general`);
    const settings = page.getByRole('region', { name: 'Desktop machines' });
    await settings.waitFor();
    assert.match(await settings.innerText(), /Machine image\s+here, 905 MB · desktops' disks 2\.4 GB/);
    await settings.getByLabel('Memory per desktop').selectOption('4');
    await settings.getByText('Saved; a machine takes it at its next start').waitFor();
    assert.equal(await settings.getByLabel('Memory per desktop').inputValue(), '4');
    await settings.getByRole('button', { name: 'Delete unused' }).click();
    await settings.getByText('Freed 880 MB').waitFor();
    await page.goto(`${base}/sidebar-workbench.html?machines=fresh#/general`);
    await page.getByRole('region', { name: 'Desktop machines' }).getByText('downloads on first use (319 MB)').waitFor();
    await page.goto(`${base}/sidebar-workbench.html?machines=off#/general`);
    await page.getByRole('region', { name: 'Desktop machines' }).getByText('Contained desktops run on Apple silicon for now; desktops on this Mac are sandboxed.').waitFor();
    assert.equal(await page.getByLabel('Memory per desktop').count(), 0);

    assert.deepEqual(errors, []);
    console.log('contained desktop: ok');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
