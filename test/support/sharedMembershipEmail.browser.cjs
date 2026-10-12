// The members screen when the shared door signs members in with Google: Email + Access
// invites a pending member and shows the vault's join link; the app refuses that link.
const {chromium}=require('./browserHarness.cjs');
const {spawn}=require('node:child_process');
const {readFileSync}=require('node:fs');
const assert=require('node:assert/strict');
const child=spawn('bun',['test/support/sharedWorkspaceFixture.ts'],{stdio:['pipe','pipe','pipe'],env:{...process.env,BB_FIXTURE_EMAIL_INVITES:'1'}});
let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{let browser;try{
 for(let i=0;!output.includes('\n')&&i<150;i++){if(child.exitCode!==null)throw Error(errors);await pause(100);}
 const fixture=JSON.parse(readFileSync(output.trim().split('\n')[0],'utf8'));
 // The viewer answers only its session (lib/viewerSession.ts): the fixture hands it on.
 const viewerFetch=(url,init={})=>fetch(url,{...init,headers:{authorization:'Bearer '+fixture.secret,...init.headers}});
 for(let i=0;i<100;i++){try{if((await viewerFetch(fixture.base+'/api/vault')).ok)break;}catch{}await pause(100);}
 const owner=(path,body)=>fetch(fixture.endpoint+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+fixture.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}).then(r=>r.json());
 browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});await page.goto(fixture.base+'/api/session?k='+fixture.secret);const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
 await page.goto(fixture.base+'/#sharedVaultSettings');
 // The join link pasted into the app is refused with directions, before any request.
 await page.getByRole('button',{name:'+ Connect a server',exact:true}).click();await page.getByLabel('Invite link',{exact:true}).fill(fixture.endpoint+'/join');await page.getByRole('dialog').getByRole('button',{name:'Connect',exact:true}).click();
 await page.getByRole('dialog').getByRole('alert').filter({hasText:'open it in your browser'}).waitFor();
 await page.getByLabel('Invite link',{exact:true}).fill(fixture.invite);await page.getByRole('dialog').getByRole('button',{name:'Connect',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});await page.goto(fixture.base+'/#sharedVaultSettings');await page.getByRole('button',{name:'Example team',exact:true}).last().click();
 await page.getByRole('button',{name:/^Show (all \d+ people|1 person)$/}).click();await page.getByRole('button',{name:'Invite someone',exact:true}).click();
 assert.equal(await page.getByLabel('Name',{exact:true}).count(),0);
 await page.getByLabel('Email',{exact:true}).fill('mara@example.com');await page.getByRole('button',{name:'Create invite link'}).click();
 assert.equal(await page.getByLabel('Join link',{exact:true}).inputValue(),fixture.endpoint+'/join');
 await page.getByText('They’ll sign in with Google as mara@example.com.').waitFor();
 await page.screenshot({path:fixture.home+'/email-invite.png'});
 await page.getByRole('button',{name:'Done',exact:true}).click();
 const row=page.locator('.row').filter({hasText:'mara@example.com'});await row.getByText('Not signed in yet',{exact:false}).waitFor();
 const pending=(await owner('/v1/members')).members.find(m=>m.email==='mara@example.com');assert.equal(pending.pending,true);
 await row.getByRole('button',{name:'Cancel invite'}).click();await row.waitFor({state:'detached'});
 assert.equal((await owner('/v1/members')).members.some(m=>m.email==='mara@example.com'),false);
 assert.deepEqual(pageErrors,[]);console.log('PASS: email invite → join link → pending member → cancelled; join link refused by the app. Screenshot: '+fixture.home+'/email-invite.png');
 }finally{await browser?.close();child.kill('SIGTERM');}})().catch(e=>{console.error(e);process.exitCode=1;});
