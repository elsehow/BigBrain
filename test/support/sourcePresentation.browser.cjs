// Production UI, fabricated imported mail. No mailbox writes or model calls.
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
 const useWebkit = process.env.BROWSER === 'webkit';
 const browser = await (useWebkit ? webkit.launch({ headless: true, ...(process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {}) }) : chromium.launch({ headless: true, channel: 'chrome' }));
 try {
  const page = await browser.newPage({ viewport: { width: 840, height: 900 }, deviceScaleFactor: 2 });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const at = Date.parse('2026-09-16T22:29:00Z');
  const title = 'Little Paws Outdoor Classroom - Information';
  const thread = 'projection/threads/thread_mail.md', oldThread = 'projection/threads/thread_old.md';
  const message = 'log/insertions/2026-09/ins_000000000000000000000001.json';
  const nodes = [{ id: 'thread_mail', path: thread, memberPaths: [message, oldThread], title, group: 'source', degree: 1, x: 0, y: 0 },
   { id: 'note', path: 'memory/that-tracks.md', title: 'That Tracks', group: 'memory', degree: 1, x: 100, y: 100 }];
  let unread = true;
  const requests = [];
  await page.addInitScript(() => localStorage.setItem('bigbrain:theme', 'web'));
  await page.route('**/api/**', async route => {
   const req = route.request(), url = new URL(req.url()), path = url.pathname;
   const ok = json => route.fulfill({ json });
   if (path === '/api/setup') return route.fulfill({ status: 404, json: {} });
   if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': hello\n\n' });
   if (path === '/api/vault') return ok({ inbox: { pending: 0, unsorted: 0 }, requests: { open: 0, done: 0 } });
   if (path === '/api/graph') return ok({ nodes, edges: [{ source: 'thread_mail', target: 'note' }], hash: 'source-presentation' });
   if (path === '/api/source/read-state') {
    assert.equal(req.method(), 'GET'); requests.push(url.searchParams.get('refresh'));
    // Only the individual imported message is observed. The popup must resolve
    // its older thread path and update in place when Gmail flags change.
    return ok({ scope: 'stored_sources', sources: [{ path: message, title, readState: { unread, provider: 'email', writable: true, status: 'synced' } }] });
   }
   if (path === '/api/recent') return ok({ recent: [{ path: oldThread, title, modified: at },
    { path: 'memory/that-tracks.md', title: 'That Tracks', modified: at },
    { path: 'log/insertions/2026-09/ins_000000000000000000000002.json', title: 'Claude Code — iclr-2026 (2026-09-16)', modified: at }], nextOffset: null });
   if (path === '/api/note') return ok({ path: url.searchParams.get('path'), content: '# That Tracks\n\nA short note.', modified: at });
   if (path === '/api/note/briefing') return ok({ briefing: { key: 'test', summary: 'Project threads and their current status.', links: [], generatedAt: new Date(at).toISOString(), model: 'test' } });
   if (path === '/api/pilot/chat') return ok({ sessions: [] });
   if (path === '/api/pilot/chat/notifications') return ok({ notifications: [] });
   if (path === '/api/entity/folds') return ok({ groups: [] });
   if (path === '/api/pilot') return ok({ configured: false, enabled: false });
   if (path === '/api/agents/models') return ok({ agents: [] });
   if (path === '/api/pilot/chat/backend') return ok({ adapter: 'codex', model: 'test' });
   if (path.includes('/work')) return ok({ sessions: [], workers: [] });
   return ok({ sessions: [], workers: [], notes: [], groups: [], configured: false });
  });
  const base = process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5198';
  await page.goto(base);
  await page.keyboard.press('Meta+k');
  await page.getByRole('combobox', { name: 'Search the vault' }).click();
  const mail = page.getByRole('option', { name: title + ', unread', exact: true });
  await mail.waitFor();
  assert.equal(await mail.locator('.hit-kind').textContent(), 'Unread');
  await page.getByRole('button', { name: 'Select all 1 unread sources' }).waitFor();
  for (const width of [840, 700, 390]) {
   await page.setViewportSize({ width, height: 900 });
   const box = await mail.boundingBox(); assert.ok(box.height <= 44, JSON.stringify(box));
   assert.ok(await mail.evaluate(e => e.scrollWidth <= e.clientWidth), 'row overflows');
  }
  await page.setViewportSize({ width: 840, height: 900 });
  await page.screenshot({ path: `/tmp/bb-source-rows-${useWebkit ? 'webkit' : 'chrome'}.png` });
  unread = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('option', { name: title, exact: true }).waitFor();
  assert.ok(requests.includes('1'), 'focus must bypass the read-state cache');
  await page.keyboard.press('Escape');
  await page.goto(base + '/#/vault/' + encodeURIComponent('memory/that-tracks.md'));
  await page.getByRole('heading', { name: 'That Tracks', exact: true }).waitFor();
  const before = await page.locator('.hud-header').boundingBox();
  assert.equal(await page.locator('.note-shortcuts kbd').count() > 0, true);
  await page.goto(base + '/#/settings/vault');
  const hints = page.getByRole('switch', { name: 'Show keyboard hints', exact: true });
  await hints.waitFor(); assert.equal(await hints.isChecked(), true);
  await hints.uncheck();
  await page.goto(base + '/#/vault/' + encodeURIComponent('memory/that-tracks.md'));
  await page.getByRole('heading', { name: 'That Tracks', exact: true }).waitFor();
  assert.equal(await page.locator('.note-shortcuts kbd').count(), 0);
  assert.equal(await page.locator('.hud-header .key-hint').count(), 0);
  const after = await page.locator('.hud-header').boundingBox();
  assert.ok(after.height < before.height, JSON.stringify({ before, after }));
  assert.equal(await page.getByRole('button', { name: 'PILOT', exact: true }).isVisible(), true);
  await page.screenshot({ path: `/tmp/bb-hidden-hints-${useWebkit ? 'webkit' : 'chrome'}.png` });
  await page.reload(); await page.getByRole('heading', { name: 'That Tracks', exact: true }).waitFor();
  assert.equal(await page.locator('.note-shortcuts kbd').count(), 0);
  await page.goto(base + '/#/settings/vault'); await hints.check();
  await page.goto(base + '/#/vault/' + encodeURIComponent('memory/that-tracks.md'));
  await page.getByRole('heading', { name: 'That Tracks', exact: true }).waitFor();
  assert.ok(await page.locator('.note-shortcuts kbd').count() > 0);
  assert.deepEqual(errors, []);
  console.log('PASS: imported thread unread alias, live flag refresh, single-line source rows, persisted keyboard-hint toggle and compact header.');
 } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
