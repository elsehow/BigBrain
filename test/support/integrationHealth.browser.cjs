// production base over the fabricated scene: integrations that stopped syncing raise ONE notice, with the way to Integrations. No provider calls.
const {chromium}=require('./browserHarness.cjs');
const assert=require('node:assert/strict');
const base=process.env.SIDEBAR_PREVIEW_URL||'http://127.0.0.1:5219';
(async()=>{
 const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const notice=page.locator('[data-notice-id="integration:health"]');
  // an hour of failed polls is not yet worth interrupting anyone; the card still says so
  await page.goto(`${base}/sidebar-workbench.html?integration-health=recent#/integrations`);
  const yours=page.getByRole('region',{name:'Your integrations'});await yours.waitFor();
  assert.match(await yours.getByRole('status').innerText(),/^Granola meeting-list format changed; no cursor was advanced\. · last synced /);
  await page.waitForTimeout(1000);assert.equal(await notice.count(),0);
  // eight hours is: the notice names it, with what its last poll said, and leads to its card
  await page.goto(`${base}/sidebar-workbench.html?integration-health=1#/settings/connected-clients`);
  await notice.waitFor();
  assert.equal(await notice.getByRole('heading').innerText(),'Granola isn’t syncing');
  assert.match(await notice.innerText(),/not syncing/);
  assert.match(await notice.innerText(),/^Granola meeting-list format changed; no cursor was advanced\. Last synced /m);
  assert.deepEqual(await notice.getByRole('button').allInnerTexts(),['Open Integrations','Clear']);
  await notice.getByRole('button',{name:'Open Integrations',exact:true}).click();
  await yours.getByRole('status').waitFor();
  await notice.getByRole('button',{name:'Clear Granola isn’t syncing',exact:true}).click();
  await notice.waitFor({state:'detached'});
  // a rejected key needs the person at once; with the hours-old failure, one notice names both
  await page.goto(`${base}/sidebar-workbench.html?integration-health=many#/settings/connected-clients`);
  await notice.waitFor();
  assert.equal(await notice.getByRole('heading').innerText(),'Integrations aren’t syncing');
  await notice.getByText('Granola and That Tracks. See each in Settings → Integrations.',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);console.log('Integration health: hours or a needed fix raise one notice, Open Integrations and Clear passed');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
