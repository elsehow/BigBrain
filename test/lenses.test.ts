/** Lenses (lib/lenses.ts, lib/stages/inclusion.ts, lib/views/lens.ts,
 * lib/lensSync.ts, lib/lensMigrate.ts): a lens lives in the vault, its
 * members are a view over inclusion verdicts, the D3 review when a change
 * nobody made grows a shared lens, the move from server rules and from this
 * computer's settings, and keeping a real shared door on a loopback port in
 * step. Every name and note is invented. */
import {describe,expect,test} from 'bun:test';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readRecordedAssertions,type InclusionAssertion} from '../lib/assertionLog';
import {projectSourceInsertion} from '../lib/assertionProjection';
import {appendSourceInsertionEvent,sourceInsertion} from '../lib/insertionLog';
import {sourceDigest,writeInclusionPolicy,sharedRuleScope,inclusionPath} from '../lib/inclusionPolicy';
import {addMember,initMemberStore,mintCredential} from '../lib/sharedMembers';
import {SharedVault} from '../lib/sharedVault';
import {makeSharedApiHandler} from '../lib/sharedVaultApi';
import {readConnections,saveConnection,type SharedConnection} from '../lib/sharedConnections';
import {contributions,getRule,sendSources} from '../lib/sharedRules';
import {fitThreshold,legacyLensDir,listLenses,lensError,newLens,previewThreshold,readLens,ruled,setSharingMode,updateLens,writeLens,type Lens} from '../lib/lenses';
import {readLensState,sayOnLens} from '../lib/lensRecord';
import {lensNotes,noteSummary,scorePass,READ_LIMIT,SUMMARY_READ_LIMIT} from '../lib/stages/inclusion';
import {feedLensEvents,lensEventHeadline,migrateRules,originOf,passLens,readLensEvents,syncServer,tickLenses,type SharedLens} from '../lib/lensSync';
import {legacyLenses,migrateLenses,planLensMigration} from '../lib/lensMigrate';
import {publishedPath,tickPublishing} from '../lib/sharedAssertionPublish';
import {EVALUATOR_VERSION,type inclusionEvaluator} from '../lib/inclusionEvaluation';

/** Scores are the last word of a note's body; `model` stands in for the evaluator's model. */
const scorer=(model='jev-a'):typeof inclusionEvaluator=>(_root,_store,text,labels=[])=>({identity:JSON.stringify([model,text,labels.length]),model,
 peek:()=>undefined,score:async(source:{body:string})=>Number(source.body.split(' ').at(-1))});
/** Counts what it is asked. */
const counting=(model='jev-a')=>{const asked:string[]=[];const f:typeof inclusionEvaluator=(...args)=>{const e=scorer(model)(...args);return {...e,score:async(s:{title:string;body:string})=>{asked.push(s.title);return e.score(s);}};};return {f,asked};};

let arrived=0;
function vault(){
 const dir=mkdtempSync(join(tmpdir(),'bb-lenses-')),root=join(dir,'personal'),store=join(dir,'connections.json');
 mkdirSync(root);writeFileSync(join(root,'vault.yaml'),'integrations: {}\n');
 const note=(id:string,title:string,score:number,body=`Example note about ${title}.`)=>{
  const received=new Date(Date.UTC(2026,8,29)+ ++arrived*1000).toISOString();
  const s=sourceInsertion({id,title,from:'Example',from_kind:'person',source:'web',date:'2026-09-29',received},`${body} ${score}`);
  appendSourceInsertionEvent(root,s,{wake:false});projectSourceInsertion(root,s);return s;
 };
 return {dir,root,store,note};
}
const idOf=(root:string,title:string)=>lensNotes(root).find(n=>n.title===title)!.source_id;
const members=(root:string,lens:Lens)=>{const m=readLensState(root,lens).members;return {in:[...m.in].sort(),out:[...m.out].sort(),pending:[...m.pending].sort()};};
const inclusions=(root:string)=>readRecordedAssertions(root).filter((e):e is InclusionAssertion=>e.kind==='inclusion');

