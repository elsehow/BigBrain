/** Browser note latency against a synthetic fixture served by web/server.ts.
 * NOTE_PROFILE_FIXTURE=<fixture JSON> GRAPH_PREVIEW_URL=<scratch URL> node ...
 * Generated briefings are disabled here and benchmarked independently. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
(async () => {
 const fixture = JSON.parse(fs.readFileSync(process.env.NOTE_PROFILE_FIXTURE, 'utf8'));
 const base = process.env.GRAPH_PREVIEW_URL;
 if (!base || !fixture.root.includes('bb-note-profile-')) throw new Error('Synthetic fixture and scratch server URL required');
 const browser = await chromium.launch({ channel: 'chrome', headless: true });
 try {
  const page = await browser.newPage({ viewport: { width:1440, height:1000 }});
  await page.route('**/api/**', r => r.request().method() === 'GET' ? r.continue() : r.fulfill({ status: 503, json: { error:'Model work disabled during local latency measurement' } }));
  await page.addInitScript(() => {
   window.noteProfile = { tasks: [] };
   new PerformanceObserver(l => window.noteProfile.tasks.push(...l.getEntries().map(e => ({ start:e.startTime, duration:e.duration })))).observe({type:'longtask',buffered:true});
  });
  for (let run=0; run<7; run++) {
   const index = run % 3, path = fixture.paths[index], title = `Synthetic project ${index}`;
   const route = `#/vault/${encodeURIComponent(path)}`;
   if (run === 0) await page.goto(base + '/' + route, {waitUntil:'domcontentloaded'});
   const result = await page.evaluate(async ({route,title,initial}) => {
    const start = initial ? 0 : performance.now();
    if (!initial) location.hash = route;
    await new Promise((resolve,reject) => {
     const timeout=setTimeout(()=>{observer.disconnect();reject(new Error('Note did not render'));},10000);
     const check=()=>{if(document.querySelector('.note-title')?.textContent===title && document.querySelector('.note-ts')){clearTimeout(timeout);observer.disconnect();resolve();}};
     const observer=new MutationObserver(check);observer.observe(document.body,{subtree:true,childList:true,characterData:true});check();
    });
    const domMs=performance.now()-start;
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const paintedMs=performance.now()-start;
    return {domMs,paintedMs,requests:performance.getEntriesByType('resource').filter(e=>e.startTime>=start&&e.name.includes('/api/')).map(e=>({path:new URL(e.name).pathname,durationMs:e.duration,bytes:e.transferSize})),longTasks:window.noteProfile.tasks.filter(e=>e.start>=start)};
   }, {route,title,initial:run===0});
   console.log(JSON.stringify({run,mode:run===0?'page-load':run<3?'uncached-note':'cached-note',...result}));
   await page.waitForTimeout(300);
  }
  const requests = {};
  const observe = request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/')) requests[url.pathname] = (requests[url.pathname] || 0) + 1; };
  page.on('request', observe);
  await page.waitForTimeout(6000);
  page.off('request', observe);
  console.log(JSON.stringify({ mode: 'idle', durationMs: 6000, requests }));
 } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
