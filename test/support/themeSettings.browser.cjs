/** Theme selection and Settings close regression. Fabricated graph and sessions;
 * no model requests or vault writes. Run against Vite on :5198. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({ channel: 'chrome' });
 try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const graph = { hash: 'theme-settings-fixture', nodes: Array.from({ length: 4000 }, (_, i) => ({
   id: `n${i}`, title: `Node ${i}`, group: 'entity', degree: 2, x: Math.cos(i * 2.4) * Math.sqrt(i) * 12, y: Math.sin(i * 2.4) * Math.sqrt(i) * 12,
  })), edges: Array.from({length: 3999}, (_,i) => ({source:`n${i}`,target:`n${i+1}`})) };
  const at = '2026-09-15T12:00:00Z';
  const session = { id: 'pilot-'+'a'.repeat(32), title: 'Active Pilot', model:'gpt-5.6-terra', phase:'working', lifecycle:'active',
   seed:['n0'],context:['n0'],viewRevision:0,revision:1,draft:'',live:'',activity:'',error:'',
   messages:[{id:'m',role:'user',text:'Example question',at}], created:at,updated:at,lastActivityAt:at };
  const closed = {...session,id:'pilot-'+'b'.repeat(32),title:'Closed Pilot',phase:'answered',lifecycle:'dormant'};
  await page.route('**/api/graph', r => r.fulfill({json:graph}));
  await page.route('**/api/pilot/chat', r => r.fulfill({json:{sessions:[session,closed]}}));
  await page.route('**/api/recent?**', r => r.fulfill({json:{recent:[{path:'sources/note.md',title:'Regular note',modified:Date.parse(at),band:'person',author:'you',action:'added'}],nextOffset:null}}));
  await page.route('**/api/themes',r=>r.fulfill({json:{dir:'/tmp/themes',skins:[],css:'',errors:[]}}));
  await page.addInitScript(() => {
   window.layoutWrites = [];
   const set = Storage.prototype.setItem;
   Storage.prototype.setItem = function(k,v) { if(k === 'bb:overview-layout:1') window.layoutWrites.push(JSON.parse(v).positions.length); return set.call(this,k,v); };
  });
  await page.goto(process.env.GRAPH_PREVIEW_URL || 'http://localhost:5198');
  await page.locator('.lg-wrap').waitFor();
  await page.waitForFunction(()=>window.layoutWrites.includes(4000));
  const writes = await page.evaluate(()=>window.layoutWrites.length);
  for (const close of ['Escape','X']) {
   await page.evaluate(()=>location.hash='/themes'); await page.locator('.settings').waitFor();
   assert.deepEqual(await page.locator('.grid .cap').allTextContents().then(a=>a.map(s=>s.trim().replace(/\s+(current|dark|light)$/,''))), ['Follow the system','Light','nurebairo','OG web blue','Phosphorus',"Something's Gotta Give",'yamabukiiro','moegiiro','adzukiiro','asagiiro']);
   const start = Date.now();
   if (close === 'X') await page.getByRole('button',{name:'Close settings',exact:true}).click(); else await page.keyboard.press('Escape');
   await page.locator('.lg-wrap').waitFor();
   await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   console.log(`${close} closed Settings in ${Date.now()-start}ms`);
   assert.equal(await page.evaluate(()=>window.layoutWrites.length), writes, 'Closing Settings must reuse the full layout');
  }
  const search=page.getByRole('combobox');
  for (const theme of ['default','dusk','web','phosphor','somethings-gotta-give','yamabukiiro','moegiiro','adzukiiro','asagiiro']) {
   await page.evaluate(async theme=>(await import('/src/lib/theme.ts')).setChoice(theme),theme);
   await search.focus();
   const active=page.getByRole('option',{name:/Active Pilot/}); await active.waitFor();
   await active.hover();
   await page.waitForFunction(()=>document.querySelector('.search-hit.active-pilot')?.getAttribute('aria-selected')==='true');
   const colors=await active.evaluate(el=>{
    const s=getComputedStyle(el),icon=getComputedStyle(el.querySelector('svg'));
    const resolve=v=>{const x=document.createElement('span');x.style.color=v;el.append(x);const c=getComputedStyle(x).color;x.remove();return c};
    return {background:s.backgroundColor,ink:s.color,icon:icon.color,activity:resolve('var(--activity)'),bg:resolve('var(--bg)'),fg:resolve('var(--fg)'),spinner:getComputedStyle(el.querySelector('.spinner')).stroke};
   });
   assert.equal(colors.background,colors.activity); assert.equal(colors.ink,colors.bg); assert.equal(colors.icon,colors.bg); assert.equal(colors.spinner,colors.bg);
   if(theme==='web') await page.screenshot({path:'/tmp/theme-active-selection.png'});
   for(const name of [/Regular note/,/Closed Pilot/]) {
    const row=page.getByRole('option',{name}); await row.hover();
    await row.evaluate(el=>new Promise(resolve=>{const check=()=>el.getAttribute('aria-selected')==='true'?resolve():requestAnimationFrame(check);check()}));
    const paint=await row.evaluate(el=>({background:getComputedStyle(el).backgroundColor,ink:getComputedStyle(el).color,cls:el.className,selected:el.getAttribute('aria-selected')}));
    assert.equal(paint.background,colors.fg);assert.equal(paint.ink,colors.bg);
   }
   assert.equal(await active.locator('svg').evaluate(el=>getComputedStyle(el).color),colors.activity);
   await search.press('Escape');
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: settings reuse cached graph; all nine themes distinguish selected active, inactive, and regular rows');
 } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1)});
