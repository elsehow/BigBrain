const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({channel:'chrome'});
 try {
  const page = await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const base=process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5221';
  const id='pilot-'+'f'.repeat(32), now=new Date().toISOString();
  let sent;
  const s={id,title:'Native approval UI test',model:'gpt-6-astra',backend:{adapter:'codex',model:'gpt-6-astra'},phase:'working',nativeExecution:true,lifecycle:'active',seed:[],context:[],viewRevision:0,revision:1,draft:'',messages:[{id:'u',role:'user',text:'Test approval',at:now}],live:'',activity:'commandExecution',error:'',created:now,updated:now,nativeRequests:[{id:'request-unique',threadId:'t',turnId:'u',itemId:'i',method:'item/commandExecution/requestApproval',kind:'command',reason:'Allow the test command?',detail:'printf native-ready',canAccept:true}]};
  await page.route('**/api/pilot/chat',r=>r.fulfill({json:{sessions:[s]}}));
  await page.route('**/api/pilot/chat/native/respond',r=>{sent=r.request().postDataJSON();s.nativeRequests=[];s.revision++;return r.fulfill({json:s});});
  await page.goto(base);await page.getByRole('button',{name:/Pilots/}).first().waitFor();
  await page.keyboard.press('a');await page.getByText(s.title,{exact:true}).first().click();
  const request=page.getByRole('region',{name:'Pilot request'});
  assert.equal(await page.getByRole('button',{name:/Session access:/}).count(),0);
  assert.equal(await page.getByRole('region',{name:'Session access',exact:true}).count(),0);
  await request.getByText('printf native-ready',{exact:true}).waitFor();
  await request.getByRole('button',{name:'Allow',exact:true}).click();
  await request.waitFor({state:'hidden'});
  assert.deepEqual(sent,{id,requestId:'request-unique',answer:{decision:'accept'}});
  assert.deepEqual(errors,[]);
  console.log('Native approval renders and sends the exact session/request response.');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
