// Real Chromium extension + disposable intake harness. Set EXTENSION_TEST_BASE.
const { chromium } = require('playwright-core');
const { mkdtempSync, rmSync, writeFileSync, cpSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const assert = require('node:assert/strict');
(async () => {
 const base = process.env.EXTENSION_TEST_BASE;
 assert(base?.startsWith('http://127.0.0.1:'), 'Use the disposable loopback harness');
 const profile = mkdtempSync(join(tmpdir(), 'bb-store-chromium-'));
 const current = resolve('clients/browser-extension');
 const extension = join(profile,'extension');
 cpSync(current,extension,{recursive:true});
 const launch = () => chromium.launchPersistentContext(join(profile,'browser'), {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2,
  args: ['--remote-debugging-port=0', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
 });
 let context=await launch();
 const debugPort=readFileSync(join(profile,'browser','DevToolsActivePort'),'utf8').split('\n')[0];
 try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = worker.url().split('/')[2];
  assert.equal(id, 'ddnflabpbjfcakilfjmbinhblgbmckpb');
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.bringToFront();
  await options.locator('#endpoint').fill(base);
  const code = await fetch(`${base}/fixture/pair`).then(r=>r.json());
  await options.locator('#code').fill(code.code);
  await options.locator('#connect').click();
  await options.locator('#state').filter({hasText:/^CONNECTED$/}).waitFor();
  assert.equal(await options.locator('#state').innerText(),'CONNECTED');
  assert(await options.locator('[data-face]').evaluateAll(faces=>new Set(faces.map(f=>getComputedStyle(f).backgroundColor)).size)>2,'Cube faces must remain visually distinct');
  const article = await context.newPage(); await article.goto(`${base}/article`); await article.bringToFront();
  await worker.evaluate(()=>chrome.action.openPopup());
  const target = await (async()=>{for(let i=0;i<100;i++){const targets=await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r=>r.json());const t=targets.find(t=>t.url.endsWith('/popup.html'));if(t)return t;await new Promise(r=>setTimeout(r,50));}throw Error('No popup target');})();
  const socket=new WebSocket(target.webSocketDebuggerUrl); await new Promise(r=>socket.addEventListener('open',r,{once:true}));
  let seq=0;const waiting=new Map();socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(waiting.has(m.id)){const [yes,no]=waiting.get(m.id);waiting.delete(m.id);if(m.error)no(m.error);else yes(m.result);}});
  const command=(method,params={})=>new Promise((yes,no)=>{const id=++seq;waiting.set(id,[yes,no]);socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>(await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value;
  for(let i=0;i<150;i++){if(await evaluate("document.getElementById('status')?.textContent") === 'IN THE VAULT')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(await evaluate("document.getElementById('status').textContent"),'IN THE VAULT');
  await new Promise(r=>setTimeout(r,1000));
  const out=process.env.EXTENSION_SCREENSHOTS;
  const shot=async name=>{const r=await command('Page.captureScreenshot',{format:'png'});writeFileSync(join(out,name),Buffer.from(r.data,'base64'));};
  if(out){await shot('chromium-popup.png');await article.screenshot({path:join(out,'chromium-article.png')});}
  await evaluate("document.getElementById('note').value='Connect this with my community garden plans.'");
  if(out)await shot('chromium-note.png');
  await evaluate("document.getElementById('note').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
  await new Promise(r=>setTimeout(r,1500));socket.close();
  assert((await fetch(`${base}/fixture/evidence`).then(r=>r.json())).some(s=>s.title==='A small guide to urban gardens'));
  assert((await fetch(`${base}/fixture/evidence`).then(r=>r.json())).some(s=>s.body==='Connect this with my community garden plans.'));
  await options.bringToFront(); await options.reload();
  assert.equal(await options.locator('#state').innerText(),'CONNECTED');
  if(out)await options.screenshot({path:join(out,'chromium-options.png')});
  await context.close();
  context=await launch();
  const restored=await context.newPage();
  await restored.goto(`chrome-extension://${id}/options.html`);
  await restored.locator('#state').filter({hasText:/^CONNECTED$/}).waitFor();
  console.log('Chromium real pairing, capture, note, and browser-restart persistence passed.');
 } finally { await context.close(); rmSync(profile,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1;});
