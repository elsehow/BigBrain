/** Back/forward regression with fabricated notes and Pilot sessions. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({ channel: 'chrome' });
 try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  let storeUrl, chatUrl;
  page.on('request', r => { if (r.url().includes('/src/lib/store.svelte.ts')) storeUrl = r.url(); if (r.url().includes('/src/lib/pilotChat.svelte.ts')) chatUrl = r.url(); });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const base = process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5198';
  const id = 'pilot-' + 'c'.repeat(32), second = 'pilot-' + 'd'.repeat(32), path = 'notes/history.md';
  const at = new Date().toISOString();
  const make = (id, title) => ({ id, title, model: 'gpt-5.6-terra', phase: 'answered', lifecycle: 'active', seed: ['note'], context: ['note'], viewRevision: 0, revision: 1, draft: 'Retained draft', messages: [{ id: 'answer', role: 'assistant', text: 'Retained answer', at }], live: '', activity: '', error: '', created: at, updated: at });
  const sessions = [make(id, 'History Pilot'), make(second, 'Second Pilot')];
  let delay = false;
  await page.addInitScript(() => {
   window.noteCenters = [];
   const proto = CanvasRenderingContext2D.prototype;
   const begin = proto.beginPath, arc = proto.arc, fill = proto.fill, stroke = proto.stroke;
   proto.beginPath = function(...args) { this.historyArc = null; return begin.apply(this,args); };
   proto.arc = function(x,y,r,...args) { this.historyArc = {x,y,r}; return arc.call(this,x,y,r,...args); };
   function record(ctx, style) {
    if (!ctx.canvas.closest('.lg-wrap') || !ctx.historyArc || ctx.historyArc.r < 2 || ctx.historyArc.r > 30) return;
    if (style !== getComputedStyle(document.documentElement).getPropertyValue('--fg').trim()) return;
    window.noteCenters.push(ctx.historyArc); window.noteCenters = window.noteCenters.slice(-50);
   }
   proto.fill = function(...args) { record(this,this.fillStyle); return fill.apply(this,args); };
   proto.stroke = function(...args) { record(this,this.strokeStyle); return stroke.apply(this,args); };
  });
  await page.route('**/api/graph', r => r.fulfill({ json: { nodes: [{ id:'note', path, title:'History note', group:'entity', degree:1, x:0, y:0 }], edges:[], hash:'pilot-history' } }));
  await page.route('**/api/note?**', r => r.fulfill({ json: { path, content:'# History note\nA note to visit.', frontmatter:{}, links:[], backlinks:[], assertions:[] } }));
  await page.route('**/api/pilot/chat{,/**}', async r => {
   const action = new URL(r.request().url()).pathname.split('/').at(-1), b = r.request().postDataJSON() ?? {};
   if (action === 'chat') { if (delay) await new Promise(resolve => setTimeout(resolve,500)); return r.fulfill({ json:{sessions} }); }
   if (action === 'presence') return r.fulfill({ json:{ok:true} });
   const s = sessions.find(s => s.id === b.id);
   if (action === 'draft') s.draft=b.text;
   s.revision++; return r.fulfill({ json:s });
  });
  await page.goto(base);
  const open = target => page.evaluate(async ({url,target}) => { const mod=await import(url); await mod.refreshChats(); mod.openChat(target); }, {url:chatUrl,target});
  await open(id);
  const input=page.getByRole('textbox',{name:'Message Pilot'});
  await input.waitFor(); assert.ok(page.url().endsWith('/session/'+id));
  // Exercise the actual graph pointer path, not just the router helper.
  await page.waitForTimeout(900); await page.waitForFunction(() => window.noteCenters.length > 0);
  const canvas=page.locator('.lg-wrap > canvas:not([aria-hidden])');
  const box=await canvas.boundingBox(), point=await page.evaluate(() => window.noteCenters.at(-1));
  await page.mouse.click(box.x+point.x,box.y+point.y);
  await page.waitForURL('**#/vault/'+path);
  await input.waitFor({state:'detached'});
  const count=await page.evaluate(() => history.length);
  await page.keyboard.press('h'); await input.waitFor();
  assert.ok(page.url().endsWith('/session/'+id)); assert.equal(await input.innerText(),'Retained draft');
  assert.ok((await page.locator('.pilot-panel .transcript').innerText()).includes('Retained answer'));
  assert.equal(await input.evaluate(el=>el===document.activeElement),false);
  assert.deepEqual(await page.evaluate(async url => (await import(url)).app.graphView.selected,storeUrl),[id]);
  await page.keyboard.press('l'); await input.waitFor({state:'detached'});
  assert.ok(page.url().endsWith('/vault/'+path)); assert.equal(await page.evaluate(()=>history.length),count);
  await page.keyboard.press('h'); await input.waitFor();
  // Multiple Pilot visits have their own entries, and revisiting one is idempotent.
  await open(second); assert.ok(page.url().endsWith('/session/'+second));
  const two=await page.evaluate(()=>history.length); await open(second); assert.equal(await page.evaluate(()=>history.length),two);
  await input.evaluate(el=>el.blur()); await page.keyboard.press('h');
  await page.waitForURL('**#/session/'+id); await input.waitFor();
  await page.keyboard.press('l'); await page.waitForURL('**#/session/'+second);
  // Reload/deep-link waits for the session poll before canonicalizing selection.
  delay=true; await page.reload(); await input.waitFor();
  assert.ok(page.url().endsWith('/session/'+second)); assert.equal(await input.innerText(),'Retained draft');
  await page.keyboard.press('Escape'); await input.waitFor({state:'detached'});
  assert.deepEqual(await page.evaluate(async url => (await import(url)).app.graphView.selected,storeUrl),[]);
  assert.ok(!page.url().includes('/session/'));
  assert.deepEqual(errors,[]);
  console.log('PASS Pilot history: graph click → h/l, exact session/context/draft restore, multiple Pilots, no duplicate entries, delayed deep-link reload and Esc');
 } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
