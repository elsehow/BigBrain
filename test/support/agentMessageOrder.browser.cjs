const {chromium}=require('./browserHarness.cjs');
const assert=require('node:assert/strict');
const base=process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5218';
(async()=>{
 const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/sidebar-workbench.html');
  await page.waitForFunction(()=>document.documentElement.dataset.sidebarWorkbench==='closed');
  await page.keyboard.press('a');
  await page.locator('.pilot-row').first().waitFor();
  const ids=await page.evaluate(async()=>{
   const {chat}=await import('/src/lib/pilotChat.svelte.ts');
   const template=chat.sessions.find(s=>!s.deactivatedAt);
   const make=(n,title,created,message)=>({...template,id:'pilot-'+String(n).padStart(32,'0'),title,created,updated:'2026-09-25T23:00:00Z',phase:'answered',deactivatedAt:undefined,messages:[],lastMessageAt:message,messageCount:1,notifications:[],revision:100});
   chat.sessions=[
    make(101,'Older creation, latest reply','2026-09-01T12:00:00Z','2026-09-25T12:00:00Z'),
    make(102,'Newer creation, older message','2026-09-20T12:00:00Z','2026-09-21T12:00:00Z'),
   ];
   return chat.sessions.map(s=>s.id);
  });
  const order=()=>page.locator('.pilot-row').evaluateAll(rows=>rows.map(r=>r.dataset.pilot));
  assert.deepEqual(await order(),ids);
  assert.equal(await page.locator('.pilot-row time').first().getAttribute('datetime'),'2026-09-25T12:00:00Z');
  assert((await page.locator('.pilot-row time').first().textContent()).includes('Sep 25'));
  await page.locator('.pilot-row').first().focus();
  await page.evaluate(async id=>{
   const {chat}=await import('/src/lib/pilotChat.svelte.ts');
   chat.sessions=chat.sessions.map(s=>s.id===id?{...s,messages:[{id:'latest',role:'user',text:'New sent message',at:'2026-09-25T13:00:00Z'}]}:s);
  },ids[1]);
  await page.waitForFunction(id=>document.querySelector('.pilot-row')?.dataset.pilot===id,ids[1]);
  assert.equal(await page.locator('.pilot-row.selected').getAttribute('data-pilot'),ids[0],'selection stays on the same agent when order changes');
  assert.equal(await page.locator('.pilot-row time').first().getAttribute('datetime'),'2026-09-25T13:00:00Z');
  assert.deepEqual(errors,[]);
  console.log('PASS: Agents sorts unloaded histories by last message, shows timestamps, updates on sent messages, and preserves selection');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