describe('a lens and its verdicts',()=>{
 test('the owner beats the rule: an exclusion, then a pin, then a rating, then the score; a note nothing decides is pending',async()=>{
  const v=vault();
  const [a,b,c,d,e]=[v.note('ex-a','A',.9),v.note('ex-b','B',.1),v.note('ex-c','C',.9),v.note('ex-d','D',.7),v.note('ex-e','E',.5)];
  const lens=newLens({name:'Example',text:'Example rule'});writeLens(v.root,lens);
  await passLens(v.root,v.store,lens,lensNotes(v.root).filter(n=>n.source_id!=='ex-e'),{factory:scorer()});
  sayOnLens(v.root,lens,{pins:['ex-a','ex-b'],exclusions:['ex-a'],ratings:[{insertion_id:c.id,include:false}]});
  expect(members(v.root,lens)).toEqual({in:['ex-b','ex-d'],out:['ex-a','ex-c'],pending:['ex-e']});
  // taking a word back retracts it alone
  sayOnLens(v.root,lens,{pins:['ex-b'],exclusions:[],ratings:[{insertion_id:c.id,include:false}]});
  expect(members(v.root,lens).in).toEqual(['ex-a','ex-b','ex-d']);
  void [a,b,d,e];
 });
 test('a pass is one assertion of the notes it scored; a settled note is not asked again; new text is',async()=>{
  const v=vault();v.note('ex-1','Seed swap',.9);v.note('ex-2','Compost',.2);
  const lens=newLens({name:'Mine',text:'Garden things'});writeLens(v.root,lens);
  const one=counting();
  await passLens(v.root,v.store,lens,lensNotes(v.root),{factory:one.f});
  expect(one.asked.sort()).toEqual(['Compost','Seed swap']);
  expect(inclusions(v.root).map(i=>[i.lens,i.verdicts.length,i.author.kind])).toEqual([[lens.id,2,'model']]);
  const two=counting(),fresh=()=>readLens(v.root,lens.id)!;
  await passLens(v.root,v.store,fresh(),lensNotes(v.root),{factory:two.f});
  expect(two.asked).toEqual([]);expect(inclusions(v.root)).toHaveLength(1);
  v.note('ex-2','Compost',.8);
  await passLens(v.root,v.store,fresh(),lensNotes(v.root),{factory:two.f});
  expect(two.asked).toEqual(['Compost']);
  expect(members(v.root,lens).in).toEqual(['ex-1','ex-2']);
 });
 test('a new rule leaves every note pending until it is scored under it, never in by what it held before',async()=>{
  const v=vault();v.note('ex-1','Seed swap',.9);v.note('ex-2','Compost',.9);
  const lens=newLens({name:'Mine',text:'Garden things'});writeLens(v.root,lens);
  await passLens(v.root,v.store,lens,lensNotes(v.root),{factory:scorer()});
  const changed=updateLens(v.root,lens.id,l=>{l.text='Garden and kitchen things';});
  // a pass that scores only one note under the new rule
  await passLens(v.root,v.store,changed,lensNotes(v.root).filter(n=>n.title==='Seed swap'),{factory:scorer()});
  expect(members(v.root,changed)).toEqual({in:['ex-1'],out:[],pending:['ex-2']});
 });
 test('a failing pass says why, and what it could score still lands',async()=>{
  const v=vault();v.note('ex-1','Seed swap',.9);v.note('ex-2','Fails',.5);
  const lens=newLens({name:'Mine',text:'Garden things'});writeLens(v.root,lens);
  const failing:typeof inclusionEvaluator=(...args)=>{const e=scorer()(...args);return {...e,score:async(s:{title:string;body:string})=>{if(s.title==='Fails')throw Error('provider refused');return e.score(s);}};};
  await passLens(v.root,v.store,lens,lensNotes(v.root),{factory:failing});
  expect(lensError(v.root,lens.id)).toContain('provider refused');
  expect(members(v.root,lens)).toEqual({in:['ex-1'],out:[],pending:['ex-2']});
 });
 test('a lens lives in the vault: its file holds no members, and is committed',async()=>{
  const v=vault();
  const lens=newLens({name:'Mine',text:'Garden things'});writeLens(v.root,lens);
  expect(listLenses(v.root).map(l=>l.id)).toEqual([lens.id]);
  expect(Object.keys(JSON.parse(readFileSync(join(v.root,'lenses',lens.id+'.json'),'utf8'))).sort()).toEqual(['calibration','created','id','name','servers','text','updated','version']);
 });
});

