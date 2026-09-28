/** Real-vault keyboard CPU profile: creates and cancels only empty drafts.
 * Records key-to-DOM and key-to-second-frame timings; writes Chrome CPU profiles.
 * GRAPH_PREVIEW_URL, PLAYWRIGHT_MODULE and PILOT_PROFILE_PREFIX are optional. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({channel:'chrome'});
 try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});let storeUrl;
 page.on('request',r=>{if(r.url().includes('/src/lib/store.svelte.ts'))storeUrl=r.url()});
 await page.addInitScript(()=>{
  window.measurements=[];window.longtasks=[];
  new PerformanceObserver(list=>{for(const e of list.getEntries())window.longtasks.push({start:e.startTime,duration:e.duration})}).observe({type:'longtask',buffered:true});
  window.addEventListener('keydown',e=>{
   if(!(e.key==='Escape'||e.key==='Enter'&&e.shiftKey))return;
   const m={key:e.key,start:performance.now()};window.measurements.push(m);
   requestAnimationFrame(()=>requestAnimationFrame(()=>m.frame=performance.now()-m.start));
   const open=e.key==='Enter';const check=()=>{
    const el=document.querySelector('[aria-label="Message Pilot"]');
    if((open&&el)||(!open&&!el)){m.dom=performance.now()-m.start;obs.disconnect();if(open)m.focus=document.activeElement===el;}
   };const obs=new MutationObserver(check);obs.observe(document.body,{childList:true,subtree:true});check();
  },true);
 });
 await page.goto(process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5198/');await page.locator('.lg-wrap > canvas:not([aria-hidden])').waitFor();await page.waitForTimeout(2000);
 const graph=await page.evaluate(async()=>{const g=await(await fetch('/api/graph')).json();return {nodes:g.nodes.length,edges:g.edges.length,ids:g.nodes.filter(n=>n.path).slice(0,2).map(n=>n.id)}});
 console.log('graph',JSON.stringify({nodes:graph.nodes,edges:graph.edges}));
 const cdp=await page.context().newCDPSession(page);await cdp.send('Profiler.enable');
 for(const [name,ids] of [['empty',[]],['context',graph.ids]]){
  await page.evaluate(async({url,ids})=>{const {app}=await import(url);app.graphView={selected:ids,excluded:[]}}, {url:storeUrl,ids});await page.waitForTimeout(1200);
  await cdp.send('Profiler.start');
  await page.keyboard.press('Shift+Enter');await page.getByLabel('Message Pilot').waitFor();await page.waitForTimeout(500);
  await page.keyboard.press('Escape');await page.getByLabel('Message Pilot').waitFor({state:'detached'});await page.waitForTimeout(900);
  const {profile}=await cdp.send('Profiler.stop');fs.writeFileSync(`${process.env.PILOT_PROFILE_PREFIX || "/tmp/bb-pilot"}-${name}.cpuprofile`,JSON.stringify(profile));
  const byId=new Map(profile.nodes.map(n=>[n.id,n]));const counts=new Map();
  for(let i=0;i<profile.samples.length;i++){const n=byId.get(profile.samples[i]);const f=n.callFrame;const k=`${f.functionName||'(anonymous)'} ${f.url.split('/').slice(-2).join('/').split('?')[0]}:${f.lineNumber+1}`;counts.set(k,(counts.get(k)||0)+profile.timeDeltas[i]/1000)}
  console.log(name,JSON.stringify([...counts].sort((a,b)=>b[1]-a[1]).slice(0,20)));
 }
 console.log('timing',JSON.stringify(await page.evaluate(()=>({events:window.measurements,longtasks:window.longtasks.filter(t=>t.start>=window.measurements[0].start)}))));
 } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1)});
