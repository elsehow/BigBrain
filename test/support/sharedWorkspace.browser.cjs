const {chromium}=require('./browserHarness.cjs');
const {spawn}=require('node:child_process');
const {readFileSync,mkdirSync,writeFileSync}=require('node:fs');
const assert=require('node:assert/strict');
const child=spawn('bun',['test/support/sharedWorkspaceFixture.ts'],{stdio:['pipe','pipe','pipe']});
let errors='',output='';child.stderr.on('data',b=>errors+=b);child.stdout.on('data',b=>output+=b);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{let browser;try{
 for(let i=0;!output.includes('\n')&&i<100;i++){if(child.exitCode!==null)throw Error(errors);await pause(50)}
 if(!output.includes('\n'))throw Error('Fixture startup failed: '+errors);
 const fixture=JSON.parse(readFileSync(output.trim().split('\n')[0],'utf8'));
 // The viewer answers only its session (lib/viewerSession.ts): the fixture hands it on.
 const viewerFetch=(url,init={})=>fetch(url,{...init,headers:{authorization:'Bearer '+fixture.secret,...init.headers}});
 for(let i=0;i<100;i++){try{if((await viewerFetch(fixture.base+'/api/vault')).ok)break}catch{}await pause(100)}
 browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});await page.goto(fixture.base+'/api/session?k='+fixture.secret);page.setDefaultTimeout(15000);const pageErrors=[];page.on('pageerror',e=>{pageErrors.push(e.message);console.error('Browser error:',e.message)});
 await page.goto(fixture.base+'/#sharedVaultSettings');
 await page.getByRole('button',{name:'+ Connect a server',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.waitFor();assert.equal(await dialog.locator('input').count(),1);await page.getByLabel('Invite link',{exact:true}).fill(fixture.invite);await dialog.getByRole('button',{name:'Connect',exact:true}).click();await dialog.waitFor({state:'detached'});assert(!new URL(page.url()).searchParams.has('vaults'),'connecting changes no view');await page.goto(fixture.base+'/#sharedVaultSettings');await page.getByRole('button',{name:'Example team',exact:true}).last().click();
 // The server page lists what is on the server, with who added it, and searches note bodies too.
 const onServer=page.getByRole('region',{name:'On this server',exact:true}),launch=onServer.locator('.row').filter({hasText:'Shared launch decision'});await launch.waitFor();assert.equal(await launch.locator('.by').innerText(),'You');
 const find=page.getByLabel('Search this server',{exact:true});await find.fill('launch next week');await launch.waitFor();await find.fill('nothing like this');await onServer.getByText('Nothing matches.',{exact:true}).waitFor();await find.fill('');await launch.waitFor();
 // Withdrawing from the server page hides the note from everyone.
 await page.getByRole('tab',{name:/^Yours/}).click();await page.getByRole('button',{name:'Withdraw',exact:true}).click();await page.getByText('No shared sources.',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Shared launch decision',exact:true}).count(),0);
 const connected=await (await viewerFetch(fixture.base+'/api/shared-connections')).json();const owner=connected.connections.find(c=>c.id!==fixture.readonly);
 let evidence=await viewerFetch(fixture.base+'/api/recent',{headers:{'x-bigbrain-workspace':owner.id}});assert(!(await evidence.text()).includes('Shared launch decision'));
 const shared=async()=>(await(await viewerFetch(fixture.base+'/api/shared-settings/vault?connection='+owner.id)).json()).items;
 assert.equal((await shared())[0].status,'withdrawn');
 // The server's suggestion starts a new lens, its rule reviewed over the whole vault.
 await page.getByRole('button',{name:'Use suggestion',exact:true}).click();const editor=page.getByRole('textbox',{name:'Inclusion rule',exact:true});await editor.waitFor();assert((await editor.innerText()).includes('Example project'));assert.equal(await editor.locator('[data-mention]').count(),1);
 // Exercise the real @ picker independently of the suggested draft.
 await editor.fill('Sources about @Example');await page.getByRole('option').filter({hasText:'Example project'}).click();assert.equal(await editor.locator('[data-mention]').count(),1);
 // Real review API; only model score responses were seeded in the fixture.
 const done=page.getByRole('button',{name:'Done',exact:true});await done.waitFor();assert(await done.isDisabled());
 for(let i=0;i<8;i++){
  await page.waitForFunction(()=>!document.querySelector('.editor [role=alert]')&&document.querySelector('article .judgments button:not(:disabled)'));
  if(await done.isEnabled())break;
  const card=page.locator('article').first();const title=await card.locator('.title').innerText();await card.getByRole('button',{name:(title.startsWith('Include')?'Include: ':'Exclude: ')+title,exact:true}).click();
  await page.waitForFunction(old=>!Array.from(document.querySelectorAll('article .title')).some(e=>e.textContent===old),title);
 }
 await page.waitForFunction(()=>!document.querySelector('.done:disabled'));await done.click();
 // Before anything is saved, the table shows what the rule takes.
 const lensTable=page.getByRole('region',{name:'In this lens',exact:true});
 await lensTable.getByRole('button',{name:'Include Example project 0',exact:true}).waitFor();assert.equal(await lensTable.getByRole('button',{name:'Exclude Example project 0',exact:true}).count(),0);
 // A note the rule misses, added by hand.
 await page.getByRole('button',{name:'Add +',exact:true}).click();await page.getByLabel('Search your vault',{exact:true}).fill('sentinel');
 await page.getByRole('dialog').getByRole('button').filter({hasText:'Personal sentinel'}).click();
 await lensTable.locator('.row').filter({hasText:'Personal sentinel'}).getByText('Added by you').waitFor();
 await page.getByLabel('Name',{exact:true}).fill('Example lens');await page.getByRole('button',{name:'Save rule',exact:true}).click();
 await page.waitForFunction(()=>/^#\/lenses\/lens_[a-f0-9]{12}$/.test(location.hash));
 // Saved, it is still yours alone: nothing reached the server.
 assert.deepEqual((await shared()).filter(x=>x.status==='active'),[]);
 // Sharing with a read-only server is refused; sharing with a writable one asks for the lens's name.
 const ask=async(chip)=>{await chip.click();const dialog=page.getByRole('dialog',{name:'Share Example lens with Example team?',exact:true});await dialog.waitFor();const go=dialog.getByRole('button',{name:'Share with Example team',exact:true});assert(await go.isDisabled());await dialog.getByLabel('Lens name',{exact:true}).fill('Example lens');await go.click();return dialog;};
 const refused=await ask(page.getByRole('button',{name:'+ Example team',exact:true}).first());await refused.getByText('This server is read-only.',{exact:true}).waitFor();await refused.getByRole('button',{name:'Cancel',exact:true}).click();
 const accepted=await ask(page.getByRole('button',{name:'+ Example team',exact:true}).last());await accepted.waitFor({state:'detached'});
 await page.getByRole('button',{name:'✓ Example team',exact:true}).waitFor();
 // The server gets the lens's notes: the rule's matches and the one added by hand.
 let titles=[];for(let i=0;i<100;i++){titles=(await shared()).filter(x=>x.status==='active').map(x=>x.title).sort();if(titles.length>=5)break;await pause(100);}
 assert.deepEqual(titles,['Include Example project 0','Include Example project 1','Include Example project 2','Include Example project 3','Personal sentinel']);
 assert((await shared()).filter(x=>x.status==='active').every(x=>x.lenses.includes('Example lens')));
 mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/lens-shared.png',fullPage:true});
 const storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));assert(!storage.includes(fixture.token));assert(!storage.includes(fixture.invite));
 console.log('Lens review, hand edits, saving and sharing passed.');
 // Exercise model-settings key entry without calling a paid provider.
 writeFileSync(fixture.home+'/jev-settings.json',JSON.stringify({apiKey:null}),{mode:0o600});
 await page.route('**/api/models/jev',async route=>{if(route.request().method()!=='POST')return route.continue();const {apiKey}=route.request().postDataJSON();writeFileSync(fixture.home+'/jev-settings.json',JSON.stringify({apiKey}),{mode:0o600});await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({configured:true,evaluator:'jev'})});});
 await page.goto(fixture.base+'/#agents');await page.getByText('Using Quick',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Add API key',exact:true}).click();const keyInput=page.getByLabel('Jev API key',{exact:true});assert.equal(await keyInput.getAttribute('type'),'password');await keyInput.fill('example-browser-key');await page.getByRole('button',{name:'Save key',exact:true}).click();await page.getByRole('group',{name:'Jev',exact:true}).getByText('Connected',{exact:true}).waitFor();assert.equal(await page.getByLabel('Jev API key',{exact:true}).count(),0);
 assert(!JSON.stringify(await(await viewerFetch(fixture.base+'/api/models/jev')).json()).includes('example-browser-key'));
 await page.reload();await page.getByRole('group',{name:'Jev',exact:true}).getByText('Connected',{exact:true}).waitFor();await page.getByRole('button',{name:'Remove key and use Quick',exact:true}).click();await page.getByText('Using Quick',{exact:true}).waitFor();
 assert.equal(await page.getByText('Could not load models.',{exact:false}).count(),0);
 await page.getByText('Quick',{exact:true}).first().waitFor();
 assert(!(await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}))).includes('example-browser-key'));
 await page.screenshot({path:'artifacts/jev-model-settings.png',fullPage:true});
 // A legacy direct link to the read-only vault still opens the app.
 await page.goto(fixture.base+'/?workspace='+fixture.readonly);await page.locator('.v2').waitFor();
 assert.deepEqual(pageErrors,[]);console.log('PASS: real base and Field invite-only connection, server table and search, withdrawal, a suggested rule as a lens, hand additions, read-only refusal, sharing by name, Jev key settings and no browser secrets.');
}finally{if(browser)await browser.close();child.kill()}})().catch(e=>{console.error(e);process.exitCode=1});
