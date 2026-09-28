/** Local Vite UI; Pilot data and all mutations are mocked. Other GETs are read-only. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({ headless: true, channel: 'chrome' });
 try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  let chatUrl, stops = 0, fail = false;
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.url().includes('/src/lib/pilotChat.svelte.ts')) chatUrl = r.url(); });
  const at = new Date().toISOString(), id = 'pilot-' + 'a'.repeat(32);
  const session = { id, title: 'Long-running Pilot', model: 'test', phase: 'working', lifecycle: 'active', context: [], seed: [], revision: 1, viewRevision: 0, draft: '', live: 'Reading sources…', activity: 'read_note', error: '', created: at, updated: at, messages: [] };
  await page.route('**/api/**', async r => {
   const path = new URL(r.request().url()).pathname;
   if (path === '/api/graph') return r.fulfill({ json: { nodes: [], edges: [], hash: 'stop-test' } });
   if (path === '/api/pilot/work') return r.fulfill({ json: { sessions: [] } });
   if (path === '/api/source/read-state') return r.fulfill({ json: { sources: [] } });
   if (path === '/api/pilot/chat') return r.fulfill({ json: { sessions: [session] } });
   if (path === '/api/pilot/chat/notifications') return r.fulfill({ json: { notifications: [] } });
   if (path === '/api/pilot/chat/stop') {
    stops++;
    if (fail) return r.fulfill({ status: 503, json: { error: 'Unavailable' } });
    session.phase = 'interrupted'; session.revision++;
    return r.fulfill({ json: session });
   }
   if (path === '/api/pilot/chat/presence') return r.fulfill({ json: { ok: true } });
   if (r.request().method() !== 'GET') return r.fulfill({ status: 400, json: { error: 'Mock only' } });
   return r.continue();
  });
  await page.goto(process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5198');
  await page.waitForFunction(() => performance.getEntriesByType('resource').some(e => e.name.includes('/src/lib/pilotChat.svelte.ts')));
  const open = () => page.evaluate(async ({ url, id }) => { const m = await import(url); await m.refreshChats(); m.openChat(id); }, { url: chatUrl, id });
  await open();
  const input = page.getByRole('textbox', { name: 'Message Pilot' });
  const stop = page.getByRole('button', { name: 'Interrupt Pilot', exact: true });
  await stop.click(); await page.waitForFunction(() => document.querySelector('.pilot-panel')?.getAttribute('data-phase') === 'interrupted');
  assert.equal(stops, 1); assert.equal(await input.count(), 1);
  session.phase = 'working'; session.revision++; await open(); await stop.waitFor(); await input.focus();
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform || navigator.userAgent));
  await page.keyboard.press(mac ? 'Meta+.' : 'Control+.');
  await page.waitForFunction(() => document.querySelector('.pilot-panel')?.getAttribute('data-phase') === 'interrupted');
  assert.equal(stops, 2); assert.equal(await input.count(), 1);
  session.phase = 'working'; session.revision++; fail = true; await open(); await stop.waitFor(); await stop.click();
  await page.waitForFunction(() => document.querySelector('.pilot-panel')?.getAttribute('data-phase') === 'working');
  assert.equal(stops, 3); assert.equal(await input.count(), 1);
  assert.deepEqual(errors, []);
  console.log('Stop button, command-period in composer, retained conversation and failure recovery passed.');
 } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
