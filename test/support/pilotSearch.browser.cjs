/** Main-app keyboard/latency regression. Only fabricated Pilot/graph responses.
 * Run with Vite on :5198 and PLAYWRIGHT_MODULE pointing to Playwright if needed. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
(async () => {
 const browser = await chromium.launch({ channel: 'chrome' });
 try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; let storeUrl, chatUrl, gate = deferred(), created = deferred(), sent = deferred(), discarded = deferred(), failStop = false, sendCount = 0;
  let deactivateGate = deferred(), deactivated = deferred();
  const sessions = new Map();
  const savedId = 'pilot-' + 'a'.repeat(32);
  sessions.set(savedId, { id: savedId, title: 'Arbor hardening', model:'gpt-5.6-terra', phase:'answered', lifecycle:'dormant',
   seed:['arbor'],context:['arbor','dana'],viewRevision:0,revision:1,draft:'',live:'',activity:'',error:'',
   messages:[{id:'m',role:'assistant',text:'Morgan helped with special-context hardening.',at:'2026-09-14T09:41:00Z'}],
   created:'2026-09-14T09:30:00Z',updated:'2026-09-15T10:00:00Z',lastActivityAt:'2026-09-14T09:41:00Z',
   ingestions:[{path:'sources/chapter.md',sourceId:'s',insertionId:'i',through:1}] });
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.url().includes('/src/lib/store.svelte.ts')) storeUrl = r.url(); if (r.url().includes('/src/lib/pilotChat.svelte.ts')) chatUrl = r.url(); });
  await page.addInitScript(() => {
   const ctx = CanvasRenderingContext2D.prototype, arc = ctx.arc, stroke = ctx.stroke;
   window.pilotArcs = [];
   ctx.arc = function(x, y, r, ...rest) { this.pilotArc = { x, y, r }; return arc.call(this, x, y, r, ...rest); };
   ctx.stroke = function(...args) { if (this.strokeStyle === getComputedStyle(document.documentElement).getPropertyValue('--activity').trim() && this.pilotArc) { window.pilotArcs.push(this.pilotArc); window.pilotArcs = window.pilotArcs.slice(-200); } return stroke.apply(this, args); };
   const d = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'lineDashOffset');
   Object.defineProperty(CanvasRenderingContext2D.prototype, 'lineDashOffset', { ...d, set(v) { if (v !== 0) window.pilotLineMotion = true; d.set.call(this, v); } });
  });
  await page.route('**/api/graph', route => route.fulfill({ json: { nodes: [
   { id: 'arbor', title: 'Arbor', path: 'entities/arbor.md', group: 'entity', degree: 1, x: 0, y: 0 },
   { id: 'dana', title: 'Dana', path: 'entities/dana.md', group: 'entity', degree: 1, x: 80, y: 50 },
  ], edges: [{ source: 'arbor', target: 'dana' }], hash: 'pilot-latency' } }));
  await page.route('**/api/pilot/chat{,/**}', async route => {
   const path = new URL(route.request().url()).pathname.split('/').at(-1), b = route.request().postDataJSON() ?? {};
   if (path === 'chat') return route.fulfill({ json: { sessions: [...sessions.values()] } });
   if (path === 'create') {
    created.resolve(b.id); await gate.promise;
    const at = new Date().toISOString();
    const s = { id: b.id, title: 'New session', model: 'gpt-5.6-terra', phase: 'draft', lifecycle: 'active', seed: b.context, context: b.context, viewRevision: 0, revision: 1, draft: '', messages: [], live: '', activity: '', error: '', created: at, updated: at };
    sessions.set(s.id, s); return route.fulfill({ json: s });
   }
   if (path === 'presence') return route.fulfill({ json: { ok: true } });
   const s = sessions.get(b.id); if (!s) return route.fulfill({ status: 404, json: { error: 'Missing session' } });
   if (path === 'draft') { s.draft = b.text; if (s.phase === 'draft' && b.text) s.title = 'Draft session'; }
   if (path === 'send') { sendCount++; s.phase = 'working'; s.draft = ''; s.messages.push({ id: 'user-' + sendCount, role: 'user', text: b.text, at: new Date().toISOString() }); sent.resolve(s.id); }
   if (path === 'deactivate') { await deactivateGate.promise; s.lifecycle = 'dormant'; s.deactivatedAt = new Date().toISOString(); if (s.phase === 'working') s.phase = 'interrupted'; deactivated.resolve(); }
   if (path === 'stop') { if (failStop) return route.fulfill({ status: 503, json: { error: 'Cannot stop connection' } }); s.phase = 'interrupted'; }
   if (path === 'discard') { sessions.delete(b.id); discarded.resolve(); return route.fulfill({ json: { ok: true } }); }
   s.revision++; return route.fulfill({ json: s });
  });
  const preview = process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5198';
  const recent = [{path:'sources/new.md',title:'Recent source',modified:Date.parse('2026-09-15T09:00:00Z'),band:'person',author:'you',action:'added'},
   {path:'sources/chapter.md',title:'Chapter duplicate',modified:Date.parse('2026-09-15T10:00:00Z'),from:'pilot',sessionId:savedId,band:'agent',author:'pilot',action:'added'}];
  recent.push(...Array.from({length:4},(_,i)=>({path:`sources/older-${i}.md`,title:`Older source ${i}`,modified:Date.parse('2026-09-01')-i,band:'person',author:'you',action:'added'})));
  await page.route('**/api/recent?**',r=>r.fulfill({json:{recent,nextOffset:null}}));
  await page.route('**/api/search?**',r=>r.fulfill({json:{hits:[],nextOffset:null}}));
  await page.goto(preview); await page.locator('.lg-wrap > canvas:not([aria-hidden])').waitFor();
  const select = ids => page.evaluate(async ({ url, ids }) => { const { app } = await import(url); app.graphView = { selected: ids, excluded: [] }; }, { url: storeUrl, ids });
  const input = page.getByLabel('Message Pilot');
  const search=page.getByRole('combobox');
  await page.evaluate(async url=>{await (await import(url)).refreshChats()},chatUrl);
  await search.focus();
  await page.getByRole('option',{name:/Arbor hardening/}).waitFor();
  assert.equal(await page.getByRole('option',{name:/Chapter duplicate/}).count(),0);
  const scrollCue = await page.locator('.search-viewport').evaluate(el=>({
   overflowing:el.scrollHeight>el.clientHeight,
   width:getComputedStyle(el,'::-webkit-scrollbar').width,
   thumb:getComputedStyle(el,'::-webkit-scrollbar-thumb').backgroundColor,
  }));
  assert.equal(scrollCue.overflowing,true);assert.equal(scrollCue.width,'6px');
  assert.notEqual(scrollCue.thumb,'rgba(0, 0, 0, 0)');
  await page.screenshot({path:'/tmp/pilot-recents-scrollbar.png'});
  let row=page.getByRole('option',{name:/Arbor hardening/});
  assert.equal(await row.locator('.pilot-triangle').count(),1);
  assert.equal(await row.locator('svg.live').count(),0);
  assert.match(await row.locator('time').textContent(),/Sep 14/);
  await search.fill('special-context');await row.waitFor();
  await search.press('Enter');await input.waitFor();
  assert.equal(await page.evaluate(async url=>(await import(url)).chat.activeId,chatUrl),savedId);
  assert.match(await page.locator('.pilot-panel .message').textContent(),/Morgan/);
  assert.equal(await page.locator('.pilot-panel .pilot-triangle').count(),1);
  await search.focus();await search.press('Escape');
  assert.equal(await input.count(),1); // Search Escape must not close the Pilot.
  await input.focus();deactivateGate.resolve();await page.keyboard.press('Shift+Escape');await input.waitFor({state:'detached'});
  await search.fill('');await search.focus();await row.waitFor();
  await search.press('Escape');
  await select(['arbor']);await page.keyboard.press('Shift+Enter');await input.waitFor();const draftId=await created.promise;
  assert.equal(sessions.has(draftId),false);
  await search.focus();await page.waitForTimeout(100);
  assert.equal(await page.getByRole('option',{name:/New session/}).count(),0); // Active drafts stay out of recents.
  await search.fill('New session');await page.getByRole('option',{name:/New session/}).waitFor();
  assert.equal(await page.getByRole('option',{name:/New session/}).locator('.caret').count(),1);
  await search.press('Escape');await input.focus();await page.keyboard.press('Escape');await input.waitFor({state:'detached'});
  await search.focus();await page.waitForTimeout(50);
  assert.equal(await page.getByRole('option',{name:/New session/}).count(),0);
  gate.resolve();await discarded.promise;
  await search.fill('hardening');await row.waitFor();await search.press('Enter');await input.waitFor();
  assert.equal(await page.evaluate(async url=>(await import(url)).chat.activeId,chatUrl),savedId);
  assert.equal(sessions.size,1);assert.deepEqual(errors,[]);
  await page.screenshot({path:'/tmp/pilot-wired-search.png'});
  console.log('PASS Pilot Recent/search: closed identity, semantic date, ingestion deduplication, transcript search, reopen context/history, search Escape, optimistic creation and cancellation');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
