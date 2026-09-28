// The production shell and real setup form, backed only by synthetic API data.
const {chromium}=require('./browserHarness.cjs');
const assert=require('node:assert/strict');
const base=process.env.SIDEBAR_PREVIEW_URL||'http://127.0.0.1:5217';
(async()=>{
 const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
  page.on('pageerror',e=>errors.push(e.stack));
  await page.goto(`${base}/sidebar-workbench.html?connected-agent=setup#sessions/work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.md`);
  // Open the task through the production Agents pane.
  const agents=page.getByRole('button',{name:'Agents',exact:true});
  await agents.focus();await agents.click();
  await page.getByRole('button',{name:'Show orchestrations',exact:true}).click();
  await page.locator('[data-pilot="work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]').click();
  const form=page.getByRole('form',{name:'Project environment setup'});
  await form.waitFor();
  assert.match(await form.textContent(),/Available tools: git, bun, gh/);
  await form.getByLabel('Project name',{exact:true}).fill('Atlas development');
  await form.getByLabel('Agent model',{exact:true}).selectOption('pi/anthropic:claude-opus-5-5');
  await form.getByText('Connected credentials (optional)',{exact:true}).click();
  await form.getByLabel('Variable name',{exact:true}).fill('GH_TOKEN');
  await form.getByLabel('Token',{exact:true}).fill('synthetic-example-token');
  await form.getByRole('button',{name:'Connect credential',exact:true}).click();
  await form.getByRole('button',{name:'Disconnect',exact:true}).waitFor();
  assert.equal(await form.getByLabel('Token',{exact:true}).inputValue(),'');
  await form.getByText('Connected credentials (1)',{exact:true}).click();
  await form.getByRole('heading',{name:'Project environment',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:'/tmp/bigbrain-environment-setup.png',fullPage:true});
  await form.getByRole('button',{name:'Save environment and launch',exact:true}).click();
  await form.waitFor({state:'hidden'});
  const panel=page.getByRole('region',{name:'Agent session conversation'});
  assert.match(await panel.getByRole('status').textContent(),/Working.*claude-opus-5-5/);
  await panel.getByText('Task access and working folder',{exact:true}).click();
  await panel.getByRole('link',{name:'View saved environment'}).click();
  await page.getByRole('heading',{name:'Project environments',exact:true}).waitFor();
  const card=page.locator('article').filter({has:page.getByRole('heading',{name:'Atlas development',exact:true})});
  assert.match(await card.textContent(),/Public internet/);assert.match(await card.textContent(),/GH_TOKEN/);assert.match(await card.textContent(),/claude-opus-5-5/);
  assert(!(await page.locator('body').textContent()).includes('synthetic-example-token'));
  await card.getByRole('button',{name:'Edit environment',exact:true}).click();
  await form.waitFor();assert.equal(await form.getByLabel('Network',{exact:true}).inputValue(),'public');
  await form.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.screenshot({path:'/tmp/bigbrain-environments-settings.png',fullPage:true});
  await card.getByRole('button',{name:'Delete environment',exact:true}).click();await card.waitFor({state:'hidden'});
  assert.deepEqual(errors,[]);
  console.log('Project environment setup, explicit model, credential connection, launch, settings reuse and deletion passed through AppShell.');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
