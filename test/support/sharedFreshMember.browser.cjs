// A member's first look: a freshly created personal vault joins a shared vault
// and lands on its records, not on a blank canvas. Fabricated vaults only.
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
 for(let i=0;i<100;i++){try{if((await fetch(fixture.base+'/api/vault')).ok)break;}catch{}await pause(100);}
 browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(15000);const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
 // Before joining, the empty vault invites a first drop.
 await page.goto(fixture.base+'/#/home');await page.getByRole('heading',{name:'Drop something'}).waitFor();
 // Connecting lands on home, scoped to the vault just joined, with its records listed.
 await page.goto(fixture.base+'/#sharedVaultSettings');await page.getByRole('button',{name:'+ Connect vault',exact:true}).click();
 await page.getByLabel('Invite link',{exact:true}).fill(fixture.invite);await page.getByRole('dialog').getByRole('button',{name:'Connect',exact:true}).click();
 await page.waitForURL(url=>url.searchParams.has('vaults')&&url.searchParams.has('vaultMenu')&&url.hash==='#/home');
 const vault=new URL(page.url()).searchParams.get('vaults');
 const menu=page.locator('.workspace-menu');for(const title of ['Kickoff notes','Budget thread','Uncited memo'])await menu.getByText(title,{exact:true}).waitFor();
 assert.equal(await page.getByRole('heading',{name:'Drop something'}).count(),0);
 // The selected row's quick look is an excerpt of its text, standing in for a briefing.
 await page.locator('.sidebar-quick .original-note.shared-record .note-body').waitFor();
 // Without memories, the entity and the uncited source carry the overview's names.
 const graph=await (await fetch(fixture.base+'/api/graph',{headers:{'x-bigbrain-vault-filter':vault}})).json();const titles=new Map(graph.nodes.map(n=>[n.id,n.title]));
 await page.waitForFunction(()=>(document.querySelector('.graph-renderer canvas')?.profilePresentation?.().labels??[]).filter(l=>l.opacity>.5).length>=2);
 const named=await page.locator('.graph-renderer canvas').evaluate(c=>c.profilePresentation().labels.filter(l=>l.opacity>.5).map(l=>l.id));
 const names=named.map(id=>titles.get(id));assert(names.includes('Example project'),names.join(', '));assert(names.includes('Uncited memo'),names.join(', '));
 // A shared source opens on its text; there is no briefing to fail.
 await menu.getByText('Kickoff notes',{exact:true}).click();
 const original=page.locator('details.original-note');await original.waitFor();assert.equal(await original.getAttribute('open'),'');
 await original.getByText('The Example project kicked off with three workstreams.').waitFor();
 assert.equal(await page.getByText('This note is not available for a briefing.').count(),0);
 assert.deepEqual(pageErrors,[]);console.log('PASS: fresh vault → invite → home in the joined vault, named overview, shared source opens on its text.');
}finally{await browser?.close();child.kill('SIGTERM');}})().catch(e=>{console.error(e);process.exitCode=1;});
