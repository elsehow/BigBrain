const {chromium}=require('./browserHarness.cjs');
const assert=require('node:assert/strict');
const base=process.env.SIDEBAR_PREVIEW_URL||'http://127.0.0.1:5218';
(async()=>{
 const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];page.on('pageerror',e=>errors.push(e.stack));
  await page.goto(`${base}/sidebar-workbench.html?connected-agent=setup&environment-chat#/session/pilot-11111111111111111111111111111111`);
  const approval=page.getByRole('region',{name:'Project environment approval'});await approval.waitFor();
  assert.match(await approval.textContent(),/api.example.com/);
  assert.equal(await page.getByRole('form',{name:'Project environment setup'}).count(),0);
  assert.equal(await approval.locator('select').count(),0);
  await page.addStyleTag({content:'*, *::before, *::after { transition:none !important; }'});
  // Approval cards stay on the normal palette in read and unread states.
  for (const theme of ['default','dusk','web','phosphor','somethings-gotta-give','yamabukiiro','moegiiro','adzukiiro','asagiiro']) {
   for (const unread of [false,true]) {
    const colors=await approval.evaluate((el,{theme,unread})=>{
     document.documentElement.setAttribute('data-theme',theme);
     const notice=el.closest('.notice-message');notice.classList.toggle('notice-unread',unread);
     const foreground=getComputedStyle(notice).color;
     return {foreground,background:getComputedStyle(notice).backgroundColor,primary:{color:getComputedStyle(el.querySelector('.primary')).color,background:getComputedStyle(el.querySelector('.primary')).backgroundColor},controls:[...el.querySelectorAll('button:not(.primary),p,dt')].map(node=>getComputedStyle(node).color)};
    },{theme,unread});
    for (const color of colors.controls) assert.equal(color,colors.foreground,`${theme}, unread=${unread}: approval follows notification foreground`);
    assert.notEqual(colors.foreground,colors.background);
    assert.equal(colors.primary.color,colors.background);
    assert.equal(colors.primary.background,colors.foreground);
   }
  }
  await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dusk'));
  await page.screenshot({path:'/tmp/bigbrain-environment-themed.png',fullPage:true});
  await page.evaluate(()=>document.documentElement.setAttribute('data-theme','default'));
  const editor=page.locator('.pilot-panel [contenteditable="true"]');await editor.fill('Leave the network off.');await editor.press('Enter');
  await approval.getByText('Off',{exact:true}).waitFor();
  assert.equal(await approval.count(),1,'the superseded approval is no longer actionable');
  await approval.getByRole('button',{name:'Allow and launch',exact:true}).waitFor();
  await page.screenshot({path:'/tmp/bigbrain-conversational-setup.png',fullPage:true});
  await approval.getByRole('button',{name:'Allow and launch',exact:true}).click();await approval.waitFor({state:'hidden'});
  const state=await page.evaluate(async()=>({projects:await(await fetch('/api/agent-orchestration')).json(),work:await(await fetch('/api/pilot/work?id=work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).json()}));
  assert.equal(state.work.status,'working');assert.equal(state.projects.projects.find(p=>p.label==='Atlas').domains.length,0);
  // A credential is connected in the inline control, never sent as a chat message.
  await page.goto(`${base}/sidebar-workbench.html?connected-agent=setup&environment-chat&needs-token#/session/pilot-11111111111111111111111111111111`);
  await approval.waitFor();
  assert(await approval.getByRole('button',{name:'Allow and launch',exact:true}).isDisabled());
  await approval.getByLabel('Token for EXAMPLE_TOKEN',{exact:true}).fill('synthetic-token');
  await approval.getByRole('button',{name:'Connect EXAMPLE_TOKEN',exact:true}).click();
  await approval.getByLabel('Token for EXAMPLE_TOKEN',{exact:true}).waitFor({state:'hidden'});
  assert(!(await page.locator('.transcript').innerText()).includes('synthetic-token'));
  await approval.getByRole('checkbox',{name:'Remember for this project'}).uncheck();
  await approval.getByRole('button',{name:'Decline',exact:true}).click();await approval.waitFor({state:'hidden'});
  const job=await page.evaluate(async()=>(await(await fetch('/api/pilot/work?id=work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).json()));assert.equal(job.status,'interrupted');
  await page.goto(`${base}/sidebar-workbench.html?connected-agent=setup&environment-chat#/session/pilot-11111111111111111111111111111111`);
  await approval.waitFor();
  await page.locator('.pilot-panel [contenteditable="true"]').fill('Keep this setup pending.');
  await page.locator('.pilot-panel [contenteditable="true"]').press('Enter');
  await approval.getByRole('img',{name:'Unread',exact:true}).waitFor({state:'hidden'});
  assert(await approval.getByText('Needs approval',{exact:true}).isVisible(),'reading does not resolve the approval');
  await page.getByRole('button',{name:/^Mark unread/}).click();
  await approval.getByRole('img',{name:'Unread',exact:true}).waitFor();
  await approval.getByRole('link',{name:'Advanced settings',exact:true}).click();
  await page.getByRole('form',{name:'Project environment setup'}).waitFor();
  assert.deepEqual(errors,[]);console.log('Conversational setup, scope revision, inline approval, private credential input and decline passed through production AppShell.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
