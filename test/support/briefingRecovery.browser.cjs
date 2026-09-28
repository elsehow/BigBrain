/** Partial briefing failures must not roll back useful text for this selection. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route('**/api/**', route => route.abort());
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const base = process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5198';
    await page.goto(`${base}/dev.html?c=briefings&s=linkError&preview=1`);
    await page.locator('.briefing-summary').waitFor();
    const original = await page.locator('.briefing-summary').textContent();
    await page.keyboard.press('j');
    const selected = await page.locator('.source-link.lk-on').getAttribute('data-path');
    const order = await page.locator('.source-link').evaluateAll(rows => rows.map(row => row.dataset.path));
    await page.locator('.briefing-error').waitFor();
    assert.equal(await page.locator('.briefing-summary').textContent(), original);
    assert.equal(await page.locator('.link-description').count(), 0);
    assert.equal(await page.locator('.source-link.lk-on').getAttribute('data-path'), selected);

    await page.evaluate(async () => {
      const url = name => performance.getEntriesByType('resource').map(e => e.name).find(entry => new URL(entry).pathname === '/src/lib/' + name);
      window.recoveryApp = await import(url('store.svelte.ts'));
      window.recoveryCache = await import(url('noteBriefing.ts'));
      window.recoveryMode = 'fail';
      const fetch = window.fetch;
      window.fetch = (url, init) => {
        if (String(url) !== '/api/note/briefing') return fetch(url, init);
        const mode = window.recoveryMode;
        let timer;
        return Promise.resolve(new Response(new ReadableStream({ start(controller) {
          const emit = event => controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
          if (mode !== 'no-summary') emit({ type: 'preview', text: 'Replacement fragment' });
          timer = setTimeout(() => {
            emit(mode === 'complete'
              ? { type: 'complete', briefing: { key: 'recovered', model: 'test', generatedAt: '2026-09-14T12:00:00Z', summary: 'Atlas is a neighborhood tool library.', links: [
                { id: 'maya', path: 'projection/entities/ent_00000000000000000002.md', title: 'Maya Chen', description: 'coordinates the expansion', evidence: [] },
              ] } }
              : { type: 'error', error: 'A relationship was missing its supporting evidence. Try again.' });
            controller.close();
          }, 300);
        }, cancel() { clearTimeout(timer); } }), { headers: { 'content-type': 'application/x-ndjson' } }));
      };
    });
    assert.equal(await page.evaluate(() => window.recoveryCache.cachedNoteBriefing(window.recoveryApp.app.graphView)), undefined);
    await page.locator('.retry').click();
    await page.getByRole('status', { name: 'Retrying descriptions', exact: true }).waitFor();
    assert.equal(await page.locator('.briefing-summary').textContent(), original);
    await page.locator('.briefing-error').waitFor();
    assert.equal(await page.locator('.briefing-summary').textContent(), original);
    assert.equal(await page.locator('.source-link.lk-on').getAttribute('data-path'), selected);
    assert.deepEqual(await page.locator('.source-link').evaluateAll(rows => rows.map(row => row.dataset.path)), order);
    // A vault refresh has the same preservation contract as an explicit retry.
    await page.evaluate(() => window.recoveryApp.app.rev++);
    await page.getByRole('status', { name: 'Retrying descriptions', exact: true }).waitFor();
    assert.equal(await page.locator('.briefing-summary').textContent(), original);
    await page.locator('.briefing-error').waitFor();
    assert.equal(await page.locator('.briefing-summary').textContent(), original);
    await page.screenshot({ path: '/private/tmp/briefing-recovery.png' });

    await page.evaluate(() => { window.recoveryMode = 'complete'; });
    await page.locator('.retry').click();
    await page.locator('.link-description').waitFor();
    assert.equal(await page.locator('.briefing-summary').textContent(), 'Atlas is a neighborhood tool library.');
    assert.equal(await page.locator('.briefing-error').count(), 0);
    assert.equal(await page.evaluate(() => window.recoveryCache.cachedNoteBriefing(window.recoveryApp.app.graphView)?.summary), 'Atlas is a neighborhood tool library.');
    await page.evaluate(() => { window.recoveryMode = 'no-summary'; window.recoveryApp.app.rev++; });
    await page.locator('.briefing-error').waitFor();
    assert.equal(await page.locator('.briefing-summary').textContent(), 'Atlas is a neighborhood tool library.');
    assert.equal(await page.locator('.link-description').count(), 1);
    // A different selection never inherits the previous node's text.
    await page.locator('.source-link').filter({ hasText: 'Maya Chen' }).click();
    await page.waitForURL(/ent_00000000000000000002/);
    await page.locator('.briefing-error').waitFor();
    assert.equal(await page.locator('.briefing-summary').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: summary survives failed descriptions, retry fragments, repeat failure, live refresh, and cached revalidation; recovery replaces it; new selections clear it; no runtime errors.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
