/** Read-only local-vault h/l replay. All browser API writes are mocked.
 * PROFILE_URL selects a Vite preview; PROFILE_FIXTURE optionally saves/reuses
 * private graph/session data locally for identical before/after measurements.
 * PROFILE_OUTPUT sets the CPU profile path prefix (default /tmp/bb-agent-switch). */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const fs=require('node:fs');
(async()=>{
 const base=process.env.PROFILE_URL||'http://127.0.0.1:5200';
 const fixture=process.env.PROFILE_FIXTURE;
 const captured=fixture && fs.existsSync(fixture) ? JSON.parse(fs.readFileSync(fixture,'utf8')) : {graph:await (await fetch(base+'/api/graph')).json(), ...await (await fetch(base+'/api/pilot/chat')).json()};
 const {graph,sessions}=captured;
 if(fixture && !fs.existsSync(fixture))fs.writeFileSync(fixture,JSON.stringify(captured),{mode:0o600});
 console.log('fixture', {nodes:graph.nodes.length,edges:graph.edges.length,sessions:sessions.length});
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}}); let chatUrl;
 page.on('request',r=>{if(r.url().includes('/src/lib/pilotChat.svelte.ts'))chatUrl=r.url()});
 page.on('pageerror',e=>console.log('pageerror',e.message));
 await page.route('**/api/**',async r=>{
  const u=new URL(r.request().url());
  if(u.pathname==='/api/graph')return r.fulfill({json:graph});
  if(u.pathname==='/api/pilot/chat')return r.fulfill({json:{sessions}});
  if(u.pathname.startsWith('/api/pilot/chat/')) {const b=r.request().postDataJSON()||{};return r.fulfill({json:sessions.find(s=>s.id===b.id)||{notifications:[],ok:true}})}
  if(u.pathname==='/api/setup')return r.fulfill({status:404,json:{}});
  if(u.pathname==='/api/events')return r.fulfill({contentType:'text/event-stream',body:': hello\n\n'});
  if(u.pathname==='/api/vault')return r.fulfill({json:{inbox:{pending:0,unsorted:0},requests:{open:0,done:0}}});
  return r.fulfill({json:{sessions:[],workers:[],sources:[],groups:[],recent:[],notes:[],configured:false}});
 });
 await page.addInitScript(()=>{window.timings=[];window.addEventListener('keydown',e=>{if(!['h','l'].includes(e.key))return;const m={key:e.key,start:performance.now()};window.timings.push(m);let old=location.hash;const poll=()=>{if(location.hash!==old){m.route=performance.now()-m.start;requestAnimationFrame(()=>requestAnimationFrame(()=>m.paint=performance.now()-m.start));}else requestAnimationFrame(poll)};poll();},true)});
 await page.goto(base);await page.locator('.lg-wrap > canvas:not([aria-hidden])').waitFor();await page.waitForTimeout(2500);
 const ids=sessions.filter(s=>s.context.length&&s.messages.length).slice(0,2).map(s=>s.id);if(ids.length<2)throw Error('Need two populated sessions');
 for(const id of ids){await page.evaluate(async({url,id})=>(await import(url)).openChat(id),{url:chatUrl,id});await page.waitForTimeout(1500)}
 await page.evaluate(()=>document.activeElement?.blur());
 const cdp=await page.context().newCDPSession(page);await cdp.send('Profiler.enable');await cdp.send('Profiler.start');
 for(const [i,key] of ['h','l','h','l','h','l'].entries()){await page.keyboard.press(key);await page.waitForFunction(id=>location.hash.endsWith(id),ids[i%2]);await page.waitForTimeout(1000)}
 const {profile}=await cdp.send('Profiler.stop');const output=process.env.PROFILE_OUTPUT||'/tmp/bb-agent-switch';fs.writeFileSync(output+'.cpuprofile',JSON.stringify(profile));
 const byId=new Map(profile.nodes.map(n=>[n.id,n]));const counts=new Map();for(let i=0;i<profile.samples.length;i++){const f=byId.get(profile.samples[i]).callFrame;const k=`${f.functionName||'(anonymous)'} ${f.url.split('/').slice(-2).join('/').split('?')[0]}:${f.lineNumber+1}`;counts.set(k,(counts.get(k)||0)+profile.timeDeltas[i]/1000)}
 console.log('hotspots',JSON.stringify([...counts].sort((a,b)=>b[1]-a[1]).slice(0,25)));
 const timings=await page.evaluate(()=>window.timings);
 if(timings.length!==6 || timings.some(t=>!Number.isFinite(t.paint)))throw Error('Incomplete navigation measurements');
 console.log('timing',JSON.stringify(timings));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
