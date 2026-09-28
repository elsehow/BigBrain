/** Production HomeView with fabricated Pilot/worker APIs. Never stops real work. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({ channel: 'chrome' });
 try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript(() => {
    const clear = CanvasRenderingContext2D.prototype.clearRect, arc = CanvasRenderingContext2D.prototype.arc;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) { this.canvas.__circles = []; return clear.apply(this, args); };
    CanvasRenderingContext2D.prototype.arc = function (x, y, r, ...args) {
      if (this.globalAlpha > 0.05 && r > 2) (this.canvas.__circles ??= []).push([x, y]);
      return arc.call(this, x, y, r, ...args);
    };
  });
  const graphCircles = async () => {
    await page.waitForTimeout(1400);
    return page.locator('.g-canvas canvas:not([aria-hidden])').evaluate(canvas =>
      [...new Set((canvas.__circles ?? []).map(p => p.map(v => Math.round(v)).join(',')))].sort());
  };
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let chatUrl, workUrl;
  page.on('request', r => { if (r.url().includes('/src/lib/pilotChat.svelte.ts')) chatUrl = r.url(); if (r.url().includes('/src/lib/workSessions.svelte.ts')) workUrl = r.url(); });
  const id = `pilot-${'c'.repeat(32)}`, worker = `work-${'d'.repeat(32)}`, at = new Date().toISOString();
  const p = { id, title: 'Pilot with agent', model: 'gpt-6-astra', phase: 'answered', lifecycle: 'active', context: ['context-node'], seed: ['context-node'], viewRevision: 0, revision: 1, draft: '', live: '', activity: '', error: '', created: at, updated: at, messages: [{ id: 'answer', role: 'assistant', text: 'The worker is researching this.', at }] };
  const job = { id: worker, title: 'Research agent', provider: 'codex', model: 'gpt-6-astra', status: 'working', context: { nodes: ['context-node'] }, origin: { pilot: id, message: 'answer' }, cwd: '/demo', created: at, updated: at, receipts: [], messages: [{ id: 'task', role: 'user', text: 'Research the selected project.', at }] };
  const otherJob = { ...job, id: `work-${'e'.repeat(32)}`, title: 'Second agent' };
  const extra = Array.from({ length: 12 }, (_, i) => ({ id: `extra-${i}`, title: `Unrelated ${i}`, group: 'source', degree: 1, x: 300 + i * 20, y: 100 + i * 30 }));
  job.context.nodes.push(...extra.map(n => n.id));
  let stops = 0, opens = 0;
  job.messages.push(...Array.from({ length: 30 }, (_, i) => ({ id: `progress-${i}`, role: 'assistant', text: `Research progress ${i + 1}.\n\nDetails of the latest findings.`, at })));
  await page.route('**/api/**', async r => {
   const u = new URL(r.request().url()), b = r.request().postDataJSON() ?? {};
   if (u.pathname === '/api/graph') return r.fulfill({ json: { nodes: [{ id: 'context-node', path: 'memory/project', title: 'Project context', group: 'memory', degree: 1, x: 0, y: 0 }, ...extra], edges: [], hash: 'agent-parent-view' } });
   if (u.pathname.startsWith('/api/pilot/chat')) {
    const action = u.pathname.slice('/api/pilot/chat'.length);
    if (!action) return r.fulfill({ json: { sessions: [p] } });
    if (action === '/notifications') return r.fulfill({ json: { notifications: [] } });
    if (action === '/presence') return r.fulfill({ json: { ok: true } });
    if (action === '/draft') p.draft = b.text;
    else if (action === '/stop-tree') {
     assert.equal(b.confirmed, true); stops++; job.status = 'interrupted'; p.lifecycle = 'dormant'; p.deactivatedAt = at;
    } else return r.fulfill({ status: 400, json: { error: 'Unsupported mock action' } });
    p.revision++; return r.fulfill({ json: p });
   }
   if (u.pathname.startsWith('/api/pilot/work')) {
    if (u.pathname.endsWith('/open')) { opens++; return r.fulfill({ json: job }); }
    return r.fulfill({ json: u.searchParams.has('id') ? (u.searchParams.get('id') === otherJob.id ? otherJob : job) : { sessions: [job, otherJob] } });
   }
   if (r.request().method() !== 'GET') return r.fulfill({ status: 400, json: { error: 'No real mutations allowed' } });
   if (u.pathname === '/api/setup') return r.fulfill({ status: 404, json: {} });
   if (u.pathname === '/api/events') return r.fulfill({ contentType: 'text/event-stream', body: ': hello\n\n' });
   if (u.pathname === '/api/vault') return r.fulfill({ json: { inbox: { pending: 0, unsorted: 0 }, requests: { open: 0, done: 0 } } });
   return r.fulfill({ json: { sessions: [], workers: [], sources: [], groups: [], recent: [], notes: [], configured: false } });
  });
  await page.goto(process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5198');
  const openPilot = () => page.evaluate(async ({ url, id }) => { const mod = await import(url); await mod.refreshChats(); mod.openChat(id); }, { url: chatUrl, id });
  await openPilot();
  const pilot = page.getByRole('region', { name: 'Pilot conversation' }); await pilot.waitFor();
  const pilotCircles = await graphCircles(); assert.ok(pilotCircles.length > 0);
  await page.evaluate(async ({ url, worker }) => { const mod = await import(url); await mod.refreshWork(); mod.selectWork(worker); }, { url: workUrl, worker });
  const agent = page.getByRole('region', { name: 'Worker monitor' }); await agent.waitFor();
  await page.waitForFunction(() => {
   const pane = document.querySelector('.worker-panel .body');
   return pane && pane.scrollHeight > pane.clientHeight && pane.scrollHeight - pane.clientHeight - pane.scrollTop < 2;
  });
  await agent.locator('.body').evaluate(el => { el.scrollTop = 0; });
  await page.waitForTimeout(1200);
  assert.equal(await agent.locator('.body').evaluate(el => el.scrollTop), 0, 'Polling preserves reading position');
  assert.deepEqual(await graphCircles(), pilotCircles, 'Agent selection must preserve Pilot membership and camera');
  await page.evaluate(async ({ url, id }) => (await import(url)).selectWork(id), { url: workUrl, id: otherJob.id });
  await agent.locator('header strong').filter({ hasText: 'Second agent' }).waitFor();
  assert.deepEqual(await graphCircles(), pilotCircles, 'Sibling agents share one Pilot view');
  await page.goBack();
  await agent.locator('header strong').filter({ hasText: 'Research agent' }).waitFor();
  await page.locator('.pilot-view').getByText('Pilot with agent', { exact: true }).waitFor();
  assert.equal(await page.evaluate(async url => (await import(url)).work.graph.nodes.find(n => n.id === 'context-node').pilotContext, workUrl), true);
  assert.equal(await agent.getByRole('button', { name: 'Back to Pilot' }).count(), 0);
  const tab = page.getByRole('region', { name: 'Agent text tab' }), standard = (await tab.boundingBox()).height;
  await agent.getByLabel('Message worker').focus(); await page.keyboard.press('Shift+ArrowUp'); await page.waitForTimeout(320);
  assert.ok((await tab.boundingBox()).height > standard + 200);
  await page.keyboard.press('Shift+ArrowDown'); await page.waitForTimeout(320);
  assert.ok(Math.abs((await tab.boundingBox()).height - standard) < 2);
  await agent.locator('header strong').click(); await page.keyboard.press('Meta+o'); assert.equal(opens, 1);
  await page.keyboard.press('h'); await pilot.waitFor();
  assert.deepEqual(await graphCircles(), pilotCircles, 'Returning to the Pilot preserves the same view');
  await pilot.locator('header strong').click(); await page.keyboard.press('l'); await agent.waitFor();
  await page.keyboard.press('Escape'); await agent.waitFor({ state: 'detached' }); assert.equal(job.status, 'working');
  await openPilot(); await pilot.waitFor();
  await page.keyboard.press('Shift+Escape'); await pilot.locator('header [role=alert]').waitFor(); assert.equal(stops, 0);
  await page.keyboard.down('Shift'); await page.keyboard.down('Escape');
  // The second deliberate press confirms; a held-key repeat must not dispatch again.
  await page.keyboard.down('Escape'); await page.keyboard.up('Escape'); await page.keyboard.up('Shift');
  await pilot.waitFor({ state: 'detached' }); assert.equal(stops, 1);
  assert.equal(job.status, 'interrupted'); assert.deepEqual(errors, []);
  console.log('PASS shared Pilot membership and camera across sibling agents and history; production agent tab: parent Pilot view/context labels, shared resize, Cmd-O, h/l history, Esc without stop, confirmed Pilot stop exactly once');
 } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
