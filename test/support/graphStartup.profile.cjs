/** Read-only startup/CPU profile. Point only at a disposable local preview.
 * First navigation has empty browser caches; two reloads reuse this tab.
 * Timings include profiler overhead. Optional GRAPH_PROFILE_PREFIX saves CPU traces. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('fs');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 await page.route('**/*',r=>r.request().method()==='GET'&&['localhost','127.0.0.1'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());
 await page.addInitScript(()=>{
  window.graphProfile={requests:[],firstDraw:null,tasks:[]};
  new PerformanceObserver(l=>window.graphProfile.tasks.push(...l.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});
  const original=window.fetch;
  window.fetch=async(...args)=>{const row={url:String(args[0]),start:performance.now()};window.graphProfile.requests.push(row);const res=await original(...args);row.headers=performance.now();return res;};
  const fill=CanvasRenderingContext2D.prototype.fill;
  CanvasRenderingContext2D.prototype.fill=function(...args){if(this.canvas.isConnected&&this.canvas.closest('.g-canvas')&&!window.graphProfile.firstDraw)window.graphProfile.firstDraw=performance.now();return fill.apply(this,args);};
 });
 const cdp=await page.context().newCDPSession(page);
 await cdp.send('Profiler.enable');
 for(let i=0;i<3;i++){
  await cdp.send('Profiler.start');
  await page.goto(process.env.GRAPH_PREVIEW_URL || 'http://127.0.0.1:5198/');
  await page.waitForFunction(()=>window.graphProfile.firstDraw);
  await page.waitForTimeout(350);
  const {profile}=await cdp.send('Profiler.stop');if (process.env.GRAPH_PROFILE_PREFIX) fs.writeFileSync(`${process.env.GRAPH_PROFILE_PREFIX}-${i}.cpuprofile`,JSON.stringify(profile));
  console.log(JSON.stringify(await page.evaluate(()=>({...window.graphProfile,storageBytes:sessionStorage.getItem('bb:/api/graph')?.length,resources:performance.getEntriesByType('resource').filter(e=>e.name.includes('/api/')||e.initiatorType==='script').map(e=>({url:e.name,start:e.startTime,duration:e.duration,size:e.transferSize})),paints:performance.getEntriesByType('paint')}))));
 }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
