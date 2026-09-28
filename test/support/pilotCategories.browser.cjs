const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5218';
(async () => {
 const browser = await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome',headless:true});
 try {
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[]; page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
  await page.goto(base+'/sidebar-workbench.html');
  await page.waitForFunction(()=>document.documentElement.dataset.sidebarWorkbench==='closed');
  await page.keyboard.press('j');
  assert.equal(await page.getByRole('button',{name:'General',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:/^Uncategorized agents/}).count(),0,'empty fallback is absent');
  await page.keyboard.press('Escape');
  const moved=await page.evaluate(async()=>{
   const {chat,refreshChats}=await import('/src/lib/pilotChat.svelte.ts');
   await refreshChats();
   const agent=chat.sessions.find(s=>s.category?.memory && s.title==='Atlas planning');
   if(!agent)throw new Error('missing fixture');
   window.dispatchEvent(new CustomEvent('workbench-agent-category',{detail:{id:agent.id,memory:null}}));
   await refreshChats();
   return agent.id;
  });
  await page.keyboard.press('k');
  const menu=page.locator('.workspace-menu'); await menu.waitFor();
  assert.equal(await menu.locator('.current').getAttribute('data-agent-id'), moved);
  assert.match(await menu.locator('[aria-current="true"] .title').textContent(),/Atlas planning/);
  await page.evaluate(async id=>{
   const {chat,refreshChats}=await import('/src/lib/pilotChat.svelte.ts');
   const design=chat.sessions.find(s=>s.title==='Component audit');
   window.dispatchEvent(new CustomEvent('workbench-agent-category',{detail:{id,memory:design.category.memory}}));
   await refreshChats();
  },moved);
  await menu.waitFor();
  assert.match(await menu.locator('[aria-current="true"] .title').textContent(),/Atlas planning/,'selection follows agent across categories');
  await page.keyboard.press('Enter');
  await page.waitForFunction(async id=>{const {chat}=await import('/src/lib/pilotChat.svelte.ts');return chat.open&&chat.activeId===id;},moved);
  await page.keyboard.press('Escape');
  await menu.waitFor();
  await page.keyboard.press('h');
  assert.equal(await menu.getByRole('button',{name:/^Uncategorized agents/}).count(),0,'fallback disappears when its last agent is categorized');
  await page.evaluate(async id=>{
   const {refreshChats}=await import('/src/lib/pilotChat.svelte.ts');
   window.dispatchEvent(new CustomEvent('workbench-agent-category',{detail:{id,memory:null}}));
   await refreshChats();
  },moved);
  await menu.getByRole('button',{name:/^Uncategorized agents/}).focus();
  await page.keyboard.press('Shift+Enter');
  await page.waitForFunction(async()=>{const {chat}=await import('/src/lib/pilotChat.svelte.ts');return chat.open&&chat.sessions.some(s=>s.id===chat.activeId&&s.context.length===0);});
  assert.deepEqual(errors,[]);
  console.log('PASS: empty fallback hidden, named uncategorized-agent fallback, live category moves, preserved selection, return navigation, and unseeded General draft in AppShell');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
