/** Run against a Vite preview. All backend responses are fabricated. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const page = await browser.newPage();
    const base = process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5198';
    let chats = [{ id: 'pilot', revision: 1, phase: 'idle', draft: '', context: [], ingestions: [] }];
    let work = [{ id: 'worker', title: 'Worker', attention: { key: 'first' } }];
    await page.route(`${base}/`, r => r.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
    await page.route('**/api/**', r => {
      const path = new URL(r.request().url()).pathname;
      const body = path === '/api/pilot/chat' ? { sessions: chats } : path === '/api/pilot/work' ? { sessions: work } : {};
      return r.fulfill({ json: body });
    });
    await page.goto(base);
    await page.evaluate(async () => {
      const c = await import('/src/lib/pilotChat.svelte.ts');
      const w = await import('/src/lib/workSessions.svelte.ts');
      window.modules = { c, w };
      await c.refreshChats(); await w.refreshWork();
      window.before = { chats: c.chat.sessions, work: w.work.sessions };
      await c.refreshChats(); await w.refreshWork();
    });
    assert.deepEqual(await page.evaluate(() => ({
      chats: window.before.chats === window.modules.c.chat.sessions,
      work: window.before.work === window.modules.w.work.sessions,
    })), { chats: true, work: true });
    chats = [{ ...chats[0], revision: 2, draft: 'changed' }];
    work = [{ ...work[0], attention: { key: 'second' } }];
    assert.deepEqual(await page.evaluate(async () => {
      const { c, w } = window.modules;
      await c.refreshChats(); await w.refreshWork();
      return { revision: c.chat.sessions[0].revision, attention: w.work.sessions[0].attention.key };
    }), { revision: 2, attention: 'second' });
    chats = []; work = [];
    assert.deepEqual(await page.evaluate(async () => {
      const { c, w } = window.modules;
      await c.refreshChats(); await w.refreshWork();
      return [c.chat.sessions.length, w.work.sessions.length];
    }), [0, 0]);
    assert.deepEqual(await page.evaluate(async () => {
      const { app } = await import('/src/lib/store.svelte.ts');
      const { sourceAttention, unreadNodeIds, selectedReadSources } = await import('/src/lib/sourceAttention.svelte.ts');
      const path = 'log/insertions/message.json', other = 'log/insertions/other.json';
      const graph = { nodes: [{ id: 'thread', memberPaths: [path, other] }], edges: [] };
      sourceAttention.rows = [path, other].map(path => ({ path, readState: { unread: true, writable: true } }));
      app.graphView = { selected: ['thread', path], excluded: [] };
      const selected = selectedReadSources(graph).map(r => r.path);
      sourceAttention.rows[1].readState.writable = false;
      const writable = selectedReadSources(graph).map(r => r.path);
      app.graphView = { selected: [], excluded: [] };
      return { unread: unreadNodeIds(graph), selected, writable, empty: selectedReadSources(graph) };
    }), { unread: ['thread'], selected: ['log/insertions/message.json', 'log/insertions/other.json'], writable: ['log/insertions/message.json'], empty: [] });
    console.log('Unchanged polls, updates, removals, unread aliases and writable selection passed.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
