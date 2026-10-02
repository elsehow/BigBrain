// Production AppShell with synthetic setup and account responses. No real accounts.
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
 const account={name:'granola',account:'granola',label:'granola',connected:false,remembering:{enabled:true,rule:'Record raw transcripts.'},liveAccess:true,capabilities:{read:'Read meetings.',write:null}};
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
    if(body?.action==='save'){account.remembering=body.remembering;account.liveAccess=body.liveAccess;}
    return json({library,accounts:[account]});
  }
  if(path==='/api/connected-clients'){if(body?.action==='local')local.find(c=>c.kind===body.kind).connected=body.enabled;return json({clients:[],local});}
  if(path==='/api/telemetry'){if(typeof body?.enabled==='boolean'){choices.push(body.enabled);metrics={...metrics,enabled:body.enabled,decided:true};}return json(metrics);}
  if(path==='/api/shared-settings'&&route.request().method()==='POST'){invites.push(body.invite);return route.fulfill({status:201,json:{id:'fixture-team',name:'Example team',endpoint:'https://vault.example.test'}});}
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
 await page.getByRole('button',{name:'Next →',exact:true}).click();await page.getByRole('heading',{name:'Connect clients',exact:true}).waitFor();
 await page.getByRole('checkbox',{name:/Codex/}).check();await page.getByText('Access enabled',{exact:true}).waitFor();assert.equal(local[1].connected,true);
 await page.reload();await page.getByRole('heading',{name:'Connect clients',exact:true}).waitFor();assert(await page.getByRole('checkbox',{name:/Codex/}).isChecked());
 await page.getByRole('navigation',{name:'Setup steps'}).getByRole('button',{name:/Integrations/}).click();await page.getByRole('heading',{name:'Connect integrations',exact:true}).waitFor();
 await page.locator('article').filter({hasText:'Granola'}).getByRole('button',{name:'+ Add',exact:true}).click();
 await page.getByRole('region',{name:'granola accounts'}).getByRole('button',{name:'Connect',exact:true}).click();
 assert(await page.getByRole('checkbox',{name:'Automatic remembering',exact:true}).isChecked());assert(await page.getByRole('checkbox',{name:'Live access',exact:true}).isChecked());
 await page.getByRole('checkbox',{name:'Live access',exact:true}).uncheck();await page.getByRole('button',{name:'Save',exact:true}).click();assert.equal(account.liveAccess,false);
 // A member joining a shared vault redeems the invite here and finishes setup inside it.
 const sharedInvite=page.getByRole('region',{name:'Shared vault'}),inviteLink='https://vault.example.test/invite#'+'A'.repeat(43);
 await sharedInvite.getByLabel('Invite link',{exact:true}).fill(inviteLink);await sharedInvite.getByRole('button',{name:'Connect',exact:true}).click();
 await sharedInvite.getByText('Example team',{exact:true}).waitFor();await sharedInvite.getByText('Connected',{exact:true}).waitFor();assert.deepEqual(invites,[inviteLink]);
 await page.setViewportSize({width:600,height:1000});await page.screenshot({path:'/tmp/bb-first-run-integrations.png'});
 assert.deepEqual(choices,[]);assert.equal(metrics.enabled,false);
 await page.getByRole('button',{name:'Next →',exact:true}).click();await page.getByRole('heading',{name:'Help improve BigBrain',exact:true}).waitFor();assert.equal(step,'analytics');
 await page.getByRole('button',{name:'No thanks',exact:true}).click();await page.waitForURL(url=>url.searchParams.get('vaults')==='fixture-team'&&url.searchParams.has('vaultMenu')&&url.hash==='#/home');
 await page.waitForFunction(()=>!document.querySelector('[aria-label="Set up BigBrain"]'));assert.equal(step,'complete');assert.deepEqual(choices,[false]);
 // An existing configured vault has no progress marker and goes straight to its app.
 step=undefined;await page.reload();await page.waitForFunction(()=>!!document.querySelector('#main'));assert.equal(await page.getByRole('dialog',{name:'Set up BigBrain'}).count(),0);assert.equal(account.liveAccess,false);
 assert.deepEqual(errors,[]);console.log('Production wizard: explicit navigation, providers, client configuration, library defaults/save, reload, failure recovery, and existing-vault bypass passed');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
