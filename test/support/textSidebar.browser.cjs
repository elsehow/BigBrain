/** Production App, fabricated vault only. Run against an isolated Vite server. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});
  await page.route('**/sidebar-test.html',r=>r.fulfill({contentType:'text/html',body:`<div id="app"></div><script type="module">
import {mount} from '/node_modules/.vite/deps/svelte.js';
import App from '/src/App.svelte';
import {init,app} from '/src/lib/store.svelte.ts';
import {chat} from '/src/lib/pilotChat.svelte.ts';
import {BRIEFINGS,installFakeApi,setVaultState} from '/src/dev/fakeApi.ts';
import {agentChatFixture} from '/src/dev/agentChatScenes.ts';
import '/src/design/tokens.css';import '/src/app.css';
installFakeApi();navigator.sendBeacon=()=>true;
const fixture={...BRIEFINGS.ready},at=new Date().toISOString();
const id='pilot-'+ 'a'.repeat(32),worker=agentChatFixture('running');
worker.id='work-'+'b'.repeat(32);worker.status='idle';worker.title='Atlas agent';
worker.context={nodes:fixture.graph.nodes.slice(0,3).map(n=>n.id)};
worker.messages=[{id:'q',role:'user',at,text:'What is next on Atlas?'},{id:'a',role:'agent',at,text:'## Next steps\\n\\nReview the plan and schedule interviews.'}];
fixture.workSessions=[worker];setVaultState(fixture);
const session={id,title:'Atlas next steps',model:'fixture',phase:'answered',lifecycle:'active',seed:[],context:worker.context.nodes,viewRevision:0,revision:1,draft:'',inputs:[],live:'',activity:'',error:'',created:at,updated:at,lastActivityAt:at,messages:[{id:'q',role:'user',at,text:'What is next on Atlas?'},{id:'a',role:'assistant',at,text:'## Next steps\\n\\nReview the plan and schedule interviews.'}]};
chat.sessions=[session];chat.graph=fixture.graph;app.pilotAutofocus=false;
const fake=window.fetch;window.fetch=async(input,options)=>{const url=new URL(typeof input==='string'?input:input.url,location.href);if(!url.pathname.startsWith('/api/pilot/chat'))return fake(input,options);return new Response(JSON.stringify(url.pathname.endsWith('/notifications')?{notifications:[]}:url.pathname==='/api/pilot/chat'?{sessions:[session]}:url.pathname.endsWith('/presence')?{ok:true}:session),{headers:{'content-type':'application/json'}})};
window.fixture={pilot:id,worker:worker.id,note:fixture.graph.nodes.find(n=>n.path).path};
location.hash='/session/'+id;mount(App,{target:document.getElementById('app')});init();
</script>`}));
  await page.goto((process.env.GRAPH_PREVIEW_URL||'http://127.0.0.1:5183')+'/sidebar-test.html');
  await page.locator('.pilot-panel').waitFor();
  const box=selector=>page.locator(selector).boundingBox();
  const assertSide=async()=>{
   await page.waitForFunction(()=>document.querySelector('.drawer')?.getBoundingClientRect().x===24);
   const d=await box('.drawer'),g=await box('.g-canvas');
   assert.equal(d.x,24);assert.equal(d.y,94);assert(g.x>d.x+d.width);assert(d.height>800);
   assert.equal(await page.locator('.drawer').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
  };
  const before=await box('.drawer');assert(before.y>500);
  await page.getByRole('button',{name:'Expand text tab',exact:true}).click();await assertSide();
  assert.equal(await page.locator('.pilot-panel .transcript').evaluate(e=>getComputedStyle(e).fontSize),'21px');
  await page.getByLabel('Message Pilot').fill('Keep my draft');
  await page.keyboard.press('Shift+ArrowDown');
  await page.waitForFunction(()=>!document.querySelector('.drawer').classList.contains('expanded'));
  assert((await box('.drawer')).y>500);assert.equal((await box('.g-canvas')).x,0);
  assert.equal(await page.getByLabel('Message Pilot').innerText(),'Keep my draft');
  await page.keyboard.press('Shift+ArrowUp');await assertSide();
  await page.waitForTimeout(1200);await page.screenshot({path:'/private/tmp/bb-sidebar-pilot.png'});
  for(const width of [1049,650,390]){
   await page.setViewportSize({width,height:1000});await page.waitForTimeout(100);
   const d=await box('.drawer');assert(d.x>=0&&d.x+d.width<=width+1);assert.equal((await box('.g-canvas')).x,0);
   assert.equal(await page.locator('.drawer').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
  }
  await page.setViewportSize({width:1440,height:1000});await assertSide();
  await page.evaluate(()=>location.hash='/vault/sessions/'+window.fixture.worker+'.md');
  await page.locator('.worker-panel').waitFor();
  await page.getByRole('button',{name:'Expand text tab',exact:true}).click();await assertSide();
  await page.waitForTimeout(1200);await page.screenshot({path:'/private/tmp/bb-sidebar-worker.png'});
  await page.getByRole('button',{name:'Standard text tab',exact:true}).click();assert((await box('.drawer')).y>500);
  await page.evaluate(()=>location.hash='/vault/'+window.fixture.note);
  await page.locator('.note-title').waitFor();assert((await box('.drawer')).y>500);
  assert.equal(await page.locator('.note-title').evaluate(e=>getComputedStyle(e).fontSize),'22px');
  assert.deepEqual(errors,[]);console.log('PASS: Pilot/worker left expansion, bottom collapse, keyboard, draft preservation, responsive widths, note typography');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
