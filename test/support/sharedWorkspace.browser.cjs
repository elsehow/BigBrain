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
 browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
 await page.goto(fixture.base+'/#sharedVaultSettings');
 await page.getByRole('button',{name:'+ Connect vault',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.waitFor();assert.equal(await dialog.locator('input').count(),1);await page.getByLabel('Invite link',{exact:true}).fill(fixture.invite);await dialog.getByRole('button',{name:'Connect',exact:true}).click();await dialog.waitFor({state:'detached'});
 await page.getByRole('button',{name:'Use suggestion',exact:true}).click();const editor=page.getByRole('textbox',{name:'Inclusion rule',exact:true});await editor.waitFor();assert((await editor.innerText()).includes('Example project'));assert.equal(await editor.locator('[data-mention]').count(),1);
 // Exercise the real @ picker independently of the suggested draft.
 await editor.fill('Sources about @Example');await page.getByRole('option').filter({hasText:'Example project'}).click();assert.equal(await editor.locator('[data-mention]').count(),1);
 await page.getByRole('button',{name:'Save and enable',exact:true}).click();await page.getByText('Automatically adding new matches',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Test rule',exact:true}).count(),0);
 await page.getByRole('button',{name:'Remove rule',exact:true}).click();await page.getByRole('button',{name:'Use suggestion',exact:true}).waitFor();
 await page.getByRole('button',{name:'Added by you',exact:false}).click();await page.getByRole('button',{name:'Withdraw',exact:true}).click();await page.getByRole('button',{name:'Restore',exact:true}).waitFor();await page.getByText('Won’t be added again unless you restore it.',{exact:true}).waitFor();
 const connected=await (await fetch(fixture.base+'/api/shared-connections')).json();const owner=connected.connections.find(c=>c.id!==fixture.readonly);
 let evidence=await fetch(fixture.base+'/api/recent',{headers:{'x-bigbrain-workspace':owner.id}});assert(!(await evidence.text()).includes('Shared launch decision'));
 await page.getByRole('button',{name:'Restore',exact:true}).click();await page.getByRole('button',{name:'Withdraw',exact:true}).waitFor();
 mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/shared-settings-real-shell.png',fullPage:true});
 const storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));assert(!storage.includes(fixture.token));assert(!storage.includes(fixture.invite));
 await page.goto(fixture.base+'/?workspace='+fixture.readonly);await page.getByText('Read only',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Add evidence',exact:true}).count(),0);
 assert.deepEqual(pageErrors,[]);console.log('PASS: real AppShell invite-only connection, remote suggestion, entity chips/picker, explicit activation/removal, withdrawal visibility/restore, read-only and no browser secrets.');
}finally{if(browser)await browser.close();child.kill()}})().catch(e=>{console.error(e);process.exitCode=1});
