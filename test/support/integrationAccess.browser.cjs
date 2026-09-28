// Production AppShell, fabricated account policy, no provider calls.
const {chromium}=require('./browserHarness.cjs');
const assert=require('node:assert/strict');
const base=process.env.SIDEBAR_PREVIEW_URL||'http://127.0.0.1:5219';
(async()=>{
 const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/sidebar-workbench.html?integration-activation=fail#/integrations`);
  await page.getByRole('heading',{name:'Library',exact:true}).waitFor();
  assert.equal(await page.getByRole('region',{name:'email accounts'}).count(),0);
  assert.equal(await page.getByRole('heading',{name:'Email',exact:true}).count(),0);
  assert.equal(await page.getByRole('heading',{name:'That Tracks',exact:true}).count(),0);
  await page.setViewportSize({width:700,height:900});
  assert.deepEqual(errors,[]);console.log('Legacy integrations absent: production shell passed');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
