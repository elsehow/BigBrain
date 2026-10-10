// production base and Field with synthetic setup and account responses. No real accounts.
const {chromium,webkit}=require('./browserHarness.cjs');
const assert=require('node:assert/strict');
(async()=>{const browser=process.env.BROWSER==='webkit'?await webkit.launch():await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});try{
 const page=await browser.newPage({viewport:{width:1100,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 let metrics={configured:true,decided:false,enabled:false,samples:[],operations:{},actions:{},queued:0,delivery:'idle'};const choices=[];
 let rejectVault=true,setupReads=0;const invites=[];
 let step='vault',fail=false,hasVault=false,identity=null,claude=false,chatgpt=false;
 const local=[{kind:'claude-code',name:'Claude Code',available:true,connected:false},{kind:'codex',name:'Codex',available:true,connected:false}];
 const library=[{id:'browser',name:'Browser extension',description:'Save pages and highlights.',added:false},{id:'granola',name:'Granola',description:'Meeting transcripts.',added:false}];
 const account={name:'granola',account:'granola',label:'granola',connected:false,grants:[{caller:'pilot',access:'read'}],capabilities:{read:'Read meetings.',write:null}};const posted=[];
 const setup=()=>({vault:hasVault?{path:'/fixture/new-vault',created:'2026-09-24'}:null,identity,claude:{connected:claude,installed:'fixture',account:'Fixture',plugin:null},agent:null,anthropic:{connected:claude,phase:claude?'connected':'idle'},chatgpt:{connected:chatgpt,phase:chatgpt?'connected':'idle'},codex:{installed:'fixture',account:null,connected:false},onboarding:step});
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname,json=v=>route.fulfill({json:v}),body=route.request().postDataJSON();
  if(path==='/api/setup'){setupReads++;return json(setup());}
  if(path==='/api/setup/vault'){if(rejectVault)return json({...setup(),pick:{path:body.path,problem:'Install Xcode Command Line Tools: xcode-select --install. Then choose the folder again.'}});hasVault=true;return json(setup());}
  if(path==='/api/setup/identity'){identity={name:body.name,entity_id:'fixture'};return json(setup());}
  if(path==='/api/setup/anthropic/login'){claude=true;return json(setup().anthropic);}
  if(path==='/api/setup/chatgpt/login'){chatgpt=true;return json(setup().chatgpt);}
  if(path==='/api/setup/progress'){if(fail)return route.fulfill({status:500,json:{error:'Save failed'}});step=body.step;return json(setup());}
  if(path==='/api/integration-accounts'){
    if(body?.action==='install')library.find(i=>i.id===body.name).added=true;
    if(body?.action==='connect')account.connected=true;
    if(body?.action==='save'){posted.push(body.grants);for(const g of body.grants??[])account.grants=[...account.grants.filter(x=>x.caller!==g.caller),...(g.access==='off'?[]:[g])];}
    return json({library,accounts:[account],callers:[{id:'pilot',label:'Pilot'},{id:'token:fixture',label:'Fixture client'}]});
  }
  if(path==='/api/connected-clients'){if(body?.action==='local')local.find(c=>c.kind===body.kind).connected=body.enabled;return json({clients:[],local});}
  if(path==='/api/telemetry'){if(typeof body?.enabled==='boolean'){choices.push(body.enabled);metrics={...metrics,enabled:body.enabled,decided:true};}return json(metrics);}
  if(path==='/api/setup/join'){invites.push(body.invite);hasVault=true;identity={name:'Ines Example',entity_id:'fixture'};step='reader';return json({...setup(),joined:{id:'fixture-team',name:'Example team'}});}
  if(path==='/api/graph')return json({nodes:[],edges:[],hash:'fixture'});
  if(path==='/api/recent')return json({recent:[],total:0,nextOffset:null});
  if(path==='/api/pilot/chat'||path==='/api/work/sessions')return json({sessions:[]});
  if(path==='/api/source/read-state')return json({sources:[],scope:'stored_sources'});
  return route.fulfill({status:404,json:{error:'Outside fixture'}});
 });
 const base=process.env.VIEWER_URL||'http://127.0.0.1:5305';
 const url=base.endsWith('.html')?base:base+'/dist/index.html';
 await page.route(url => url.origin !== new URL(base).origin, route => route.abort());
 await page.goto(url);
 await page.getByRole('button',{name:'CREATE',exact:true}).click();await page.getByRole('button',{name:'GO',exact:true}).click();
 const remedy=page.getByText(/Install Xcode Command Line Tools:/);await remedy.waitFor();
 const polls=setupReads;
 await new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(setupReads>=polls+2){clearInterval(timer);resolve();}else if(Date.now()-start>10000){clearInterval(timer);reject(Error('Setup polling did not continue'));}},50);});
 assert(await remedy.isVisible(),'the prerequisite remains visible after repeated status polls');
 rejectVault=false;await page.getByRole('button',{name:'GO',exact:true}).click();
 await remedy.waitFor({state:'detached'});
 await page.getByLabel('Your name',{exact:true}).fill('Fixture');assert.equal(step,'vault');
 await page.getByRole('button',{name:'Next →',exact:true}).click();await page.getByRole('heading',{name:'Connect providers',exact:true}).waitFor();
 await page.getByRole('region',{name:'Claude provider'}).getByRole('button',{name:'Connect Claude',exact:true}).click();
 await page.getByRole('button',{name:'Connect ChatGPT',exact:true}).click();await page.getByRole('region',{name:'ChatGPT provider'}).getByText('Connected',{exact:true}).waitFor();
 assert.equal(step,'providers');assert.equal(await page.getByRole('heading',{name:'Connect providers',exact:true}).count(),1);
 fail=true;await page.getByRole('button',{name:'Next →',exact:true}).click();await page.getByRole('alert').filter({hasText:'Save failed'}).waitFor();fail=false;
 await page.getByRole('button',{name:'Next →',exact:true}).click();await page.getByRole('heading',{name:'Connect agents',exact:true}).waitFor();
 await page.getByRole('checkbox',{name:/Codex/}).check();await page.getByText('Access enabled',{exact:true}).waitFor();assert.equal(local[1].connected,true);
 await page.reload();await page.getByRole('heading',{name:'Connect agents',exact:true}).waitFor();assert(await page.getByRole('checkbox',{name:/Codex/}).isChecked());
 await page.getByRole('navigation',{name:'Setup steps'}).getByRole('button',{name:/Integrations/}).click();await page.getByRole('heading',{name:'Connect integrations',exact:true}).waitFor();
 await page.locator('article').filter({hasText:'Granola'}).getByRole('button',{name:'+ Add',exact:true}).click();
 // an account's settings open from its row
 await page.getByRole('region',{name:'granola accounts'}).locator('summary').first().click();
 await page.getByRole('region',{name:'granola accounts'}).getByRole('button',{name:'Connect',exact:true}).click();
 const pilot=page.getByRole('combobox',{name:'Live access for Pilot',exact:true}),client=page.getByRole('combobox',{name:'Live access for Fixture client',exact:true});
 assert.equal(await pilot.inputValue(),'read');assert.equal(await client.inputValue(),'off');assert.equal(await client.locator('option').count(),2,'no write level where the account offers none');
 await pilot.selectOption('off');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Saved.',{exact:true}).waitFor();
 assert.deepEqual(posted,[[{caller:'pilot',access:'off'}]],'Save sends only the caller that changed');assert.deepEqual(account.grants,[]);assert.equal(await pilot.inputValue(),'off');
 await page.setViewportSize({width:600,height:1000});await page.screenshot({path:'/tmp/bb-first-run-integrations.png'});
 assert.deepEqual(choices,[]);assert.equal(metrics.enabled,false);
 await page.getByRole('button',{name:'Next →',exact:true}).click();await page.getByRole('heading',{name:'Help improve BigBrain',exact:true}).waitFor();assert.equal(step,'analytics');
 await page.getByRole('button',{name:'No thanks',exact:true}).click();assert(!new URL(page.url()).searchParams.has('vaults'),'joining during setup changes no view');
 await page.waitForFunction(()=>!document.querySelector('[aria-label="Set up BigBrain"]'));assert.equal(step,'complete');assert.deepEqual(choices,[false]);
 // An existing configured vault has no progress marker and goes straight to its app.
 step=undefined;await page.reload();await page.waitForFunction(()=>!!document.querySelector('.v2'));assert.equal(await page.getByRole('dialog',{name:'Set up BigBrain'}).count(),0);assert.deepEqual(account.grants,[]);
 // Joining a server on a new machine: no vault, no provider. A vault is made quietly and the app opens on the server's notes.
 hasVault=false;identity=null;claude=false;chatgpt=false;step=undefined;rejectVault=false;library.forEach(i=>i.added=false);
 await page.reload();const join=page.getByRole('form',{name:'Join a server',exact:true});await join.waitFor();
 const inviteLink='https://vault.example.test/invite#'+'A'.repeat(43);
 assert(await join.getByRole('button',{name:'CONNECT',exact:true}).isDisabled());
 await join.getByLabel('Invite link',{exact:true}).fill(inviteLink);await join.getByRole('button',{name:'CONNECT',exact:true}).click();
 await page.waitForFunction(()=>!!document.querySelector('.v2')&&!document.querySelector('[aria-label="Set up BigBrain"]'));assert.deepEqual(invites,[inviteLink]);assert.equal(step,'reader');
 // Adding something asks for a provider first: the regular setup flow, from its providers screen.
 await page.evaluate(()=>{location.hash='#/integrations';});await page.locator('article').filter({hasText:'Granola'}).getByRole('button',{name:'+ Add',exact:true}).click();
 await page.getByRole('heading',{name:'Connect providers',exact:true}).waitFor();assert.equal(step,'providers');assert.equal(library.find(i=>i.id==='granola').added,false);
 assert.deepEqual(errors,[]);console.log('Production wizard: explicit navigation, providers, client configuration, library defaults/save, reload, failure recovery, existing-vault bypass, joining a server as a reader, and a provider asked for on first add passed');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