describe('previews',()=>{
 test("the rule's own answer: a rating, else the score; a note with neither is in neither",()=>{
  const r=ruled(new Map([['c',false]]),.6,[{source_id:'a'},{source_id:'b'},{source_id:'c'},{source_id:'d'}],new Map([['a',.9],['b',.1],['c',.9]]));
  expect([[...r.in],[...r.out]]).toEqual([['a'],['b','c']]);
 });
 test("a preview of an unchanged lens draws at the lens's own cut-off; a changed rule or new ratings refit",()=>{
  const label={source:{id:'a',title:'a',body:'a',origin:''},include:true};
  const lens={text:'Garden things',labels:[label],calibration:{identity:'x',model:'m',threshold:.8}};
  expect(previewThreshold(lens,'Garden things',[label],()=>.6)).toBe(.8);
  expect(previewThreshold(lens,'Garden and kitchen things',[label],()=>.6)).toBe(.6);
  expect(previewThreshold(lens,'Garden things',[label,{...label,include:false}],()=>.6)).toBe(.6);
  expect(previewThreshold(undefined,'Garden things',[],()=>.6)).toBe(.6);
 });
 test('the cut-off fits the ratings, and falls back to 0.6',()=>{
  expect(fitThreshold([])).toBe(.6);
  expect(fitThreshold([{include:true,score:.62},{include:true,score:.71},{include:false,score:.4}])).toBe(.6);
  expect(fitThreshold([{include:true,score:.9},{include:false,score:.75},{include:false,score:.7}])).toBe(.8);
 });
});

describe('scorePass',()=>{
 test('a summary reads at most SUMMARY_READ_LIMIT of a note, and says the rest is not shown',async()=>{
  const v=vault();
  v.note('ex-huge','Huge',.1,'y'.repeat(SUMMARY_READ_LIMIT+5000));
  const note=lensNotes(v.root).find(n=>n.title==='Huge')!;
  let prompt='';
  const text=await noteSummary(v.root,v.store,note,async(req)=>{prompt=String(req.prompt);return {text:'A summary of the huge note.'} as never;});
  expect(text).toBe('A summary of the huge note.');
  const sent=JSON.parse(prompt).source;
  expect(sent.body.length).toBe(SUMMARY_READ_LIMIT);
  expect(sent.omitted).toBe('the last 5004 characters, not shown'); // the fixture appends ' 0.1'
 });
 test('scores every note, reads a summary for one too big to read, and keeps going past a failure',async()=>{
  const v=vault();
  v.note('ex-small','Small',.9);v.note('ex-big','Big',.1,'x'.repeat(READ_LIMIT+10));
  const failing=v.note('ex-fail','Fails',.5);
  const factory:typeof inclusionEvaluator=(...args)=>{const e=scorer()(...args);return {...e,score:async(s:{title:string;body:string})=>{if(s.title==='Fails')throw Error('provider refused');return e.score(s);}};};
  const pass=await scorePass(v.root,v.store,{text:'Example rule',labels:[]},lensNotes(v.root),{factory,summarize:async()=>'A summary of the big note. 0.8'});
  expect(pass.scores.get(idOf(v.root,'Small'))).toBe(.9);
  expect(pass.scores.get(idOf(v.root,'Big'))).toBe(.8);expect(pass.summarized.has(idOf(v.root,'Big'))).toBe(true);
  expect(pass.failed.get(failing.source_id)).toContain('provider refused');
 });
 test('a run of failures stops the pass, and the tick leaves that rule be; a preview tries again',async()=>{
  const v=vault();for(let i=0;i<30;i++)v.note('ex-'+i,'Note '+i,.9);
  let calls=0;const broken:typeof inclusionEvaluator=(...args)=>({...scorer('jev-broken')(...args),score:async()=>{calls++;throw Error('invalid key');}});
  const first=await scorePass(v.root,v.store,{text:'Broken rule',labels:[]},lensNotes(v.root),{factory:broken});
  expect(calls).toBeLessThan(20);expect(first.scores.size).toBe(0);
  const before=calls,second=await scorePass(v.root,v.store,{text:'Broken rule',labels:[]},lensNotes(v.root),{factory:broken});
  expect(calls).toBe(before);expect(second.failed.get(idOf(v.root,'Note 3'))).toContain('invalid key');
  await scorePass(v.root,v.store,{text:'Broken rule',labels:[]},lensNotes(v.root),{factory:broken,fresh:true});
  expect(calls).toBeGreaterThan(before);
 });
});

