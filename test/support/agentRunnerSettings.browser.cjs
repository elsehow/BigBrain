const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5216';
(async()=>{
 const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.stack));
  await page.goto(`${base}/sidebar-workbench.html#/settings/agent-orchestration`);
  await page.getByRole('button',{name:'New environment +',exact:true}).click();
  await page.getByLabel('Project name',{exact:true}).fill('Example project');
  await page.getByLabel('Project folder',{exact:true}).fill('/sample/example');
  assert.equal(await page.getByLabel('Workspace access',{exact:true}).inputValue(),'work');
  await page.getByLabel('Workspace access',{exact:true}).selectOption('work');
  await page.getByText('Reference folders (optional)',{exact:true}).click();
  await page.getByLabel('Network',{exact:true}).selectOption('domains');
  await page.getByLabel('Read-only reference folders',{exact:true}).fill('/sample/reference');
  await page.getByLabel('Allowed domains',{exact:true}).fill('registry.npmjs.org');
  await page.getByLabel('email: demo@example.com',{exact:true}).check();
  await page.getByRole('button',{name:'Save environment',exact:true}).click();
  const row=page.locator('.settings-card').filter({hasText:'Example project'});await row.waitFor();
  assert.match(await row.textContent(),/Development/);
  await page.reload();await row.waitFor();await row.getByRole('button',{name:'Edit environment',exact:true}).click();
  assert.equal(await page.getByLabel('Project folder',{exact:true}).inputValue(),'/sample/example');
  assert.equal(await page.getByLabel('Allowed domains',{exact:true}).inputValue(),'registry.npmjs.org');
  assert(await page.getByLabel('email: demo@example.com',{exact:true}).isChecked());
  await page.getByLabel('Workspace access',{exact:true}).selectOption('read');await page.getByRole('button',{name:'Save environment',exact:true}).click();await row.getByText(/Read files/).waitFor();
  await page.setViewportSize({width:600,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:'/tmp/bb-project-authorization.png'});
  await row.getByRole('button',{name:'Delete environment',exact:true}).click();await row.waitFor({state:'hidden'});await page.reload();assert.equal(await row.count(),0);
  assert.deepEqual(errors,[]);console.log('Production AppShell project authorization: modes, references, network, accounts, reload, revocation and narrow layout passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
