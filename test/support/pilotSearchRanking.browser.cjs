/** Real mention composer and general-search merge, with all APIs intercepted. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({ channel: 'chrome' });
 try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let chatUrl, searchPurpose, releaseSearch, searchRequested;
  const pendingSearch = new Promise(resolve => { searchRequested = resolve; });
  page.on('request', r => { if (r.url().includes('/src/lib/pilotChat.svelte.ts')) chatUrl = r.url(); });
  const id = `pilot-${'c'.repeat(32)}`, at = new Date().toISOString();
  const current = { id, title: 'Current conversation', model: 'gpt-5.6-terra', phase: 'answered', lifecycle: 'active',
   context: [], seed: [], viewRevision: 0, revision: 1, draft: '', live: '', activity: '', error: '', created: at, updated: at,
   messages: [{ id: 'answer', role: 'assistant', text: 'Ready.', at }] };
  const old = { ...current, id: `pilot-${'d'.repeat(32)}`, title: 'How ATLAS severity graphs could improve', lifecycle: 'dormant',
   messages: [{ id: 'old', role: 'assistant', text: 'ATLAS research.', at }] };
  const project = 'projection/entities/atlas';
  const hits = [
   { title: 'ATLAS', dir: 'source', snippet: '', searchImportance: 0.15, note: { path: 'source/atlas', name: 'ATLAS', modified: Date.now(), size: 0 } },
   { title: 'ATLAS — current project', dir: 'memory', snippet: '', searchImportance: 1.12, note: { path: 'memory/atlas', name: 'ATLAS', modified: 0, size: 0 } },
   { title: 'ATLAS planning notes', dir: 'source', snippet: '', note: { path: 'source/notes', name: 'notes', modified: Date.now(), size: 0 } },
   { title: 'ATLAS', dir: 'projection/entities', snippet: '', note: { path: project, name: 'ATLAS', modified: 0, size: 0 } },
  ];
  await page.route('**/api/**', async r => {
   const u = new URL(r.request().url()), b = r.request().postDataJSON() ?? {};
   if (u.pathname === '/api/graph') return r.fulfill({ json: { nodes: [{ id: project, path: project, title: 'ATLAS', group: 'entity', degree: 0, memorySupport: 1 }], edges: [], hash: 'rank' } });
   if (u.pathname === '/api/search') { searchPurpose = u.searchParams.get('purpose'); if (searchPurpose !== 'mention') await new Promise(resolve => { releaseSearch = resolve; searchRequested(); }); return r.fulfill({ json: { hits, nextOffset: null } }); }
   if (u.pathname.startsWith('/api/pilot/chat')) {
    const action = u.pathname.slice('/api/pilot/chat'.length);
    if (!action) return r.fulfill({ json: { sessions: [current, old] } });
    if (action === '/notifications') return r.fulfill({ json: { notifications: [] } });
    if (action === '/presence') return r.fulfill({ json: { ok: true } });
    if (action === '/draft') current.draft = b.text;
    else if (action === '/context-add') current.context = [...new Set([...current.context, ...b.nodes])];
    else return r.fulfill({ status: 400, json: { error: 'Unsupported mock action' } });
    current.revision++; return r.fulfill({ json: current });
   }
   if (r.request().method() !== 'GET') return r.fulfill({ status: 400, json: { error: 'No real mutations' } });
   if (u.pathname === '/api/setup') return r.fulfill({ status: 404, json: {} });
   if (u.pathname === '/api/events') return r.fulfill({ contentType: 'text/event-stream', body: ': hello\n\n' });
   if (u.pathname === '/api/vault') return r.fulfill({ json: { inbox: { pending: 0, unsorted: 0 }, requests: { open: 0, done: 0 } } });
   return r.fulfill({ json: { sessions: [], workers: [], sources: [], groups: [], recent: [], notes: [], configured: false } });
  });
  await page.goto(process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5231');
  await page.waitForFunction(() => document.querySelector('.g-canvas'));
  await page.evaluate(async chatUrl => { const m = await import(chatUrl); await m.refreshChats(); }, chatUrl);
  const field = page.getByRole('combobox', { name: 'Search the vault' });
  await field.fill('atlas');
  const searchRows = page.locator('.search-results [role=option]');
  await searchRows.filter({ hasText: old.title }).waitFor();
  assert.equal(await searchRows.first().getAttribute('aria-selected'), 'true');
  // Wait for the request to be held, then let the better server hits arrive.
  await pendingSearch;
  releaseSearch();
  await searchRows.filter({ hasText: 'ATLAS planning notes' }).waitFor();
  assert.match(await searchRows.first().innerText(), /(?:^|\n)ATLAS\s+ENTITY/);
  assert.equal(await searchRows.first().getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.search-viewport').evaluate(el => el.scrollTop), 0);
  await field.press('Enter');
  await page.waitForURL(/projection\/entities\/atlas/);
  assert.equal(await page.locator('.search-results').count(), 0);
  await page.evaluate(async ({ chatUrl, id }) => { const m = await import(chatUrl); await m.refreshChats(); m.openChat(id); }, { chatUrl, id });
  const input = page.getByRole('textbox', { name: 'Message Pilot' });
  await input.fill('@atlas');
  const choices = page.getByRole('option');
  await choices.filter({ hasText: 'ATLAS planning notes' }).waitFor();
  assert.equal(searchPurpose, 'mention');
  assert.match(await choices.first().innerText(), /(?:^|\n)ATLAS\s+ENTITY/);
  assert.equal(await choices.first().getAttribute('aria-selected'), 'true');
  assert.equal(await choices.filter({ hasText: old.title }).count(), 1);
  await input.press('Enter');
  assert.equal(await input.locator(`[data-mention="${project}"]`).count(), 1);
  assert.deepEqual(errors, []);
  console.log('PASS: delayed search keeps ATLAS visible and selected; Enter opens the entity. @atlas ranks the project first; Enter attaches it, with old Pilots still searchable below.');
 } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