describe('the D3 review',()=>{
 /** A lens shared with a server it has already put Seed swap on. */
 async function shared(mode:'conservative'|'yeehaw'='conservative'){
  const v=vault();setSharingMode(v.store,mode);
  writeFileSync(v.store,JSON.stringify([{id:'srv',name:'Garden club',endpoint:'https://garden.example.org',token:'t'}]));
  v.note('ex-1','Seed swap',.9);v.note('ex-2','Compost',.2);
  const lens=newLens({name:'Garden',text:'Garden things',servers:['srv']});writeLens(v.root,lens);
  const after=(await passLens(v.root,v.store,lens,lensNotes(v.root),{factory:scorer()}))!;
  writeFileSync(join(v.dir,'lens-shares.json'),JSON.stringify({srv:[originOf('ex-1')]}));
  return {...v,lens:after};
 }
 test('a first pass on a shared lens takes the rule it ran as the one its owner saw',async()=>{
  const v=await shared();
  expect(v.lens.calibration.identity).not.toBe('');expect(v.lens.review).toBeUndefined();
 });
 test('Conservative: a model upgrade that would share more holds every addition until reviewed',async()=>{
  const v=await shared('conservative');
  v.note('ex-4','Frost dates',.7);
  const upgraded:typeof inclusionEvaluator=(...args)=>{const e=scorer('jev-b')(...args);return {...e,score:async(s:{title:string;body:string})=>s.title==='Compost'?.95:s.title==='Seed swap'?.1:e.score(s)};};
  const after=(await passLens(v.root,v.store,readLens(v.root,v.lens.id)!,lensNotes(v.root),{factory:upgraded}))!;
  expect(after.review).toMatchObject({reason:'model',hold:true});
  expect(readLensEvents(v.root,v.store).at(-1)).toMatchObject({kind:'paused',reason:'model',servers:['Garden club']});
  // the feed keeps the pause only until it is reviewed
  const kinds=()=>feedLensEvents(v.root,v.store).map(r=>r.event.kind);
  expect(kinds()).toContain('paused');
  updateLens(v.root,v.lens.id,l=>{l.review=undefined;});
  expect(kinds()).not.toContain('paused');
 });
 test('Yee-haw: the review stays as a warning and holds nothing',async()=>{
  const v=await shared('yeehaw');
  const upgraded:typeof inclusionEvaluator=(...args)=>{const e=scorer('jev-b')(...args);return {...e,score:async(s:{title:string;body:string})=>s.title==='Compost'?.95:e.score(s)};};
  const after=(await passLens(v.root,v.store,readLens(v.root,v.lens.id)!,lensNotes(v.root),{factory:upgraded}))!;
  expect(after.review).toMatchObject({reason:'model',hold:false});
  expect(readLensEvents(v.root,v.store).at(-1)).toMatchObject({kind:'expanded'});
 });
 test('an update that changes what the evaluator reads holds its additions, and says it was an update',async()=>{
  const v=await shared('yeehaw');
  updateLens(v.root,v.lens.id,l=>{delete l.calibration.version;});
  const reread:typeof inclusionEvaluator=(...args)=>{const e=scorer()(...args);return {...e,identity:e.identity+' claims',score:async(s:{title:string;body:string})=>s.title==='Compost'?.95:e.score(s)};};
  const after=(await passLens(v.root,v.store,readLens(v.root,v.lens.id)!,lensNotes(v.root),{factory:reread}))!;
  expect(after.review).toMatchObject({reason:'update',hold:true});
  expect(after.calibration.version).toBeUndefined();
  expect(lensEventHeadline(readLensEvents(v.root,v.store).at(-1)!)).toBe('A BigBrain update would cause you to share new items with Garden club. Lens is paused until you review.');
 });
 test('a change that shares nothing new just becomes what the owner saw',async()=>{
  const v=await shared('conservative');
  const quieter:typeof inclusionEvaluator=(...args)=>scorer('jev-b')(...args);
  const after=(await passLens(v.root,v.store,readLens(v.root,v.lens.id)!,lensNotes(v.root),{factory:quieter}))!;
  expect(after.review).toBeUndefined();expect(after.calibration.model).toBe('jev-b');
 });
 test('a lens edited during its pass is left for the next tick',async()=>{
  const v=vault();v.note('ex-1','Seed swap',.9);
  const lens=newLens({name:'Mine',text:'Garden things'});writeLens(v.root,lens);
  writeLens(v.root,{...lens,version:'edited'});
  expect(await passLens(v.root,v.store,lens,lensNotes(v.root),{factory:scorer()})).toBeUndefined();
  expect(inclusions(v.root)).toEqual([]);
 });
});

