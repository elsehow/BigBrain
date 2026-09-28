// Production AppShell initialization; fabricated network installed before mount.
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5200';
(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/sidebar-workbench.html?unreadSearch=1`);
    await page.evaluate(async () => {
      window.unreadTest = {
        fixture: (await import('/src/dev/unreadSearchFixture.ts')).unreadFixture,
        attention: await import('/src/lib/sourceAttention.svelte.ts'),
        search: await import('/src/lib/floatingSearch.svelte.ts'),
        app: (await import('/src/lib/store.svelte.ts')).app,
      };
    });
    await page.keyboard.press('r');
    const filter = page.getByRole('button', { name: /^Unread/ });
    await filter.waitFor();
    const row = i => page.locator('.search-hit').filter({ has: page.getByText(`Unread fixture ${i}`, { exact: true }) });
    const settled = () => page.waitForFunction(() => !window.unreadTest.search.floatingResults.building && !window.unreadTest.search.floatingResults.loadingMore);
    const paths = () => page.evaluate(() => window.unreadTest.search.floatingResults.hits.map(h => h.note.path));
    const has = (rows, i) => rows.includes(`sources/unread-fixture-${i}.md`);
    const refresh = unread => page.evaluate(async unread => {
      const t = window.unreadTest; t.fixture.unread = unread;
      await t.attention.refreshSourceAttention(true);
    }, unread);
    await page.waitForFunction(() => window.unreadTest.search.floatingResults.hits.length > 0);
    assert.notEqual((await row(0).locator('.hit-kind').textContent()).toLowerCase(), 'unread');
    await filter.click(); await settled();
    assert.equal(has(await paths(), 0), false); assert.equal(has(await paths(), 1), false);
    assert.equal(has(await paths(), 2), false); assert.equal(has(await paths(), 3), false);
    assert.equal(await page.evaluate(() => window.unreadTest.fixture.offsets.includes(100)), true);
    const rev = await page.evaluate(() => window.unreadTest.app.rev);
    // Refresh while unfiltered, then toggle within the 15-second cache window.
    const start = Date.now();
    await filter.click(); await settled(); await refresh(true);
    await page.waitForFunction(() => window.unreadTest.attention.sourceAttention.rows[0]?.readState.unread === true);
    assert.equal((await row(0).locator('.hit-kind').textContent()).toLowerCase(), 'unread');
    await filter.click(); await settled();
    assert(has(await paths(), 0), 'previously read row must return without app.rev changing');
    assert(has(await paths(), 1), 'previously unknown row must return');
    assert.equal(has(await paths(), 2), false, 'still unknown is excluded');
    assert(Date.now() - start < 15000, 'exercise live cache');
    // While open: changed state restarts, rather than only re-projecting hits.
    await refresh(false);
    await page.waitForFunction(() => !window.unreadTest.search.floatingResults.hits.some(h => h.note.path.endsWith('-0.md')));
    await refresh(true);
    await page.waitForFunction(() => window.unreadTest.search.floatingResults.hits.some(h => h.note.path.endsWith('-0.md')));
    await page.evaluate(() => window.unreadTest.fixture.releaseGraph());
    await page.waitForFunction(() => window.unreadTest.search.floatingResults.hits.some(h => h.note.path.endsWith('-3.md')));
    assert.equal((await row(3).locator('.hit-kind').textContent()).toLowerCase(), 'unread', 'delayed alias matches badge');
    // Reaching the bottom loads the next page (the Load more button would race that
    // same scroll-triggered load on a slow runner and be removed mid-click).
    await page.locator('.search-viewport').evaluate(v => { v.scrollTop = v.scrollHeight; v.dispatchEvent(new Event('scroll')); });
    await page.waitForFunction(() => window.unreadTest.search.floatingResults.hits.some(h => h.note.path.endsWith('-204.md'))); await settled();
    assert(has(await paths(), 204), 'pagination continues past 200');
    // A previous scan's transport ignores abort: a cached newer generation
    // must win even when that old response eventually completes.
    await page.evaluate(() => { window.unreadTest.fixture.holdPage = true; });
    await refresh(false);
    await page.waitForFunction(() => window.unreadTest.fixture.heldPages === 1);
    await refresh(true);
    await page.waitForFunction(() => window.unreadTest.search.floatingResults.hits.some(h => h.note.path.endsWith('-0.md')));
    await page.evaluate(() => window.unreadTest.fixture.releasePage());
    await page.waitForTimeout(100);
    assert(has(await paths(), 0), 'late read-only snapshot cannot overwrite current unread results');
    // Failed refresh keeps the last observation; it cannot imply read/unknown.
    await page.evaluate(async () => { const t = window.unreadTest; t.fixture.fail = true; await t.attention.refreshSourceAttention(true); });
    assert(has(await paths(), 0));
    assert(await page.evaluate(() => !!window.unreadTest.attention.sourceAttention.refreshError));
    assert.equal(await page.evaluate(() => window.unreadTest.app.rev), rev);
    assert.equal(await page.evaluate(() => window.unreadTest.fixture.posts), 0);
    assert.deepEqual(errors, []);
    console.log('PASS unread cache refresh/open list, delayed aliases, unknown, >100 pagination, failure, no mail-state POST');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
