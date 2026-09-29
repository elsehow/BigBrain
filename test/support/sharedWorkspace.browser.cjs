const {chromium}=require('./browserHarness.cjs');
const {spawn}=require('node:child_process');
const {readFileSync,mkdirSync}=require('node:fs');
const assert=require('node:assert/strict');
const child=spawn('bun',['test/support/sharedWorkspaceFixture.ts'],{stdio:['pipe','pipe','pipe']});
let errors='',output='';child.stderr.on('data',b=>errors+=b);child.stdout.on('data',b=>output+=b);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{let browser;try{
 for(let i=0;!output.includes('\n')&&i<100;i++){if(child.exitCode!==null)throw Error(errors);await pause(50)}
 if(!output.includes('\n'))throw Error('Fixture startup failed: '+errors);
 const fixture=JSON.parse(readFileSync(output.trim().split('\n')[0],'utf8'));
 for(let i=0;i<100;i++){try{if((await fetch(fixture.base+'/api/vault')).ok)break}catch{}await pause(100)}
 browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const pageErrors=[];page.on('pageerror',e=>{pageErrors.push(e.message);console.error(e.stack)}); page.setDefaultTimeout(15000); page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('Failed to load resource'))console.error(m.text())});
 await page.goto(fixture.base);await page.locator('.vault-switcher > button').filter({hasText:'Personal vault'}).click();
 await page.getByRole('button',{name:'Connect shared vault…'}).click();
 await page.getByLabel('Name',{exact:true}).fill('Example team');await page.getByLabel('Server address').fill(fixture.endpoint);await page.getByLabel('Member credential').fill(fixture.token);
 await page.getByRole('button',{name:'Connect',exact:true}).click();
 await page.locator('.vault-switcher > button').filter({hasText:'Example team'}).waitFor();
 assert(new URL(page.url()).searchParams.get('workspace'));
 await page.locator('.vault-switcher > button').filter({hasText:'Example team'}).click();await page.getByText('Example Owner · owner · read and write').waitFor();await page.locator('.vault-switcher > button').filter({hasText:'Example team'}).click();
 await page.getByRole('button',{name:'Add evidence',exact:true}).click();await page.getByLabel('Title',{exact:true}).fill('Shared browser note');await page.getByLabel('Text',{exact:true}).fill('A contribution from the normal BigBrain shell.');await page.getByRole('button',{name:'Add to shared vault'}).click();
 await page.getByText('A contribution from the normal BigBrain shell.',{exact:true}).waitFor();
 await page.getByLabel('Make an assertion from this evidence').fill('[[Example project]] is ready for a browser review.');await page.getByRole('button',{name:'Assert',exact:true}).click();
 await page.getByRole('button',{name:'Correct or retract'}).waitFor();
 await page.getByRole('button',{name:'Correct or retract'}).click();await page.getByLabel('Correction',{exact:true}).fill('[[Example project]] is ready for an owner review.');await page.getByLabel('Reason',{exact:true}).fill('Clarified the reviewer.');await page.getByRole('button',{name:'Save correction'}).click();
 await page.waitForFunction(()=>document.querySelector('.shared-assertions')?.textContent.includes('owner review'));
 assert.equal(await page.getByText('Private fixture text only.',{exact:true}).count(),0);
 await page.keyboard.press('Escape');await page.keyboard.press('r');await page.getByRole('listbox',{name:'Recently added'}).waitFor();
 assert((await page.locator('body').innerText()).includes('Shared browser note'));
 await page.keyboard.press('/');await page.getByRole('combobox',{name:'Search the vault'}).fill('owner review');await page.waitForFunction(()=>document.querySelector('#search-results')?.textContent.includes('Example project'));assert(!(await page.locator('#search-results').innerText()).includes('Personal sentinel'));await page.keyboard.press('Escape');await page.keyboard.press('Escape');await page.keyboard.press('r');
 mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/shared-shell.png',fullPage:true});
 const storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));assert(!storage.includes(fixture.token));assert(!storage.includes('A contribution from the normal BigBrain shell.'));
 await page.locator('.vault-switcher > button').filter({hasText:'Example team'}).click();await page.getByRole('button',{name:'Personal vault',exact:true}).click();await page.locator('.vault-switcher > button').filter({hasText:'Personal vault'}).waitFor();await page.keyboard.press('r');await page.getByRole('listbox',{name:'Recently added'}).waitFor();assert((await page.locator('body').innerText()).includes('Personal sentinel'));assert(!(await page.locator('body').innerText()).includes('Shared browser note'));
 await page.goto(fixture.base+'/?workspace='+fixture.readonly);await page.getByText('Read only',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Add evidence',exact:true}).count(),0);
 await page.locator('.vault-switcher > button').filter({hasText:'Example read only'}).click();await page.getByRole('button',{name:'Example team',exact:true}).click();await page.locator('.vault-switcher > button').filter({hasText:'Example team'}).waitFor();child.stdin.write('revoke\n');
 await page.waitForFunction(()=>document.body.textContent.includes('unauthorized') && !document.querySelector('.graph-renderer')); assert.equal(await page.locator('.graph-renderer').count(),0);assert.equal(await page.getByRole('button',{name:'Add evidence',exact:true}).count(),0);
 assert.deepEqual(pageErrors,[]);
 console.log('PASS: production AppShell connect, identity, evidence, assertion/correction, recents, switch isolation, read-only, revoked access, no browser credential storage.');
}finally{if(browser)await browser.close();child.kill()}})().catch(e=>{console.error(e);process.exitCode=1});
