/** Real composer under streaming/polling updates; all chat writes are mocked. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({ headless: true, channel: 'chrome' });
 try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  let chatUrl;
  const errors = [], sent = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.url().includes('/src/lib/pilotChat.svelte.ts')) chatUrl = r.url(); });
  const at = new Date().toISOString(), id = 'pilot-' + 'a'.repeat(32);
  const session = { id, title: 'Typing test', model: 'test', phase: 'working', lifecycle: 'active', context: [], seed: [], revision: 1, viewRevision: 0, draft: '', live: 'Working…', activity: 'read_note', error: '', created: at, updated: at, messages: [], pendingInputs: [] };
  await page.route('**/api/**', async r => {
   const path = new URL(r.request().url()).pathname;
   if (path === '/api/graph') return r.fulfill({ json: { nodes: [], edges: [], hash: 'typing-test' } });
   if (path === '/api/pilot/work') return r.fulfill({ json: { sessions: [] } });
   if (path === '/api/pilot/chat') { session.revision++; session.live += ' streaming'; return r.fulfill({ json: { sessions: [session] } }); }
   if (path === '/api/pilot/chat/notifications') return r.fulfill({ json: { notifications: [] } });
   if (path === '/api/pilot/chat/presence') return r.fulfill({ json: { ok: true } });
   if (path === '/api/pilot/chat/draft') { session.draft = r.request().postDataJSON().text; session.revision++; return r.fulfill({ json: session }); }
   if (path === '/api/pilot/chat/send') {
    const b = r.request().postDataJSON(); sent.push(b.text);
    session.pendingInputs.push({ id: b.inputId, text: b.text, mode: b.mode }); session.draft = ''; session.revision++;
    return r.fulfill({ json: session });
   }
   if (r.request().method() !== 'GET') return r.fulfill({ json: {} });
   return r.continue();
  });
  await page.goto(process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5221');
  await page.waitForFunction(() => performance.getEntriesByType('resource').some(e => e.name.includes('/src/lib/pilotChat.svelte.ts')));
  await page.evaluate(async ({ url, id }) => { const m = await import(url); await m.refreshChats(); m.openChat(id); }, { url: chatUrl, id });
  const input = page.getByRole('textbox', { name: 'Message Pilot' });
  await input.click();
  const text = 'Please also check the logs while you investigate.';
  await page.keyboard.type(text, { delay: 65 });
  assert.equal(await input.innerText(), text);
  // A poll or a draft-save response must not move an in-progress caret.
  await page.keyboard.press('Home');
  await page.keyboard.type('First: ', { delay: 80 });
  assert.equal(await input.innerText(), 'First: ' + text);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('[aria-label="Queued messages"]'));
  assert.equal(sent[0], 'First: ' + text);
  assert.equal(await input.innerText(), '');
  await page.keyboard.type('And keep the results.', { delay: 65 });
  await page.getByRole('button', { name: '↵ Queue', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.queued-input').length === 2);
  assert.deepEqual(sent, ['First: ' + text, 'And keep the results.']);
  await input.focus();
  // The editable can retain focus after its browser selection is lost.
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.keyboard.type('Still typing');
  assert.equal(await input.innerText(), 'Still typing');
  assert.deepEqual(errors, []);
  console.log('Typing and caret preserved during streaming; Enter and button both queue follow-ups.');
 } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
