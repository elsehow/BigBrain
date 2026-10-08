// production base and the Settings account card over the fabricated Granola scene: live access per caller. No provider calls.
const {chromium}=require('./browserHarness.cjs');
const assert=require('node:assert/strict');
const base=process.env.SIDEBAR_PREVIEW_URL||'http://127.0.0.1:5219';
(async()=>{
 const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/sidebar-workbench.html?gmail#/integrations`);
  await page.getByRole('region',{name:'Your integrations'}).getByRole('button',{name:'Configure',exact:true}).click();
  const region=page.getByRole('region',{name:'granola accounts'});await region.waitFor();
  // what the card sends, as the scene receives it
  await page.evaluate(()=>{const f=globalThis.fetch;window.posted=[];globalThis.fetch=(input,init)=>{if(typeof init?.body==='string')window.posted.push(JSON.parse(init.body));return f(input,init);};});
  const saves=async()=>(await page.evaluate(()=>window.posted)).filter(b=>b.action==='save');
  await region.locator('summary').first().click();
  await region.getByRole('button',{name:'Connect',exact:true}).click();await region.getByText('Connected.',{exact:true}).waitFor();
  const list=region.getByRole('list',{name:'Live access to Granola'});
  assert.deepEqual(await list.getByRole('listitem').allInnerTexts().then(t=>t.map(s=>s.split('\n')[0])),['Pilot','Claude Code on sample laptop'],'Pilot first, then each connected client by name');
  const pilot=list.getByRole('combobox',{name:'Live access for Pilot',exact:true}),client=list.getByRole('combobox',{name:'Live access for Claude Code on sample laptop',exact:true});
  assert.equal(await pilot.inputValue(),'read');assert.equal(await client.inputValue(),'off');
  assert.deepEqual(await client.locator('option').allInnerTexts(),['Off','Read'],'no write level where the account offers none');
  await region.getByText('Pilot is BigBrain’s own agent and has no shell. An external agent with access can act on what it reads with its own tools. This controls what BigBrain hands it.',{exact:true}).waitFor();
  const save=async()=>{await region.getByRole('button',{name:'Save',exact:true}).click();await region.getByText('Saved.',{exact:true}).waitFor();};
  await client.selectOption('read');await save();
  await pilot.selectOption('off');await save();
  assert.deepEqual((await saves()).map(b=>b.grants),[[{caller:'token:12345678',access:'read'}],[{caller:'pilot',access:'off'}]],'each Save sends only the caller that changed');
  assert((await saves()).every(b=>!('liveAccess' in b)));
  assert.equal(await pilot.inputValue(),'off');assert.equal(await client.inputValue(),'read');
  // Save with nothing changed here leaves every caller alone
  await save();assert.equal((await saves()).at(-1).grants,undefined);
  await page.setViewportSize({width:420,height:900});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal scroll at phone width');
  const box=await client.boundingBox(),row=await list.getByRole('listitem').nth(1).boundingBox();
  assert(box&&row&&box.x+box.width<=row.x+row.width+1,'the level stays inside its row');
  assert.deepEqual(errors,[]);console.log('Live access per caller: Settings card passed');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
