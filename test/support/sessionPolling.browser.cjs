/** Production UI against synthetic sessions; all writes are blocked. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({channel:'chrome'});
 try {
  const page = await browser.newPage();
  const counts={chat:0,history:0}, errors=[];
  let active=false, inFlight=0, maximum=0;
  const at=new Date().toISOString(), id='pilot-'+'e'.repeat(32);
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',r=>r.request().method()==='GET'?r.continue():r.fulfill({status:503,json:{error:'Read-only fixture'}}));
  await page.route('**/api/pilot/work',r=>{counts.history++;return r.fulfill({json:{sessions:[]}});});
  await page.route('**/api/pilot/chat',async r=>{
   counts.chat++;maximum=Math.max(maximum,++inFlight);
   await new Promise(resolve=>setTimeout(resolve,60));
   await r.fulfill({json:{sessions:active?[{id,title:'Synthetic active session',phase:'working',model:'fixture',backend:{adapter:'pi',provider:'openai-codex',model:'fixture'},seed:[],context:[],messages:[],live:'',activity:'',error:'',created:at,updated:at,revision:1,viewRevision:0,lifecycle:'active'}]:[]}});
   inFlight--;
  });
  await page.goto(process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:4757');
  await page.waitForTimeout(1800);
  const before={...counts};
  await page.waitForTimeout(6000);
  const idle={chat:counts.chat-before.chat,history:counts.history-before.history};
  assert(idle.chat>=3&&idle.chat<=5,JSON.stringify(idle));assert.equal(idle.history,idle.chat);assert.equal(maximum,1);
  active=true;await page.waitForTimeout(2000);
  const activeStart=counts.chat;await page.waitForTimeout(1500);
  const working=counts.chat-activeStart;assert(working>=3&&working<=5,`working polls: ${working}`);
  assert(counts.history>=counts.chat-1);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({idleWindowMs:6000,idle,historyInitial:counts.history,workingWindowMs:1500,working,maxConcurrentRefreshes:maximum}));
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