function door(){
 const v=vault(),shared=join(v.dir,'shared'),members=join(v.dir,'members.json');mkdirSync(shared);
 initMemberStore(members,shared,{handle:'owner'});addMember(members,{handle:'ines',display:'Ines Example',permissions:['read','write']});
 const ines=mintCredential(members,'ines',{name:'laptop'}),vaultDoor=new SharedVault(shared);
 const handler=makeSharedApiHandler({root:shared,storePath:members,vault:vaultDoor,log:()=>{}});
 const asked:string[]=[],server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:req=>{asked.push(`${req.method} ${new URL(req.url).pathname}`);return handler(req);}});
 const endpoint=`http://127.0.0.1:${server.port}`;
 const connect=async():Promise<SharedConnection>=>{const saved=await saveConnection(v.store,{name:'Garden club',endpoint,token:ines.token});return readConnections(v.store).find(x=>x.id===saved.id)!;};
 return {...v,server,endpoint,token:ines.token,connect,asked};
}

describe('the move from server rules',()=>{
 test("a server's rule becomes a lens in the vault shared with it; what is on the server stays, and nothing old joins without review",async()=>{
  const d=door();try{
   const c=await d.connect();
   const kept=d.note('ex-1','Seed swap',.9),gone=d.note('ex-2','Old plot',.9);d.note('ex-3','Never added',.9);
   await sendSources(d.store,c,[kept,gone]);
   const withdrawn=(await contributions(c)).find(x=>x.title==='Old plot')!;
   await fetch(`${d.endpoint}/v1/contributions/${withdrawn.id}/withdraw`,{method:'POST',headers:{Authorization:`Bearer ${d.token}`,'Content-Type':'application/json'},body:JSON.stringify({request_id:'example-request',version:withdrawn.version})});
   writeFileSync(d.store+'.rules.json',JSON.stringify({[c.id]:{root:d.root,text:'Garden things'}}));
   writeInclusionPolicy(d.root,d.store,{version:'v',scope:sharedRuleScope(c.id),text:'Garden things',labels:[],calibration:{identity:'old',threshold:.8},updated:''});
   await migrateRules(d.root,d.store);
   const [lens]=listLenses(d.root) as [Lens];
   expect(lens).toMatchObject({name:c.name,text:'Garden things',servers:[c.id],review:{reason:'update',hold:true,at:''}});
   expect(lens.calibration.threshold).toBe(.8);
   expect(readLensState(d.root,lens).hands).toMatchObject({pins:[kept.source_id],exclusions:[gone.source_id]});
   expect(getRule(d.store,c.id)).toBeNull();expect(existsSync(inclusionPath(d.root,d.store,sharedRuleScope(c.id)))).toBe(false);
   const after=(await passLens(d.root,d.store,lens,lensNotes(d.root),{factory:scorer()}))!;
   expect(members(d.root,after).in).toEqual([kept.source_id,idOf(d.root,'Never added')].sort());
   expect(after.review).toMatchObject({reason:'update',hold:true});expect(after.review!.at).not.toBe('');
  }finally{d.server.stop(true);}
 });
});

