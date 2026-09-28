/** Search interaction latency before/during a scratch gardener run. No model/write routes. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path');
const root=fs.realpathSync(process.argv[2]||'');
if(!path.basename(root).startsWith('bb-gardener-profile-')||!fs.existsSync(path.join(root,'.benchmark-snapshot')))throw Error('Prepared snapshot required');
const base='http://127.0.0.1:53927';
const stats=a=>{const v=[...a].sort((a,b)=>a-b);return {count:v.length,p50Ms:v[Math.ceil(v.length*.5)-1],p95Ms:v[Math.ceil(v.length*.95)-1],maxMs:v.at(-1)}};
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
const page=await browser.newPage({viewport:{width:1440,height:1000}});
let errors=0;page.on('pageerror',()=>errors++);
await page.route('**/*',r=>r.request().method()==='GET'&&new URL(r.request().url()).origin===base?r.continue():r.abort());
await page.goto(base,{waitUntil:'domcontentloaded'});await page.waitForTimeout(8000);
const sample=async i=>{
const q=['project','memory','research','work','meeting','model','planning','notes'][i%8];
await page.getByRole('combobox',{name:'Search the vault'}).fill('');await page.waitForTimeout(200);
const start=performance.now();
const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/search'&&new URL(r.url()).searchParams.get('q')===q);
await page.getByRole('combobox',{name:'Search the vault'}).fill(q);
const res=await response;await res.finished();
if(res.status()!==200)throw Error('Search route failed');
const responseMs=performance.now()-start;
await page.locator('#search-results').waitFor();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
return {responseMs,paintedMs:performance.now()-start};
};

const baseline=[];for(let i=0;i<8;i++){baseline.push(await sample(i));await page.waitForTimeout(2000)}
fs.writeFileSync(path.join(root,'.profile-viewer-ready'),'ready');
console.log(JSON.stringify({stage:'viewer-ready',baseline:{response:stats(baseline.map(r=>r.responseMs)),painted:stats(baseline.map(r=>r.paintedMs))}}));
const deadline=Date.now()+25*60000;
while(!fs.existsSync(path.join(root,'.profile-started'))){if(Date.now()>deadline)throw Error('Gardener did not start');await page.waitForTimeout(500)}
const during=[];
while(!fs.existsSync(path.join(root,'.profile-result.json'))){if(Date.now()>deadline)throw Error('Gardener did not finish');during.push(await sample(during.length));await page.waitForTimeout(2000)}
const result={baseline,during,errors,summary:Object.fromEntries(Object.entries({baseline,during}).map(([label,a])=>[label,{response:stats(a.map(r=>r.responseMs)),painted:stats(a.map(r=>r.paintedMs))}]))};
fs.writeFileSync(path.join(root,'.profile-viewer.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({stage:'viewer-summary',errors,summary:result.summary}));
}finally{await browser.close()}})().catch(error=>{console.error(JSON.stringify({error:error.name,message:error.message.split('\n')[0]}));process.exitCode=1});
