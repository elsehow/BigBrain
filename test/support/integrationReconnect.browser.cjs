// production base over the fabricated scene: an integration sign-in that can no longer renew raises ONE notice. No provider calls.
const {chromium}=require('./browserHarness.cjs');
const assert=require('node:assert/strict');
const base=process.env.SIDEBAR_PREVIEW_URL||'http://127.0.0.1:5219';
(async()=>{
 const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const notice=page.locator('[data-notice-id="integration:reconnect"]');
  // several lapsed accounts share one notice, which opens Integrations
  await page.goto(`${base}/sidebar-workbench.html?lapsed-accounts=many#/settings/connected-clients`);
  await notice.waitFor();
  assert.equal(await notice.getByRole('heading').innerText(),'Integrations need reconnecting');
  await notice.getByText('Hardcover · sample_reader, Hardcover · Book club, Hardcover · Second reader and 2 more. BigBrain can no longer renew these sign-ins; reconnect each in Settings → Integrations.',{exact:true}).waitFor();
  assert.deepEqual(await notice.getByRole('button').allInnerTexts(),['Open Integrations','Clear']);
  await page.evaluate(()=>{const f=globalThis.fetch;window.posted=[];globalThis.fetch=(input,init)=>{if(typeof init?.body==='string')window.posted.push(JSON.parse(init.body));return f(input,init);};});
  await notice.getByRole('button',{name:'Open Integrations',exact:true}).click();
  const yours=page.getByRole('region',{name:'Your integrations'});await yours.waitFor();
  // Clear forgets the notice for every account; each card still says what to do
  await notice.getByRole('button',{name:'Clear Integrations need reconnecting',exact:true}).click();
  await notice.waitFor({state:'detached'});
  assert.deepEqual((await page.evaluate(()=>window.posted)).filter(b=>b.action==='dismiss').map(b=>b.account),['hardcover','account-1111','account-2222','account-3333','account-4444']);
  await yours.getByRole('button',{name:'Configure',exact:true}).click();
  const region=page.getByRole('region',{name:'hardcover accounts'});await region.waitFor();
  await region.locator('summary > span').first().waitFor();
  assert.deepEqual(await region.locator('summary > span').allInnerTexts(),Array(5).fill('Needs reconnecting'));
  // a sign-in card says what Disconnect forgets
  await region.locator('summary').first().click();
  await region.getByText('Disconnecting forgets who signed in; choose access again after the next sign-in.',{exact:true}).first().waitFor();
  // one lapsed account is named, with Reconnect, which signs in as the card's does
  await page.goto(`${base}/sidebar-workbench.html?lapsed-accounts=1#/settings/connected-clients`);
  await notice.waitFor();
  assert.equal(await notice.getByRole('heading').innerText(),'Hardcover · sample_reader');
  assert.match(await notice.innerText(),/needs reconnecting/);
  await notice.getByText('Needs reconnecting. BigBrain can no longer renew this sign-in, so agents can’t read the account until you sign in again.',{exact:true}).waitFor();
  assert.deepEqual(await notice.getByRole('button').allInnerTexts(),['Reconnect','Clear']);
  await page.evaluate(()=>{const f=globalThis.fetch;window.posted=[];globalThis.fetch=(input,init)=>{if(typeof init?.body==='string')window.posted.push(JSON.parse(init.body));return f(input,init);};});
  await notice.getByRole('button',{name:'Reconnect',exact:true}).click();
  await notice.waitFor({state:'detached'});
  assert.deepEqual(await page.evaluate(()=>window.posted),[{name:'hardcover',account:'hardcover',action:'connect'}]);
  // a lapsed connection and a lapsed account: one notice for each kind
  await page.goto(`${base}/sidebar-workbench.html?expired-clients=1&lapsed-accounts=1#/settings/connected-clients`);
  await notice.waitFor();
  const notices=page.locator('[data-notice-kind="connection"]');
  await page.locator('[data-notice-id="connection:expired"]').waitFor();
  assert.equal(await notices.count(),2);
  assert.deepEqual(errors,[]);console.log('Integration reconnect: one notice, Reconnect and Clear passed');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
