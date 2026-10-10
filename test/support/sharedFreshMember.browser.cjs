// A member's first look: a freshly created personal vault joins a shared vault,
// and its records appear in the same field. Fabricated vaults only.
const {chromium}=require('./browserHarness.cjs');
const {spawn}=require('node:child_process');
const {readFileSync}=require('node:fs');
const assert=require('node:assert/strict');
const child=spawn('bun',['test/support/sharedFreshMemberFixture.ts'],{stdio:['ignore','pipe','pipe']});
let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{let browser;try{
 for(let i=0;!output.includes('\n')&&i<300;i++){if(child.exitCode!==null)throw Error(errors);await pause(100);}
 const fixture=JSON.parse(readFileSync(output.trim().split('\n')[0],'utf8'));
 // The viewer answers only its session (lib/viewerSession.ts): the fixture hands it on.
 const viewerFetch=(url,init={})=>fetch(url,{...init,headers:{authorization:'Bearer '+fixture.secret,...init.headers}});
 for(let i=0;i<100;i++){try{if((await viewerFetch(fixture.base+'/api/vault')).ok)break;}catch{}await pause(100);}
 browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:900}});await page.goto(fixture.base+'/api/session?k='+fixture.secret);page.setDefaultTimeout(15000);const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
 // Before joining, the empty vault says so.
 await page.goto(fixture.base+'/');await page.getByText('Nothing here yet').waitFor();
 // Connecting changes no view: the joined vault's records join the same field.
 await page.goto(fixture.base+'/#sharedVaultSettings');await page.getByRole('button',{name:'+ Connect a server',exact:true}).click();
 await page.getByLabel('Invite link',{exact:true}).fill(fixture.invite);await page.getByRole('dialog').getByRole('button',{name:'Connect',exact:true}).click();
 await page.getByRole('dialog').waitFor({state:'detached'});
 const url=new URL(page.url());assert(!url.searchParams.has('vaults')&&!url.searchParams.has('workspace'),url.href);
 await page.keyboard.press('Escape');
 await page.locator('.v2-node',{hasText:'Example project'}).first().waitFor({state:'attached'});
 assert.equal(await page.getByText('Nothing here yet').count(),0);
 assert.deepEqual(pageErrors,[]);console.log('PASS: fresh vault → invite → the joined vault\'s records in the same field, with no switch.');
}finally{await browser?.close();child.kill('SIGTERM');}})().catch(e=>{console.error(e);process.exitCode=1;});
