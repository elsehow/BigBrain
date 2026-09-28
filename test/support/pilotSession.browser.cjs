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
  let stopCount = 0;
  let deactivateGate = deferred(), deactivated = deferred();
  const sessions = new Map();
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.url().includes('/src/lib/store.svelte.ts')) storeUrl = r.url(); if (r.url().includes('/src/lib/pilotChat.svelte.ts')) chatUrl = r.url(); });
  await page.addInitScript(() => {
   const ctx = CanvasRenderingContext2D.prototype, arc = ctx.arc, stroke = ctx.stroke;
   window.pilotArcs = []; window.pilotTriangles = [];
   const begin = ctx.beginPath, move = ctx.moveTo, line = ctx.lineTo;
   ctx.beginPath = function(...args) { this.pilotPath = []; this.pilotArc = null; return begin.apply(this, args); };
   ctx.moveTo = function(x,y) { this.pilotPath?.push({x,y}); return move.call(this,x,y); };
   ctx.lineTo = function(x,y) { this.pilotPath?.push({x,y}); return line.call(this,x,y); };
   const fill = ctx.fill;
   ctx.fill = function(...args) { if (this.strokeStyle === getComputedStyle(document.documentElement).getPropertyValue('--activity').trim() && this.pilotPath?.length === 3) { window.pilotTriangles.push({x:this.pilotPath.reduce((v,p)=>v+p.x,0)/3,y:this.pilotPath.reduce((v,p)=>v+p.y,0)/3});window.pilotTriangles=window.pilotTriangles.slice(-100); } return fill.apply(this,args); };
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
   if (path === 'stop') { stopCount++; if (failStop) return route.fulfill({ status: 503, json: { error: 'Cannot stop connection' } }); s.phase = 'interrupted'; }
   if (path === 'discard') { sessions.delete(b.id); discarded.resolve(); return route.fulfill({ json: { ok: true } }); }
   s.revision++; return route.fulfill({ json: s });
  });
  const preview = process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5198';
  await page.goto(preview); await page.locator('.lg-wrap > canvas:not([aria-hidden])').waitFor();
  const select = ids => page.evaluate(async ({ url, ids }) => { const { app } = await import(url); app.graphView = { selected: ids, excluded: [] }; }, { url: storeUrl, ids });
  const refresh = () => page.evaluate(async url => (await import(url)).refreshChats(), chatUrl);
  const input = page.getByLabel('Message Pilot');
  await select(['arbor', 'dana']); await page.keyboard.press('Shift+Enter'); await input.waitFor({ timeout: 1000 });
  const id = await created.promise; assert.equal(sessions.has(id), false); assert.equal(await input.evaluate(e => e === document.activeElement), true);
  await input.fill('First line'); await page.keyboard.press('End'); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('Second line');
  await page.waitForFunction(() => window.pilotLineMotion); // draft edges move before connection
  await page.keyboard.press('Enter'); assert.equal(await input.innerText(), '');
  assert.match(await page.locator('.pilot-panel .status').textContent(), /queued/);
  assert.equal(await page.locator('.pilot-panel .message').count(), 1); assert.equal(sendCount, 0);
  await refresh(); assert.equal(await page.locator('.pilot-panel .message').count(), 1);
  gate.resolve(); await sent.promise; await page.waitForFunction(() => !document.querySelector('.pilot-panel .status')?.textContent.includes('queued'));
  const s = sessions.get(id); s.messages.push({ id: 'answer', role: 'assistant', text: 'The response.', at: new Date().toISOString() }); s.phase = 'answered'; s.revision++; await refresh();
  assert.equal(await page.locator('.pilot-panel .message').count(), 2); await page.keyboard.press('Escape'); await input.waitFor({ state: 'detached', timeout: 1000 });

  // Coincident sessions separate; the Pilot triangle has a generous hover target,
  // and hovering draws its outer selector even though another node is selected.
  const sibling = { ...s, id: 'pilot-ffffffffffffffffffffffffffff' + s.id.slice(-4), title: 'Second session', messages: [...s.messages] };
  sessions.set(sibling.id, sibling); await refresh(); await select(['arbor']); await page.waitForTimeout(700);
  const canvas = page.locator('canvas:not([aria-hidden])').first();
  const rect = await canvas.boundingBox();
  const center = await page.evaluate(() => window.pilotTriangles.at(-1));
  assert.ok(center); await page.evaluate(() => { window.pilotArcs = []; });
  await page.mouse.move(rect.x + center.x + 5.5, rect.y + center.y);
  await page.waitForFunction(() => document.querySelector('canvas:not([aria-hidden])')?.style.cursor === 'pointer');
  await page.waitForFunction(p => window.pilotArcs.some(a => Math.hypot(a.x - p.x, a.y - p.y) < 2 && a.r > 9), center);
  await page.mouse.move(10, 10); await select([]);
  // A backend-deleted empty session disappears on refresh (no stale local copy).
  const orphan = { ...s, id: 'pilot-' + 'e'.repeat(32), phase: 'draft', draft: '', messages: [], live: '' };
  sessions.set(orphan.id, orphan); await refresh();
  sessions.delete(orphan.id); await refresh();
  assert.equal(await page.evaluate(async ({ url, id }) => (await import(url)).chat.sessions.some(s => s.id === id), { url: chatUrl, id: orphan.id }), false);

  // Cancel an empty session while create is still blocked. It disappears locally.
  gate = deferred(); created = deferred(); discarded = deferred(); await select([]); await page.keyboard.press('Shift+Enter'); await input.waitFor({ timeout: 1000 }); const emptyId = await created.promise;
  await page.keyboard.press('Escape'); await input.waitFor({ state: 'detached', timeout: 1000 }); assert.equal(await page.locator('.pilot-view').count(), 0);
  gate.resolve(); await discarded.promise; assert.equal(sessions.has(emptyId), false);

  // Cancel a queued send before connection: retain the words as a draft, never send.
  gate = deferred(); created = deferred(); await select([]); await page.keyboard.press('Shift+Enter'); await input.waitFor({ timeout: 1000 }); const draftId = await created.promise;
  await input.fill('Keep this queued question'); await page.keyboard.press('Enter'); await page.keyboard.press('Shift+Escape');
  assert.equal(await input.count(), 1); await page.getByRole('button', { name: 'Archive Pilot', exact: true }).waitFor(); await page.keyboard.press('Escape'); await input.waitFor({ state: 'detached', timeout: 1000 });
  gate.resolve(); await page.waitForTimeout(300); assert.equal(sendCount, 1);
  await select([draftId]); await input.waitFor(); assert.equal(await input.innerText(), 'Keep this queued question');
  await page.keyboard.press('Escape'); await input.waitFor({ state: 'detached' });

  // Plain Esc exits with no selection while generation continues. Shift-Esc interrupts in place; failures surface a toast.
  sent = deferred(); failStop = true; await select([id]); await input.waitFor(); await input.fill('Continue'); await page.keyboard.press('Enter'); await sent.promise;
  await page.waitForFunction(() => !document.querySelector('.pilot-panel .status')?.textContent.includes('queued'));
  await page.keyboard.press('Escape'); await input.waitFor({ state: 'detached', timeout: 1000 });
  assert.equal(stopCount, 0); assert.equal(sessions.get(id).phase, 'working');
  assert.deepEqual(await page.evaluate(async url => (await import(url)).app.graphView, storeUrl), { selected: [], excluded: [] });
  await select([id]); await input.waitFor(); await page.getByRole('button', { name: '⇧Esc Interrupt', exact: true }).waitFor();
  await page.keyboard.press('Shift+Escape');
  const toast = page.locator('.pilot-toast'); await toast.waitFor(); assert.match(await toast.textContent(), /could not be interrupted/);
  assert.equal(await input.count(), 1);
  const box = await toast.boundingBox(); assert.ok(box.x > 700 && box.y < 200);
  // A successful interrupt keeps the view open; a held key cannot stop the session.
  failStop = false; await page.getByRole('button', { name: '⇧Esc Interrupt', exact: true }).waitFor();
  await page.keyboard.press('Shift+Escape');
  await page.getByRole('button', { name: 'Archive Pilot', exact: true }).waitFor();
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', shiftKey: true, repeat: true, bubbles: true })));
  assert.equal(await input.count(), 1);
  // X closes immediately while backend deactivation is delayed, preserving history.
  await select([id]); await input.waitFor();
  const messageCount = sessions.get(id).messages.length;
  await page.getByRole('button', { name: 'Archive Pilot', exact: true }).click();
  await input.waitFor({ state: 'detached', timeout: 1000 });
  assert.equal(await page.evaluate(async ({ url, id }) => (await import(url)).chat.sessions.find(s => s.id === id).lifecycle, { url: chatUrl, id }), 'dormant');
  deactivateGate.resolve(); await deactivated.promise;
  assert.equal(sessions.get(id).messages.length, messageCount);
  assert.equal(sessions.get(id).lifecycle, 'dormant');

  // Shift-Esc before connection preserves even an empty session, unlike Esc.
  gate = deferred(); created = deferred(); deactivated = deferred(); await select([]);
  await page.keyboard.press('Shift+Enter'); await input.waitFor({ timeout: 1000 }); const closedEmpty = await created.promise;
  await page.keyboard.press('Shift+Escape'); await input.waitFor({ state: 'detached', timeout: 1000 });
  gate.resolve(); await deactivated.promise; assert.equal(sessions.get(closedEmpty).lifecycle, 'dormant');
  assert.equal(sessions.get(closedEmpty).messages.length, 0);

  // Closing a queued first turn keeps its text and never dispatches it.
  gate = deferred(); created = deferred(); deactivated = deferred(); const sendsBeforeClose = sendCount;
  await select([]); await page.keyboard.press('Shift+Enter'); await input.waitFor(); const closedQueued = await created.promise;
  await input.fill('Keep this without sending'); await page.keyboard.press('Enter'); await page.keyboard.press('Shift+Escape');
  assert.equal(await input.count(), 1); await page.getByRole('button', { name: 'Archive Pilot', exact: true }).waitFor(); await page.keyboard.press('Shift+Escape');
  await input.waitFor({ state: 'detached', timeout: 1000 }); gate.resolve(); await deactivated.promise;
  assert.equal(sendCount, sendsBeforeClose); assert.equal(sessions.get(closedQueued).draft, 'Keep this without sending');
  assert.equal(sessions.get(closedQueued).lifecycle, 'dormant');
  assert.deepEqual(errors, []);

  await page.goto(`${preview}/dev.html?c=pilot&s=draft&preview=1`);
  await page.locator('.session-edge.flow').first().waitFor();
  assert.match(await page.locator('.session-edge.flow').first().evaluate(e => getComputedStyle(e).animationName), /(?:^|-)flow$/);
  await page.getByRole('button', { name: 'Archive Pilot', exact: true }).click();
  await page.locator('.session-node.dormant').waitFor();
  console.log('PASS Pilot: instant creation, draft line motion, multiline queued send, empty cancellation, retained queued draft, deselected Esc without interrupting, Shift-Esc interrupt then stop, repeat guard, stop-error toast, Pilot hover ring, backend removal reconciliation, Shift-Esc/X deactivation, preserved empty/queued sessions, workbench motion and close.');
 } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
