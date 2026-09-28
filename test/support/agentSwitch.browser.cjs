/** Synthetic agent navigation and deferred mention regression. All APIs mocked. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage();
    const errors = []; let chatUrl; let noteReads = 0;
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.url().includes('/src/lib/pilotChat.svelte.ts')) chatUrl = r.url(); });
    const at = new Date().toISOString();
    const sessions = ['a', 'b'].map((letter, i) => ({ id: `pilot-${letter.repeat(32)}`, title: `Agent ${letter}`, phase: 'answered', lifecycle: 'active', model: 'gpt-6-astra', context: [`memory-${i}`], seed: [`memory-${i}`], revision: 1, viewRevision: 0, draft: '', live: '', activity: '', error: '', created: at, updated: at, messages: [{ id: letter, role: 'assistant', text: `Answer ${letter}`, at }] }));
    const graph = { hash: 'switch', nodes: [0, 1].flatMap(i => [
      { id: `memory-${i}`, path: `memory/topic-${i}.md`, title: `Topic ${i}`, group: 'memory', degree: 1, x: i * 100, y: 0 },
      { id: `source-${i}`, path: `source/item-${i}.md`, title: `Connected ${i}`, group: 'source', degree: 1, x: i * 100, y: 50 },
    ]), edges: [0, 1].map(i => ({ source: `memory-${i}`, target: `source-${i}` })) };
    await page.route('**/api/**', r => {
      const u = new URL(r.request().url()); const body = r.request().postDataJSON() || {};
      if (u.pathname === '/api/graph') return r.fulfill({ json: graph });
      if (u.pathname === '/api/pilot/chat') return r.fulfill({ json: { sessions } });
      if (u.pathname === '/api/pilot/chat/draft') { const s = sessions.find(s => s.id === body.id); s.draft = body.text; s.revision++; return r.fulfill({ json: s }); }
      if (u.pathname === '/api/note') { noteReads++; return r.fulfill({ json: { content: 'An explicitly linked [[source/item-0|Connected 0]].' } }); }
      if (u.pathname === '/api/setup') return r.fulfill({ status: 404, json: {} });
      if (u.pathname === '/api/events') return r.fulfill({ contentType: 'text/event-stream', body: ': hello\n\n' });
      if (u.pathname === '/api/vault') return r.fulfill({ json: { inbox: { pending: 0, unsorted: 0 }, requests: { open: 0, done: 0 } } });
      return r.fulfill({ json: { ok: true, sessions: [], notifications: [], workers: [], sources: [], groups: [], recent: [], nextOffset: null, notes: [], configured: false } });
    });
    await page.goto(process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5219');
    const open = id => page.evaluate(async ({ url, id }) => { const m = await import(url); await m.refreshChats(); m.openChat(id); }, { url: chatUrl, id });
    const input = page.getByRole('textbox', { name: 'Message Pilot' });
    for (const s of sessions) { await open(s.id); await input.waitFor(); }
    await input.blur();
    for (const [key, s] of [['h', sessions[0]], ['l', sessions[1]], ['h', sessions[0]]]) {
      await page.keyboard.press(key);
      await page.waitForFunction(id => location.hash.endsWith(id), s.id);
      await page.getByRole('region', { name: 'Pilot text tab' }).getByText(s.title, { exact: true }).waitFor();
    }
    assert.equal(noteReads, 0, 'Switching must not fetch memory bodies for an unopened picker');
    await input.fill('@');
    await page.getByRole('option').filter({ hasText: 'Connected 0' }).waitFor();
    await page.waitForFunction(() => document.querySelector('.mention-menu')?.textContent.includes('Mentioned in Topic 0'));
    assert.ok(noteReads > 0);
    await input.fill(''); await input.blur();
    await page.keyboard.press('l');
    await page.waitForFunction(id => location.hash.endsWith(id), sessions[1].id);
    await input.fill('@');
    await page.getByRole('option').filter({ hasText: 'Connected 1' }).waitFor();
    await input.fill(''); await input.blur();
    // Backend context changes invalidate the prepared overlay, even in-place on the same session.
    sessions[1].context = ['memory-0']; sessions[1].viewRevision++; sessions[1].revision++;
    await open(sessions[1].id);
    await input.fill('@');
    await page.getByRole('option').filter({ hasText: 'Connected 0' }).waitFor();
    assert.equal(await page.getByRole('option').filter({ hasText: 'Connected 1' }).count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS h/l history, deferred memory reads, mention suggestions across sessions and context updates');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
