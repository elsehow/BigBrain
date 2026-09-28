const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5200';
(async () => {
 const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
 try {
  const page = await browser.newPage();
  await page.goto(`${base}/sidebar-workbench.html?scenario=resume-after-cancel`);
  await page.locator('.pilot-panel').waitFor();
  await page.evaluate(async () => {
   const { chat, loadChatDetail } = await import('/src/lib/pilotChat.svelte.ts');
   const { mergePilotSummary } = await import('/src/lib/pilotChatSync.ts');
   const current = chat.sessions.find(s => s.id === chat.activeId);
   const { messages: _messages, inputs: _inputs, spoken: _spoken, detail: _detail, detailRevision: _detailRevision, ...summary } = current;
   window.detailFixture = { ...summary, messages: [], inputs: [], spoken: [], revision: current.revision + 1, messageCount: 0, hasHistory: false };
   chat.sessions = [mergePilotSummary({ ...summary, revision: current.revision + 1 })];
   chat.drafts[current.id] = 'Local draft must survive';
   window.detailId = current.id;
   const fetch = window.fetch;
   window.allowDetailRetry = false;
   window.fetch = async (input, init) => {
    if (!String(input).startsWith('/api/pilot/chat/session')) return fetch(input, init);
    if (!window.allowDetailRetry) return Response.json({ error: 'Fabricated detail failure' }, { status: 503 });
    return new Promise(resolve => { window.releaseDetail = () => resolve(Response.json(window.detailFixture)); });
   };
   void loadChatDetail(current.id).catch(() => {});
  });
  await page.getByRole('alert').filter({ hasText: 'Fabricated detail failure' }).waitFor();
  // Summary polling may request detail again. Keep the service failing until
  // the deliberate retry, then switch and click in the same browser turn.
  await page.waitForFunction(async () => {
   const { activeChat } = await import('/src/lib/pilotChat.svelte.ts');
   if (activeChat().detail.status !== 'error') return false;
   window.allowDetailRetry = true;
   const retry = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Retry');
   if (!retry) throw new Error('Expected Retry button');
   retry.click();
   return true;
  });
  await page.getByRole('status').filter({ hasText: 'Loading conversation' }).waitFor();
  await page.evaluate(() => window.releaseDetail());
  await page.waitForFunction(async () => (await import('/src/lib/pilotChat.svelte.ts')).activeChat()?.detail.status === 'loaded');
  const result = await page.evaluate(async () => { const { activeChat, chat } = await import('/src/lib/pilotChat.svelte.ts'); return { messages: activeChat().messages, draft: chat.drafts[window.detailId] }; });
  assert.deepEqual(result.messages, []); assert.equal(result.draft, 'Local draft must survive');
  console.log('Production AppShell distinguishes failed/loading/empty detail and preserves local drafts through retry.');
 } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