describe('syncServer',()=>{
 test('contributes and restores what lenses hold, withdraws only what lenses put there and now say is out, and leaves the pending',async()=>{
  const d=door();try{
   const c=await d.connect();
   d.note('ex-a','Seed swap',.9);d.note('ex-b','Compost',.9);const hand=d.note('ex-h','Shared by hand',.9);
   await sendSources(d.store,c,[hand]); // put there some other way: never a lens's to withdraw
   const lens=newLens({name:'Garden',text:'Garden things',servers:[c.id]});writeLens(d.root,lens);
   await passLens(d.root,d.store,lens,lensNotes(d.root).filter(n=>n.source_id!=='ex-h'),{factory:scorer()});
   const sync=(l=lens)=>syncServer(d.root,d.store,c,[{lens:l,state:readLensState(d.root,l)}] as SharedLens[],lensNotes(d.root));
   await sync();
   const active=async()=>(await contributions(c)).filter(x=>x.status==='active').map(x=>x.title).sort();
   expect(await active()).toEqual(['Compost','Seed swap','Shared by hand']);
   expect(readLensEvents(d.root,d.store).map(e=>[e.kind,e.title]).sort()).toEqual([['shared','Compost'],['shared','Seed swap']]);
   // Compost now scores out under a new rule; Seed swap is not yet scored under it: pending, and left where it is
   const changed=updateLens(d.root,lens.id,l=>{l.text='Only seeds';});
   const seedsOnly:typeof inclusionEvaluator=(...args)=>{const e=scorer()(...args);return {...e,score:async(s:{title:string;body:string})=>s.title==='Compost'?.1:e.score(s)};};
   await passLens(d.root,d.store,changed,lensNotes(d.root).filter(n=>n.title==='Compost'),{factory:seedsOnly});
   await sync(changed);
   expect(await active()).toEqual(['Seed swap','Shared by hand']);
   await sync({...changed,servers:[]}); // no longer shared there: what it put there goes
   expect(await active()).toEqual(['Shared by hand']);
  }finally{d.server.stop(true);}
 });
});

describe('a server and its vault',()=>{
 test('only the vault that shares with a server syncs or publishes to it: opening a copy withdraws and retracts nothing',async()=>{
  const d=door();try{
   const c=await d.connect(),seed=d.note('ex-a','Seed swap',.9);
   writeLens(d.root,newLens({name:'Garden',text:'Include everything',servers:[c.id]}));
   await tickLenses(d.root,d.store);
   expect(readConnections(d.store)[0]!.root).toBe(d.root);
   const active=async()=>(await contributions(c)).filter(x=>x.status==='active').map(x=>x.title);
   expect(await active()).toEqual(['Seed swap']);
   const claim={connection:c.id,personal_assertion_id:'ast_00000000000000000001',shared_assertion_id:'ast_00000000000000000002',status:'published',at:'2026-10-01T00:00:00.000Z'};
   writeFileSync(publishedPath(d.store),JSON.stringify({[`${c.id}:${claim.personal_assertion_id}`]:claim}));
   // A copy of the vault (a scratch one made from it): same notes, none of its lenses.
   const other=join(d.dir,'scratch');mkdirSync(other);writeFileSync(join(other,'vault.yaml'),'integrations: {}\n');appendSourceInsertionEvent(other,seed,{wake:false});
   const before=d.asked.length;
   await tickLenses(other,d.store);await tickPublishing(other,d.store);
   expect(d.asked.slice(before).filter(r=>r.startsWith('POST'))).toEqual([]);
   expect(await active()).toEqual(['Seed swap']);
   expect(JSON.parse(readFileSync(publishedPath(d.store),'utf8'))[`${c.id}:${claim.personal_assertion_id}`].status).toBe('published');
   expect(readConnections(d.store)[0]!.root).toBe(d.root);
  }finally{d.server.stop(true);}
 });
});

