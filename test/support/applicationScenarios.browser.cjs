const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5200';
(async () => {
 const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
 try {
  const page = await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];
  page.on('pageerror', e => errors.push(e.message));
  for (const scenario of ['cancel-queued','restart-pending','resume-after-cancel','archived-report','completion-before-stop']) {
   await page.goto(`${base}/sidebar-workbench.html?scenario=${scenario}&seed=41`);
   await page.locator('.pilot-panel').waitFor();
   const state = await page.evaluate(async () => {
    const { activeChat } = await import('/src/lib/pilotChat.svelte.ts');
    return activeChat();
   });
   assert.equal(state.id,'pilot-00000000000000000000000000000029');
   const panel = page.locator('.pilot-panel');
   assert.match(await panel.innerText(),/Question 1/);
   assert.doesNotMatch(await panel.innerText(),/Stale answer|Late text|Late worker result/);
   if (scenario === 'resume-after-cancel') assert.match(await panel.innerText(),/Current answer/);
   if (scenario === 'completion-before-stop') assert.match(await panel.innerText(),/Confirmed answer/);
   if (scenario === 'cancel-queued' || scenario === 'restart-pending') {
    assert.equal(state.phase,'interrupted'); assert.equal(state.pendingInputs.length,1);
    assert.match(await panel.innerText(),/Question 2/);
   }
   if (scenario === 'archived-report') assert.equal(state.lifecycle,'dormant');
   assert.equal(await page.getByLabel('Application scenario').inputValue(),scenario);
  }
  assert.deepEqual(errors,[]);
  console.log('Five shared deterministic traces rendered through production AppShell');
 } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
