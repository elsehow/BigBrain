/** Production navigation and composer with fabricated migration APIs. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({ channel: 'chrome' });
 try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let storeUrl, chatUrl, workerMutations = 0, sends = 0;
  page.on('request', r => {
   if (r.url().includes('/src/lib/store.svelte.ts')) storeUrl = r.url();
   if (r.url().includes('/src/lib/pilotChat.svelte.ts')) chatUrl = r.url();
  });
  const id = `pilot-${'c'.repeat(32)}`, worker = `work-${'d'.repeat(32)}`, at = '2026-09-01T12:00:00Z';
  const p = { id, title: 'Legacy severity research', model: 'gpt-5.6-terra', phase: 'answered', lifecycle: 'dormant',
   context: ['topic'], seed: ['topic'], viewRevision: 0, revision: 1, draft: '', live: '', activity: '', error: '', created: at, updated: at,
   legacyWork: { id: worker, provider: 'claude-code', thread: 'old-thread', cwd: '/demo', outputs: [] },
   messages: [{ id: 'task', role: 'user', text: 'Research severity.', at }, { id: 'answer', role: 'assistant', text: 'Original severity findings.', at }] };
  await page.route('**/api/**', async r => {
   const u = new URL(r.request().url()), b = r.request().postDataJSON() ?? {};
   if (u.pathname === '/api/graph') return r.fulfill({ json: { nodes: [
    { id: 'topic', path: 'memory/topic', title: 'Topic', group: 'memory', degree: 1, x: 0, y: 0 },
    { id: 'old-source', path: 'sources/old-transcript', title: p.title, group: 'source', degree: 1, from: 'claude-code', sessionId: 'old-thread', x: 100, y: 100 },
   ], edges: [{ source: 'topic', target: 'old-source' }], hash: 'migration' } });
   if (u.pathname.startsWith('/api/pilot/chat')) {
    const action = u.pathname.slice('/api/pilot/chat'.length);
    if (!action) return r.fulfill({ json: { sessions: [p] } });
    if (action === '/notifications') return r.fulfill({ json: { notifications: [] } });
    if (action === '/presence') return r.fulfill({ json: { ok: true } });
    if (action === '/draft') p.draft = b.text;
    else if (action === '/send') {
     assert.equal(b.id, id); assert.equal(b.text, 'Explain the findings'); assert.equal(b.target, undefined);
     sends++; p.draft = ''; p.lifecycle = 'active';
     p.messages.push({ id: 'followup', role: 'user', text: b.text, at }, { id: 'continued', role: 'assistant', text: 'Continued through Pilot.', at });
    } else return r.fulfill({ status: 400, json: { error: 'Unsupported mock action' } });
    p.revision++; return r.fulfill({ json: p });
   }
   if (u.pathname.startsWith('/api/pilot/work')) {
    if (r.request().method() !== 'GET') workerMutations++;
    return r.fulfill({ json: { sessions: [{ id: worker, title: p.title, status: 'idle', provider: 'claude-code', migratedToPilot: id, created: at, updated: at, context: {}, cwd: '/demo' }] } });
   }
   if (r.request().method() !== 'GET') return r.fulfill({ status: 400, json: { error: 'No real mutations allowed' } });
   if (u.pathname === '/api/setup') return r.fulfill({ status: 404, json: {} });
   if (u.pathname === '/api/events') return r.fulfill({ contentType: 'text/event-stream', body: ': hello\n\n' });
   if (u.pathname === '/api/vault') return r.fulfill({ json: { inbox: { pending: 0, unsorted: 0 }, requests: { open: 0, done: 0 } } });
   return r.fulfill({ json: { sessions: [], workers: [], sources: [], groups: [], recent: [], notes: [], configured: false } });
  });
  await page.goto(process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5231');
  await page.waitForFunction(() => document.querySelector('.g-canvas'));
  const pilot = page.getByRole('region', { name: 'Pilot conversation' });
  for (const alias of [`sessions/${worker}.md`, 'sources/old-transcript']) {
   await page.evaluate(async ({ storeUrl, chatUrl, alias }) => {
    const chat = await import(chatUrl); await chat.refreshChats();
    const store = await import(storeUrl); store.gotoNote(alias);
   }, { storeUrl, chatUrl, alias });
   await pilot.waitFor();
   await pilot.getByText('Original severity findings.', { exact: true }).waitFor();
   assert.equal(await page.getByRole('region', { name: 'Worker monitor' }).count(), 0);
  }
  const composer = pilot.locator('[contenteditable="true"]');
  await composer.fill('Explain the findings'); await composer.press('Enter');
  await pilot.getByText('Continued through Pilot.', { exact: true }).waitFor();
  assert.equal(sends, 1); assert.equal(workerMutations, 0); assert.deepEqual(errors, []);
  console.log('PASS: old worker and transcript links open Pilot; follow-up uses Pilot with history intact.');
 } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
