/** Production shell: graph IDs are not note API paths. All APIs are synthetic. */
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const reads = [], errors = [];
    const nodes = [
      { id: 'memory/workspace.md', path: 'memory/workspace.md', title: 'Workspace', group: 'memory', degree: 2 },
      { id: 'ent_' + 'a'.repeat(20), path: 'projection/entities/ent_' + 'a'.repeat(20) + '.md', title: 'Preview entity', group: 'entity', degree: 1 },
      { id: 'source:ins_' + 'b'.repeat(24), path: 'log/insertions/2026-09/ins_' + 'b'.repeat(24) + '.json', title: 'Preview source', group: 'source', degree: 1 },
    ];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/**', r => {
      const u = new URL(r.request().url());
      const ok = json => r.fulfill({ json });
      if (u.pathname === '/api/graph') return ok({ hash: 'note-preview-path', nodes, edges: nodes.slice(1).map(n => ({ source: nodes[0].id, target: n.id })) });
      if (u.pathname === '/api/note') {
        const path = u.searchParams.get('path'); reads.push(path);
        const node = nodes.find(n => n.path === path);
        return node ? ok({ path, content: '# ' + node.title }) : r.fulfill({ status: 404, body: 'no such note' });
      }
      if (u.pathname === '/api/setup') return r.fulfill({ status: 404, json: {} });
      if (u.pathname === '/api/events') return r.fulfill({ contentType: 'text/event-stream', body: ': hello\n\n' });
      if (u.pathname === '/api/note/briefing') return ok({ briefing: { key: 'preview', summary: 'Preview summary.', links: [], generatedAt: new Date().toISOString(), model: 'test' } });
      if (u.pathname === '/api/vault') return ok({ inbox: { pending: 0, unsorted: 0 }, requests: { open: 0, done: 0 } });
      return ok({ ok: true, sessions: [], notifications: [], workers: [], sources: [], groups: [], recent: [], nextOffset: null, notes: [], configured: false });
    });
    await page.goto(`${process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5228'}/sidebar-workbench.html?vault=live`);
    await page.locator('.lg-wrap').waitFor();
    await page.waitForFunction(() => {
      window.dispatchEvent(new Event('sidebar:camera'));
      const state = JSON.parse(document.querySelector('.sidebar-presentation').textContent || '{}');
      return state.nodes?.length === 3 && state.nodes.every(n => n.visible);
    });
    for (const node of nodes.slice(1)) {
      await page.mouse.move(1400, 950);
      await page.getByRole('region', {name:'Quick look'}).waitFor({state:'hidden'});
      const target = await page.evaluate(id => {
        window.dispatchEvent(new Event('sidebar:camera'));
        return JSON.parse(document.querySelector('.sidebar-presentation').textContent).nodes.find(n => n.id === id);
      }, node.id);
      assert(target?.visible, 'fixture node is visible');
      const before = reads.length;
      await page.mouse.move(target.x, target.y);
      await page.getByRole('region', { name: 'Quick look' }).waitFor();
      await page.waitForFunction(title => document.querySelector('.sidebar-quick .note-title')?.textContent === title, node.title);
      assert(reads.slice(before).includes(node.path), `preview must request ${node.path}; got ${JSON.stringify(reads.slice(before))}`);
      assert(!reads.includes(node.id), 'never send a graph ID to the note endpoint');
    }
    assert.deepEqual(errors, []);
    console.log('PASS: production graph previews read entity/source paths rather than graph IDs');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
