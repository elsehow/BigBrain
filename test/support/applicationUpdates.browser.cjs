// Production AppShell, two open views, fabricated application SSE messages.
const { chromium } = require('./browserHarness.cjs');
const assert = require('node:assert/strict');
const base = process.env.SIDEBAR_PREVIEW_URL || 'http://127.0.0.1:5200';
(async () => {
 const browser = await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome',headless:true});
 try {
  const pages = await Promise.all([browser.newPage(), browser.newPage()]);
  for (const page of pages) {
   await page.goto(`${base}/sidebar-workbench.html?connected-agent=working`);
   await page.waitForFunction(() => document.querySelector('.graph-renderer canvas')?.profilePresentation?.().nodes.length > 0);
   await page.evaluate(async () => {
    const {chat} = await import('/src/lib/pilotChat.svelte.ts');
    const {app} = await import('/src/lib/store.svelte.ts');
    window.fixtureId = chat.sessions[0].id;
    chat.drafts[window.fixtureId] = 'My unsent draft';
    window.viewRevision = () => app.rev;
    window.requestCounts = {pilot:0,work:0,notification:0,graph:0};
    const fetch = window.fetch;
    window.fetch = (...args) => {
     const url = String(args[0]);
     if (url.includes('/api/pilot/chat/notifications')) window.requestCounts.notification++;
     else if (url.includes('/api/pilot/chat')) window.requestCounts.pilot++;
     if (url.includes('/api/pilot/work')) window.requestCounts.work++;
     if (url.includes('/api/graph')) window.requestCounts.graph++;
     return fetch(...args);
    };
    window.dispatchEvent(new CustomEvent('workbench-application',{detail:{epoch:'fixture',revision:0,snapshot:true,entities:[]}}));
   });
   await page.waitForTimeout(1000);
   await page.evaluate(() => { window.requestCounts = {pilot:0,work:0,notification:0,graph:0}; window.initialRev = window.viewRevision(); });
  }
  await pages[0].waitForTimeout(3200);
  for (const page of pages) {
   assert.deepEqual(await page.evaluate(() => window.requestCounts), {pilot:0,work:0,notification:0,graph:0},'healthy idle makes no application polls');
   await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('workbench-agent-status',{detail:'idle'}));
    window.dispatchEvent(new CustomEvent('workbench-application',{detail:{epoch:'fixture',revision:1,entities:[{kind:'work',id:'work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',revision:2}]}}));
   });
   await page.waitForFunction(async () => (await import('/src/lib/workSessions.svelte.ts')).work.sessions.some(s => s.status === 'idle'));
   const counts = await page.evaluate(() => window.requestCounts);
   assert.equal(counts.work,1); assert.equal(counts.pilot,0); assert.equal(counts.graph,0);
   assert.equal(await page.evaluate(() => window.viewRevision()), await page.evaluate(() => window.initialRev));
   for (const event of [{epoch:'fixture',revision:3,entities:[]},{epoch:'restarted',revision:0,snapshot:true,entities:[]}]) {
    await page.evaluate(detail => window.dispatchEvent(new CustomEvent('workbench-application',{detail})),event);
    await page.waitForTimeout(300);
   }
   assert.equal(await page.evaluate(async () => (await import('/src/lib/pilotChat.svelte.ts')).chat.drafts[window.fixtureId]),'My unsent draft');
  }
  console.log(JSON.stringify({views:2,idleWindowMs:3200,idleRequests:0,taskUpdateRequests:1,taskUpdateTopologyRequests:0,draftsPreserved:true}));
 } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode=1; });
