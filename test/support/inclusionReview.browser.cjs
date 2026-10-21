// Production shell, fabricated API: model work stays busy until explicitly
// released, so this proves ratings do not depend on provider response time.
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5231';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = [], ratings = [], finished = [];
    page.on('pageerror', e => errors.push(e.message));
    const examples = ['Orchard plan', 'Harbor plan', 'Garden plan'].map((title, i) => ({
      id: String(i), title, origin: 'Fabricated source', excerpt: 'An invented planning note.', body: 'An invented planning note.',
    }));
    let revision = 0, settled = false, failNext = false, holdPoll = true;
    const secondWrite = deferred(), releaseSecond = deferred(), stalePoll = deferred(), releasePoll = deferred();
    const state = () => ({
      id: 'review-fixture', text: 'Planning notes', revision, busy: revision > 0 && !settled,
      ready: revision > 0 && settled, remaining: 4 - ratings.length, overlap: false,
      judged: ratings.length, unresolved: 0, failures: [], sources: 3, untried: 0, narrowed: false,
      items: examples.filter(item => !ratings.some(r => r.source === item.id)), picked: [], exhausted: false,
    });
    await page.route('**/api/**', route => route.fulfill({ status: 404, json: {} }));
    await page.route('**/api/lenses**', route => {
      const action = new URL(route.request().url()).pathname.split('/').at(-1);
      return route.fulfill({ json: action === 'new' ? { id: 'lens_000000000001' }
        : action === 'preview' ? { id: 'preview-fixture', busy: false, done: 3, total: 3, failed: 0, rows: [] }
        : { servers: [] } });
    });
    await page.route('**/api/inclusion-review/**', async route => {
      const request = route.request(), action = new URL(request.url()).pathname.split('/').at(-1);
      if (request.method() === 'GET') {
        const snapshot = state();
        if (holdPoll && revision === 1) { holdPoll = false; stalePoll.resolve(); await releasePoll.promise; }
        return route.fulfill({ json: snapshot });
      }
      const body = request.postDataJSON();
      if (action === 'rate') {
        if (failNext) { failNext = false; return route.fulfill({ status: 400, json: { error: 'Rating could not be saved. Try again.' } }); }
        assert.equal(body.revision, revision, 'writes use the last acknowledged revision');
        assert(!ratings.some(r => r.source === body.source), 'a choice is sent once');
        if (ratings.length === 1) { secondWrite.resolve(); await releaseSecond.promise; }
        ratings.push(body); revision++;
      } else if (action === 'finish') {
        assert(settled, 'cannot finish during model work'); finished.push([...ratings]);
        return route.fulfill({ json: { saved: true } });
      }
      return route.fulfill({ json: state() });
    });
    const open = async () => {
      await page.goto('about:blank');
      await page.goto(base + '/sidebar-workbench.html?vault=live#/lenses/new');
      await page.getByRole('textbox', { name: 'Inclusion rule', exact: true }).fill('Planning notes');
      await page.getByRole('button', { name: 'Include: Orchard plan', exact: true }).waitFor();
    };
    const include = title => page.getByRole('button', { name: 'Include: ' + title, exact: true });
    const done = page.getByRole('button', { name: 'Done', exact: true });
    await open();
    await include('Orchard plan').click();
    await include('Orchard plan').waitFor({ state: 'detached' });
    await stalePoll.promise;
    assert(await include('Harbor plan').isEnabled(), 'another example stays enabled during model work');
    assert(await done.isDisabled());
    await include('Harbor plan').click();
    await secondWrite.promise;
    assert(await include('Garden plan').isEnabled(), 'another example stays enabled during a rating write');
    await page.getByRole('button', { name: 'Exclude: Garden plan', exact: true }).click();
    assert(await include('Garden plan').isDisabled(), 'only the selected card is locked');
    assert.equal(ratings.length, 1, 'later clicks wait for the previous write, not for model work');
    releaseSecond.resolve();
    await include('Garden plan').waitFor({ state: 'detached' });
    assert.deepEqual(ratings.map(r => [r.source, r.include, r.revision]), [['0', true, 0], ['1', true, 1], ['2', false, 2]]);
    releasePoll.resolve();
    // Let the older poll arrive before the next current poll; it must not restore cards.
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.review article').count(), 0);
    assert(await done.isDisabled());
    settled = true;
    await page.waitForFunction(() => !document.querySelector('.done')?.disabled);
    await done.click();
    await done.waitFor({ state: 'detached' });
    assert.equal(finished[0].length, 3);

    // A rejected write restores that card, leaves other cards usable, and can be retried.
    revision = 0; ratings.length = 0; settled = false; failNext = true;
    await open();
    await include('Orchard plan').click();
    await page.getByRole('alert').filter({ hasText: 'Rating could not be saved' }).waitFor();
    assert(await include('Orchard plan').isEnabled());
    assert(await include('Harbor plan').isEnabled());
    await include('Orchard plan').click();
    await include('Orchard plan').waitFor({ state: 'detached' });
    assert.equal(ratings.length, 1);
    assert.deepEqual(errors, []);
    console.log('PASS: production shell accepts rapid ratings during slow evaluation, serializes writes, ignores stale polls, and recovers rejected ratings.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
