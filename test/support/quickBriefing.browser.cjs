/** Production AppShell: streamed summaries complete and survive reopening. */
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const base = process.env.SIDEBAR_PREVIEW_URL || process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5201';
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => route.abort());
    await page.route(base + '/', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><div id="app"></div><script type="module">
      import { installFakeApi, setVaultState, BRIEFINGS } from '/src/dev/fakeApi.ts';
      installFakeApi(); setVaultState(structuredClone(BRIEFINGS.streaming));
      // Hold completion until the test has observed the streamed preview.
      const fetchFixture = window.fetch;
      let finish;
      const completion = new Promise(resolve => { finish = resolve; });
      window.finishBriefing = finish;
      window.fetch = async (...args) => {
        const response = await fetchFixture(...args);
        if (!String(args[0]).includes('/api/note/briefing') || !response.body) return response;
        return new Response(response.body.pipeThrough(new TransformStream({
          async transform(chunk, controller) {
            if (new TextDecoder().decode(chunk).includes('"type":"complete"')) await completion;
            controller.enqueue(chunk);
          }
        })), { headers: response.headers });
      };
      location.hash = BRIEFINGS.streaming.hash;
      await import('/src/main.ts');
    </script>` }));
    await page.goto(base + '/');
    const briefing = page.locator('.drawer:not(.sidebar-quick) .briefing');
    await briefing.waitFor();
    await briefing.locator('.briefing-summary').waitFor();
    assert.equal(await briefing.getAttribute('aria-busy'), 'true');
    const summary = await briefing.locator('.briefing-summary').textContent();
    await page.evaluate(() => window.finishBriefing());
    await page.locator('.drawer:not(.sidebar-quick) .briefing[aria-busy="false"]').waitFor();
    assert.ok(await briefing.locator('.link-description').count() > 0);
    const hash = await page.evaluate(() => location.hash);
    await page.evaluate(() => { location.hash = '/'; });
    await briefing.waitFor({ state: 'hidden' });
    await page.evaluate(hash => { location.hash = hash; }, hash);
    await briefing.locator('.briefing-summary').waitFor();
    assert.equal(await briefing.locator('.briefing-summary').textContent(), summary);
    assert.equal(await briefing.getAttribute('aria-busy'), 'false');
    assert.equal(await briefing.locator('.briefing-error').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: production AppShell streams summary before completion and reopens the completed briefing from cache');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
