const {chromium}=require('playwright-core');
const {spawn}=require('node:child_process');
const {mkdtempSync,readFileSync,existsSync,mkdirSync}=require('node:fs');
const {tmpdir}=require('node:os');const {join}=require('node:path');const assert=require('node:assert/strict');
const home=mkdtempSync(join(tmpdir(),'bb-owner-browser-'));
let child;
async function serve(){
 const previous=existsSync(join(home,'launch-url'))?readFileSync(join(home,'launch-url'),'utf8'):'';
 child=spawn('bun',['bin/shared-owner.ts','--home',home,'--port','0'],{stdio:['ignore','pipe','pipe']});
 let errors='';child.stderr.on('data',b=>errors+=b);
 for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(errors||'Server exited');if(existsSync(join(home,'launch-url'))){const url=readFileSync(join(home,'launch-url'),'utf8').trim();if(url&&url!==previous.trim())return url}await new Promise(r=>setTimeout(r,50))}throw Error('Server did not start');
}
async function stop(){if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r))}}
(async()=>{let browser;try{
 const launch=await serve(),base=new URL(launch).origin;
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.waitForFunction(()=>document.querySelector('#error').textContent.includes('launcher'));
 await page.goto(launch);await page.waitForSelector('#setup:not([hidden])');
 await page.getByLabel('Vault name').fill('Example team');await page.getByLabel('Your owner handle').fill('owner');await page.getByRole('button',{name:'Create vault'}).click();
 await page.waitForSelector('#workspace:not([hidden])');
 assert.equal(await page.locator('#identity').innerText(),'owner · owner');
 await page.getByRole('button',{name:'+ Add evidence'}).click();
 await page.locator('[name=title]').fill('Launch decision');await page.locator('[name=body]').fill('The team will start with a local owner interface. <script>bad()</script>');await page.getByRole('button',{name:'Save',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#detail h2')?.textContent==='Launch decision');
 await page.getByRole('button',{name:'Make assertion',exact:true}).click();await page.locator('[name=text]').fill('The team will start with a local owner interface.');await page.getByRole('button',{name:'Save',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#detail h2')?.textContent==='The team will start with a local owner interface.');
 assert.equal(await page.locator('#detail .citation').innerText(),'Launch decision');
 await page.getByRole('button',{name:'Correct',exact:true}).click();await page.locator('[name=text]').fill('The team will test a local owner interface before remote sharing.');await page.locator('[name=reason]').fill('Clarified the sequence.');await page.getByRole('button',{name:'Save',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#detail h2')?.textContent==='The team will test a local owner interface before remote sharing.');
 await page.getByLabel('Search vault').fill('remote sharing');await page.getByRole('button',{name:'Search',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.record').length===1);
 mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/shared-owner-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'artifacts/shared-owner-mobile.png',fullPage:true});
 await page.getByRole('button',{name:'Retract',exact:true}).click();await page.locator('[name=reason]').fill('Superseded by the next planning round.');await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#detail').textContent.includes('Retired'));
 await stop();const restarted=await serve();await page.goto(restarted);await page.waitForSelector('#workspace:not([hidden])');await page.getByRole('button',{name:'Evidence',exact:true}).click();await page.getByRole('button',{name:/Launch decision/}).click();await page.waitForFunction(()=>document.querySelector('#detail h2')?.textContent==='Launch decision');
 assert.ok((await page.locator('#detail .body').innerText()).includes('<script>bad()</script>'));
 assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>Object.keys(localStorage).length),0);
 console.log('PASS: create, evidence, citations, assertion, correction, search, retraction, restart, auth gate, safe rendering, mobile width.');
}finally{if(browser)await browser.close();await stop()}})().catch(e=>{console.error(e);process.exitCode=1});
