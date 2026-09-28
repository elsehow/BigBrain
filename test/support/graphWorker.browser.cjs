/** Production-bundle smoke/profile: synthetic graph, no server or vault access.
 * PROFILE_IDLE=1 adds idle measurements; PROFILE_ATTENTION=1 adds a pending question.
 * PROFILE_SERVE=1 serves this fixture on 127.0.0.1:53918 for native WebKit.
 * PROFILE_UNREAD=1 covers unread-source attention.
 * PROFILE_HEADFUL=1 shows Chrome.
 * Always check reported visibility before interpreting a background-tab sample. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('fs'),path=require('path');
const dist=path.resolve(__dirname, '../../web/ui/dist');
const assert=require('node:assert/strict');
const nodes=Array.from({length:4166},(_,i)=>({id:`n${i}`,title:`Synthetic ${i}`,group:i<180?'entity':'source',degree:0,...(process.env.PROFILE_UNREAD && i===181 ? {readState:{unread:true}} : {}),...(process.env.PROFILE_ATTENTION && i===180 ? {group:'pilot',pilotPhase:'active',pilotNeedsYou:true}:{}),x:Math.cos(i*2.4)*Math.sqrt(i)*12,y:Math.sin(i*2.4)*Math.sqrt(i)*12}));
let graphRevision=0;
const edges=Array.from({length:12008},(_,i)=>{const a=180+i%3986,b=(i*17+Math.floor(i/3986))%180;nodes[a].degree++;nodes[b].degree++;return {source:`n${a}`,target:`n${b}`}});
// Native WebKit can use the exact same production-bundle fixture.
const respond=r=>{const u=new URL(r.request().url());if(u.origin!=='http://127.0.0.1:53918')return r.abort();
if(u.pathname==='/')return r.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(dist,'index.html'))});
if(u.pathname.startsWith('/assets/'))return r.fulfill({contentType:u.pathname.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(path.join(dist,'assets',path.basename(u.pathname)))});
if(u.pathname==='/api/graph')return r.fulfill({json:{hash:`synthetic-worker-benchmark-${graphRevision}`,nodes,edges}});
if(['/api/pilot/chat','/api/pilot/work'].includes(u.pathname))return r.fulfill({json:{sessions:[]}});
if(u.pathname==='/api/source/read-state')return r.fulfill({json:{sources:[],scope:'stored_sources'}});
if(u.pathname==='/api/recent')return r.fulfill({json:{items:[],nextOffset:null}});
if(u.pathname==='/api/vault')return r.fulfill({json:{queue:{},view:{entities:180,references:3986},inbox:{pending:0,unsorted:0},requests:{open:0,done:0}}});
return r.fulfill({status:404,json:{error:'Disabled in benchmark'}})};
if(process.env.PROFILE_SERVE) {
require('http').createServer((req,res)=>respond({
 request:()=>({url:()=>`http://127.0.0.1:53918${req.url}`}),
 abort:()=>{res.writeHead(403);res.end()},
 fulfill:o=>{res.writeHead(o.status||200,{'Content-Type':o.contentType||(o.json?'application/json':'text/plain')});res.end(o.json?JSON.stringify(o.json):o.body)},
})).listen(53918,'127.0.0.1');
} else (async()=>{const b=await chromium.launch({channel:'chrome',headless:process.env.PROFILE_HEADFUL !== '1'});try{
const context=await b.newContext({viewport:{width:1440,height:1000}});const p=await context.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));
await p.route('**/*',respond);
await p.addInitScript(()=>{window.testEvents=[];window.EventSource=class extends EventTarget { constructor(){super();window.testEvents.push(this);setTimeout(()=>this.dispatchEvent(new Event('open')),0)} close(){} };window.measure={tasks:[],draw:null,workerDone:null,frames:0};const raf=window.requestAnimationFrame;window.requestAnimationFrame=fn=>raf.call(window,t=>{window.measure.frames++;fn(t)});new PerformanceObserver(l=>window.measure.tasks.push(...l.getEntries().map(x=>({start:x.startTime,ms:x.duration})))).observe({type:'longtask',buffered:true});const fill=CanvasRenderingContext2D.prototype.fill;CanvasRenderingContext2D.prototype.fill=function(...a){if(this.canvas.closest('.g-canvas')&&!window.measure.draw)window.measure.draw=performance.now();return fill.apply(this,a)};const Native=window.Worker;window.Worker=class extends Native{constructor(...a){super(...a);this.addEventListener('message',()=>window.measure.workerDone=performance.now())}}});
if(process.env.PROFILE_IDLE) {
await p.goto('http://127.0.0.1:53918');await p.waitForFunction(()=>window.measure.workerDone,{},{timeout:60000});await p.waitForTimeout(1000);
const cdp=await p.context().newCDPSession(p);await cdp.send('Performance.enable');await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:false});
if(process.env.PROFILE_ATTENTION || process.env.PROFILE_UNREAD) {
  const overlay=p.locator('.attention-overlay.has-attention');
  await overlay.waitFor();
  const opacity=()=>overlay.evaluate(el=>Number(getComputedStyle(el).opacity));
  const start=await opacity();await p.waitForTimeout(700);
  assert(Math.abs(await opacity()-start)>.01, 'Attention must still breathe while graph sleeps');
  assert.equal(await overlay.evaluate(el=>getComputedStyle(el).pointerEvents),'none');
  const pixels=()=>overlay.evaluate(el=>{const a=el.getContext('2d').getImageData(0,0,el.width,el.height).data;let count=0,x=0,y=0;for(let i=3;i<a.length;i+=4)if(a[i]){count++;x+=(i-3)/4%el.width;y+=Math.floor((i-3)/4/el.width)}return {count,x,y}});
  assert((await pixels()).count>0, 'Attention brackets must be painted');
  const before=await pixels();await p.mouse.move(700,450);await p.mouse.wheel(0,-200);await p.waitForTimeout(1500);
  assert.notDeepEqual(await pixels(),before,'Attention must follow graph zoom');
  await p.mouse.move(0,0);await p.waitForTimeout(1500);
  await p.emulateMedia({reducedMotion:'reduce'});await p.waitForTimeout(300);
  assert.equal(await overlay.evaluate(el=>getComputedStyle(el).animationName),'none');
  assert.equal(await opacity(),.8);
  await p.emulateMedia({reducedMotion:'no-preference'});await p.waitForTimeout(1000);
}
const sample=async label=>{const before=await cdp.send('Performance.getMetrics');const a=await p.evaluate(()=>({frames:window.measure.frames,visibility:document.visibilityState}));await p.waitForTimeout(6000);const after=await cdp.send('Performance.getMetrics');const z=await p.evaluate(()=>({frames:window.measure.frames,visibility:document.visibilityState}));const get=(r,n)=>r.metrics.find(m=>m.name===n)?.value??0;if(process.env.PROFILE_ATTENTION || process.env.PROFILE_UNREAD) {assert.equal(z.frames-a.frames,0,'Attention alone must not schedule graph frames');assert.equal(errors.length,0);}
console.log(JSON.stringify({label,visibility:z.visibility,frames:z.frames-a.frames,seconds:6,taskSeconds:get(after,'TaskDuration')-get(before,'TaskDuration'),heapBytes:get(after,'JSHeapUsedSize'),errors}));};
await sample(process.env.PROFILE_ATTENTION ? 'foreground-attention' : process.env.PROFILE_UNREAD ? 'foreground-unread' : 'foreground-idle');const other=await p.context().newPage();await other.goto('about:blank');await other.bringToFront();await sample('background-tab');await other.close();
if(process.env.PROFILE_ATTENTION || process.env.PROFILE_UNREAD) {
  for(const n of nodes) {n.pilotNeedsYou=false;if(n.readState)n.readState.unread=false;}
  graphRevision++;
  await p.evaluate(()=>{for(const es of window.testEvents)es.onmessage?.({data:'{}'})});
  await p.waitForFunction(()=>!document.querySelector('.attention-overlay.has-attention'));
  assert.equal(await p.locator('.attention-overlay').evaluate(el=>getComputedStyle(el).opacity),'0');
}
await p.close();

} else {
for(let run=0;run<2;run++) {await p.goto('http://127.0.0.1:53918');await p.waitForFunction(()=>window.measure.draw);if(!run)await p.waitForFunction(()=>window.measure.workerDone,{},{timeout:60000});await p.waitForTimeout(400);const result=await p.evaluate(()=>window.measure); if(errors.length || (!run && !(result.draw < result.workerDone)) || (run && result.workerDone !== null)) throw new Error('Worker/cached rendering regression: '+JSON.stringify({run,result,errors})); console.log(JSON.stringify({run,...result,errors}));}
}

}finally{await b.close()}})().catch(e=>{console.error(e);process.exitCode=1});
