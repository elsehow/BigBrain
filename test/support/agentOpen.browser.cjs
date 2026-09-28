// Pending/failed history must not trap quick navigation or reopen an escaped chat.
const { webkit, chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const base = process.env.PROFILE_URL || 'http://127.0.0.1:53490';
(async () => {
 for (const engine of [webkit, chromium]) {
  const browser = await engine.launch({ headless: true, ...(engine === chromium ? { channel: 'chrome' } : {}) });
  try {
   const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
   const errors = []; page.on('pageerror', e => errors.push(e.message));
   await page.route('**/api/**', r => r.abort()); await page.goto(`${base}/sidebar-workbench.html`);
   await page.locator('.graph-renderer canvas').waitFor(); await page.waitForTimeout(1000);
   await page.evaluate(async () => {
    const { chat } = await import('/src/lib/pilotChat.svelte.ts');
    const id = chat.sessions.find(s => s.title === 'Atlas planning').id;
    chat.sessions = chat.sessions.map(s => s.id === id ? { ...s, messages: [], detailRevision: undefined } : s);
    const fetch = window.fetch.bind(window); window.detailRequests = 0;
    window.fetch = async (input, init) => {
     const url = new URL(input instanceof Request ? input.url : String(input), location.href);
     if (url.pathname === '/api/pilot/chat/session' && url.searchParams.get('id') === id) {
      window.detailRequests++;
      if (window.detailRequests === 1) await new Promise(resolve => window.releaseDetail = resolve);
      if (window.failDetails) return new Response(JSON.stringify({ error: 'Sample history unavailable' }), { status: 503 });
     }
     return fetch(input, init);
    };
   });
   await page.keyboard.press('j');
   const agent = () => page.locator('.workspace-menu .agent-row').filter({ hasText: 'Atlas planning' });
   await agent().focus(); await page.keyboard.press('Enter');
   await page.getByRole('region', { name: 'Pilot conversation', exact: true }).waitFor();
   await page.getByText('Loading conversation…', { exact: true }).waitFor();
   assert.equal(await page.getByRole('log', { name: 'Pilot messages' }).getAttribute('aria-busy'), 'true');
   await page.keyboard.press('Escape'); await agent().waitFor();
   await page.evaluate(() => window.releaseDetail()); await page.waitForTimeout(600);
   assert.equal(await page.locator('.pilot-panel').count(), 0, 'late detail cannot reopen a dismissed conversation');
   await page.evaluate(async () => {
    window.failDetails = true;
    const { chat } = await import('/src/lib/pilotChat.svelte.ts');
    chat.sessions = chat.sessions.map(s => s.title === 'Atlas planning' ? { ...s, messages: [], detailRevision: undefined } : s);
   });
   await agent().focus(); await page.keyboard.press('Enter');
   await page.getByRole('alert').filter({ hasText: 'Sample history unavailable' }).waitFor();
   const beforeRetry = await page.evaluate(() => { window.failDetails = false; return window.detailRequests; });
   await page.getByRole('button', { name: 'Retry', exact: true }).click();
   await page.locator('.pilot-panel [data-message-id="sample-answer"]').waitFor();
   assert.equal(await page.getByRole('log', { name: 'Pilot messages' }).getAttribute('aria-busy'), 'false');
   assert.equal(await page.getByRole('alert').filter({ hasText: 'Sample history unavailable' }).count(), 0);
   assert.equal(await page.evaluate(() => window.detailRequests), beforeRetry + 1);
   assert.deepEqual(errors, []);
   console.log(`PASS ${engine.name()}: immediate loading panel, Escape during fetch, no late reopen, inline failure and retry`);
  } finally { await browser.close(); }
 }
})().catch(e => { console.error(e); process.exitCode = 1; });
