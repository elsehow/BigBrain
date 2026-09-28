// Run Vite, then SIDEBAR_PREVIEW_URL=http://127.0.0.1:5217 node test/support/pilotSummary.browser.cjs.
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    let chatUrl;
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.url().includes('/src/lib/pilotChat.svelte.ts')) chatUrl = r.url(); });
    await page.goto(`${process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5217'}/sidebar-workbench.html`);
    await page.locator('.lg-wrap').waitFor();
    await page.waitForFunction(async url => (await import(url)).chat.loaded, chatUrl);
    const id = 'pilot-11111111111111111111111111111111';
    const initial = await page.evaluate(async url => {
      const { chat } = await import(url);
      window.detailReads = [];
      const fetch = window.fetch.bind(window);
      window.fetch = (input, options) => {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (url.pathname === '/api/pilot/chat/session') window.detailReads.push(url.searchParams.get('id'));
        return fetch(input, options);
      };
      return chat.sessions.map(s => ({ messages: s.messages.length, count: s.messageCount, revision: s.detailRevision }));
    }, chatUrl);
    assert.equal(initial.length, 2);
    assert(initial.every(s => s.messages === 0 && s.count === 2 && s.revision === undefined), 'closed conversations start with summaries only');
    const search = await page.evaluate(async () => (await (await fetch('/api/pilot/chat?query=planned%20expansion')).json()).sessions);
    assert.equal(search.length, 2, 'search finds text in unopened transcripts');
    assert(search.every(s => !('messages' in s)), 'search also returns summaries');
    await page.evaluate(async ({ url, id }) => {
      const { loadChatDetail, openChat } = await import(url);
      await Promise.all([loadChatDetail(id), loadChatDetail(id), loadChatDetail(id)]);
      openChat(id);
    }, { url: chatUrl, id });
    await page.locator('.pilot-panel').getByText('What connects these project notes?', { exact: true }).waitFor();
    await page.waitForTimeout(3200);
    assert.deepEqual(await page.evaluate(() => window.detailReads), [id], 'concurrent opens coalesce and unchanged polls do not reread transcripts');
    await page.evaluate(() => window.dispatchEvent(new Event('workbench-agent-notification')));
    await page.locator('.pilot-panel').getByText(/Which date should I use for the Atlas plan\?/).first().waitFor();
    assert.deepEqual(await page.evaluate(() => window.detailReads), [id, id], 'a changed revision reloads only the opened transcript');
    assert.deepEqual(errors, []);
    console.log('PASS: summary-only startup, unopened history search, coalesced detail reads, stable polls, and live transcript updates.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