describe('migration 5: lenses into the vault',()=>{
 /** A lens as it was kept beside the connection store. */
 function legacy(){
  const v=vault();
  const [a,b,c,d]=[v.note('ex-a','Seed swap',.9),v.note('ex-b','Compost',.2),v.note('ex-c','Frost dates',.9),v.note('ex-d','Rain',.9)];
  const old={id:'lens_00000000beef',name:'Garden',text:'Garden things',
   labels:[{source:{id:c.id,title:c.title,body:c.body,origin:''},include:false}],pins:['ex-b'],exclusions:['ex-d'],
   calibration:{identity:'old',model:'jev-a',threshold:.6,version:EVALUATOR_VERSION},servers:[],members:['ex-a','ex-b','ex-x'],summarized:[],
   version:'v1',created:'2026-09-01T00:00:00.000Z',updated:'2026-09-02T00:00:00.000Z'};
  mkdirSync(legacyLensDir(v.root,v.store),{recursive:true});
  writeFileSync(join(legacyLensDir(v.root,v.store),old.id+'.json'),JSON.stringify(old));
  return {...v,old,notes:{a,b,c,d}};
 }
 test('until it runs, the vault has no lenses and a tick touches nothing',async()=>{
  const v=legacy();
  expect(listLenses(v.root)).toEqual([]);expect(legacyLenses(v.root,v.store)).toHaveLength(1);
  await tickLenses(v.root,v.store);
  expect(inclusions(v.root)).toEqual([]);
 });
 test("each lens's file, ratings, pins and exclusions move in; members with no score paid for wait, and the plan says so first",()=>{
  const v=legacy();
  const [plan]=planLensMigration(v.root,v.store);
  expect(plan).toMatchObject({ratings:1,pins:1,exclusions:1,scored:0,kept:1,pending:1,out:[]});
  const result=migrateLenses(v.root,v.store);
  expect(result).toMatchObject({lenses:1,assertions:3});
  const lens=readLens(v.root,v.old.id)!;
  expect(lens).toMatchObject({name:'Garden',text:'Garden things',calibration:{identity:'old',threshold:.6}});
  expect(readLensState(v.root,lens).hands).toEqual({pins:['ex-b'],exclusions:['ex-d'],ratings:[{source_id:'ex-c',insertion_id:v.notes.c.id,include:false}]});
  expect(members(v.root,lens)).toEqual({in:['ex-b'],out:['ex-c','ex-d'],pending:['ex-a']});
  expect(inclusions(v.root).every(i=>i.created_at===v.old.updated&&i.produced_by.procedure==='lens-migrate')).toBe(true);
  expect(legacyLenses(v.root,v.store)).toEqual([]);
  expect(existsSync(join(v.root,'.state','lens-migration',v.old.id+'.json'))).toBe(true);
 });
 test('scores already paid for move in as one assertion, and no model is asked',()=>{
  const v=legacy();
  // the cache answers for Seed swap under the lens's rule as it stands
  const real=require('../lib/inclusionEvaluation') as typeof import('../lib/inclusionEvaluation');
  const ev=real.inclusionEvaluator(v.root,v.store,v.old.text,v.old.labels);
  const digest=sourceDigest(v.notes.a);
  const path=join(v.dir,'inclusion-scores');
  // write the cache file the evaluator would have written
  const {sha256hex}=require('../lib/hash') as typeof import('../lib/hash');
  writeFileSync(join(path,sha256hex(ev.identity+digest)+'.json'),JSON.stringify({score:.9}));
  const [plan]=planLensMigration(v.root,v.store);
  expect(plan).toMatchObject({scored:1,kept:2,pending:0});
  migrateLenses(v.root,v.store);
  const scores=inclusions(v.root).filter(i=>i.rule);
  expect(scores.map(i=>[i.rule,i.verdicts.map(x=>[x.source_id,x.score])])).toEqual([[ev.identity,[['ex-a',.9]]]]);
  expect(members(v.root,readLens(v.root,v.old.id)!).in).toEqual(['ex-a','ex-b']);
 });
});
