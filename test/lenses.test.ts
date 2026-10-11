/** Lenses (lib/lenses.ts, lib/lensScoring.ts, lib/lensSync.ts): exact membership,
 * the D3 review when a change nobody made grows a shared lens, the move from
 * server rules, and keeping a real shared door on a loopback port in step.
 * Every name and note is invented. */
import {describe,expect,setSystemTime,test} from 'bun:test';
import {mkdirSync,mkdtempSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {appendSourceInsertionEvent,sourceInsertion} from '../lib/insertionLog';
import {sourceDigest,writeInclusionPolicy,sharedRuleScope,inclusionPath} from '../lib/inclusionPolicy';
import {addMember,initMemberStore,mintCredential} from '../lib/sharedMembers';
import {SharedVault} from '../lib/sharedVault';
import {makeSharedApiHandler} from '../lib/sharedVaultApi';
import {readConnections,saveConnection,type SharedConnection} from '../lib/sharedConnections';
import {contributions,getRule,sendSources} from '../lib/sharedRules';
import {fitThreshold,listLenses,previewThreshold,membership,newLens,readLens,setSharingMode,updateLens,writeLens,type Lens} from '../lib/lenses';
import {lensNotes,scorePass,READ_LIMIT} from '../lib/lensScoring';
import {feedLensEvents,lensEventHeadline,lensEventsPath,migrateRules,originOf,passLens,readLensEvents,syncServer,tickLenses} from '../lib/lensSync';
import {publishedPath,tickPublishing} from '../lib/sharedAssertionPublish';
import type {inclusionEvaluator} from '../lib/inclusionEvaluation';

/** Scores are the last word of a note's body; `model` stands in for the evaluator's model. */
const scorer=(model='jev-a'):typeof inclusionEvaluator=>(_root,_store,text,labels=[])=>({identity:JSON.stringify([model,text,labels.length]),model,score:async(source:{body:string})=>Number(source.body.split(' ').at(-1))});

function vault(){
 const dir=mkdtempSync(join(tmpdir(),'bb-lenses-')),root=join(dir,'personal'),store=join(dir,'connections.json');
 mkdirSync(root);writeFileSync(join(root,'vault.yaml'),'integrations: {}\n');
 const note=(id:string,title:string,score:number,body=`Example note about ${title}.`)=>{const s=sourceInsertion({id,title,from:'Example',from_kind:'person',source:'web',date:'2026-09-29'},`${body} ${score}`);appendSourceInsertionEvent(root,s);return s;};
 return {dir,root,store,note};
}
const idOf=(root:string,title:string)=>lensNotes(root).find(n=>n.title===title)!.source_id;

describe('membership',()=>{
 test('a removal beats an addition, which beats a rating, which beats the score; an unscored note keeps its place',()=>{
  const notes=['a','b','c','d','e','f'].map(id=>({source_id:id,digest:'d-'+id,title:id,body:id}));
  const lens=newLens({name:'Example',text:'Example rule',pins:['a','b'],exclusions:['a'],members:['f'],
   labels:[{source:{id:'c',title:'c',body:'c',origin:''},include:false}],calibration:{identity:'x',model:'m',threshold:.6}});
  // labels match by digest; give c's label the digest its note carries
  notes[2]!.digest=sourceDigest({title:'c',body:'c'});
  const scores=new Map([['a',.9],['b',.1],['c',.9],['d',.7],['e',.5]]);
  expect([...membership(lens,notes,scores)].sort()).toEqual(['b','d','f']);
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
});

describe('scorePass, when the provider fails',()=>{
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

describe('passLens',()=>{
 async function shared(mode:'conservative'|'yeehaw'='conservative'){
  const v=vault();setSharingMode(v.store,mode);
  writeFileSync(v.store,JSON.stringify([{id:'srv',name:'Garden club',endpoint:'https://garden.example.org',token:'t'}]));
  v.note('ex-1','Seed swap',.9);v.note('ex-2','Compost',.2);
  const first=newLens({name:'Garden',text:'Garden things',servers:['srv']});writeLens(v.root,v.store,first);
  const lens=(await passLens(v.root,v.store,first,lensNotes(v.root),{factory:scorer()}))!;
  return {...v,lens};
 }
 test('a new match joins a shared lens with a feed event; one that stops matching leaves',async()=>{
  const v=await shared();
  expect(v.lens.members).toEqual([idOf(v.root,'Seed swap')]);
  v.note('ex-3','Plot plan',.8);v.note('ex-1','Seed swap',.1);
  const after=(await passLens(v.root,v.store,readLens(v.root,v.store,v.lens.id)!,lensNotes(v.root),{factory:scorer()}))!;
  expect(after.members).toEqual([idOf(v.root,'Plot plan')]);
  expect(readLensEvents(v.root,v.store).map(e=>[e.kind,e.title,e.servers])).toContainEqual(['shared','Plot plan',['Garden club']]);
 });
 test('what one pass shares from a lens is one feed row',async()=>{
  const v=await shared();
  v.note('ex-3','Plot plan',.8);v.note('ex-4','Rain barrels',.85);
  // a pass is a tick apart from the last, not the same millisecond
  setSystemTime(Date.now()+60_000);
  try{await passLens(v.root,v.store,readLens(v.root,v.store,v.lens.id)!,lensNotes(v.root),{factory:scorer()});}finally{setSystemTime();}
  expect(feedLensEvents(v.root,v.store).map(r=>lensEventHeadline(r.event,r.count))).toEqual(['Seed swap is shared with Garden club','2 items are shared with Garden club']);
  // each row carries the notes it brought, so the feed can select them
  expect(feedLensEvents(v.root,v.store).map(r=>r.sources.sort())).toEqual([[idOf(v.root,'Seed swap')],[idOf(v.root,'Plot plan'),idOf(v.root,'Rain barrels')].sort()]);
 });
 test('a shared event from before events named their note finds it by title',async()=>{
  const v=await shared();
  const path=lensEventsPath(v.root,v.store),[e]=readLensEvents(v.root,v.store);
  writeFileSync(path,JSON.stringify({...e,source:undefined})+'\n');
  expect(feedLensEvents(v.root,v.store).map(r=>r.sources)).toEqual([[idOf(v.root,'Seed swap')]]);
 });
 test('Conservative: a model upgrade that adds notes holds every addition until reviewed, and still drops leavers',async()=>{
  const v=await shared('conservative');
  v.note('ex-4','Frost dates',.7);
  // the new model scores Compost up and Seed swap down; a brand-new note arrives too
  const upgraded:typeof inclusionEvaluator=(...args)=>{const e=scorer('jev-b')(...args);return {...e,score:async(s:{title:string;body:string})=>s.title==='Compost'?.95:s.title==='Seed swap'?.1:e.score(s)};};
  const after=(await passLens(v.root,v.store,readLens(v.root,v.store,v.lens.id)!,lensNotes(v.root),{factory:upgraded}))!;
  expect(after.members).toEqual([]);
  expect(after.review).toMatchObject({reason:'model',hold:true});
  expect(after.review!.joins.sort()).toEqual([idOf(v.root,'Compost'),idOf(v.root,'Frost dates')].sort());
  expect(readLensEvents(v.root,v.store).at(-1)).toMatchObject({kind:'paused',reason:'model',servers:['Garden club']});
  // later arrivals wait too
  v.note('ex-5','Water barrels',.9);
  const later=(await passLens(v.root,v.store,after,lensNotes(v.root),{factory:upgraded}))!;
  expect(later.members).toEqual([]);expect(later.review!.joins).toContain(idOf(v.root,'Water barrels'));
  // the feed keeps the pause only until it is reviewed
  const kinds=()=>feedLensEvents(v.root,v.store).map(r=>r.event.kind);
  expect(kinds()).toContain('paused');
  updateLens(v.root,v.store,v.lens.id,l=>{l.review=undefined;});
  expect(kinds()).not.toContain('paused');
 });
 test('Yee-haw: the notes join and the review stays as a warning',async()=>{
  const v=await shared('yeehaw');
  const upgraded:typeof inclusionEvaluator=(...args)=>{const e=scorer('jev-b')(...args);return {...e,score:async(s:{title:string;body:string})=>s.title==='Compost'?.95:e.score(s)};};
  const after=(await passLens(v.root,v.store,readLens(v.root,v.store,v.lens.id)!,lensNotes(v.root),{factory:upgraded}))!;
  expect(after.members.sort()).toEqual([idOf(v.root,'Compost'),idOf(v.root,'Seed swap')].sort());
  expect(after.review).toMatchObject({reason:'model',hold:false});
  expect(readLensEvents(v.root,v.store).at(-1)).toMatchObject({kind:'expanded'});
 });
 test('a private lens just follows its rule',async()=>{
  const v=vault();v.note('ex-1','Seed swap',.9);
  const lens=newLens({name:'Mine',text:'Garden things'});writeLens(v.root,v.store,lens);
  const after=(await passLens(v.root,v.store,lens,lensNotes(v.root),{factory:scorer('jev-b')}))!;
  expect(after.members).toHaveLength(1);expect(after.review).toBeUndefined();
 });
 test('a lens edited during its pass is left for the next tick',async()=>{
  const v=vault();v.note('ex-1','Seed swap',.9);
  const lens=newLens({name:'Mine',text:'Garden things'});writeLens(v.root,v.store,lens);
  writeLens(v.root,v.store,{...lens,version:'edited'});
  expect(await passLens(v.root,v.store,lens,lensNotes(v.root),{factory:scorer()})).toBeUndefined();
  expect(readLens(v.root,v.store,lens.id)!.members).toEqual([]);
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
 test("a server's rule becomes a lens shared with it; what is on the server stays, and nothing old joins without review",async()=>{
  const d=door();try{
   const c=await d.connect();
   const kept=d.note('ex-1','Seed swap',.9),gone=d.note('ex-2','Old plot',.9);d.note('ex-3','Never added',.9);
   await sendSources(d.store,c,[kept,gone]);
   const withdrawn=(await contributions(c)).find(x=>x.title==='Old plot')!;
   await fetch(`${d.endpoint}/v1/contributions/${withdrawn.id}/withdraw`,{method:'POST',headers:{Authorization:`Bearer ${d.token}`,'Content-Type':'application/json'},body:JSON.stringify({request_id:'example-request',version:withdrawn.version})});
   writeFileSync(d.store+'.rules.json',JSON.stringify({[c.id]:{root:d.root,text:'Garden things'}}));
   writeInclusionPolicy(d.root,d.store,{version:'v',scope:sharedRuleScope(c.id),text:'Garden things',labels:[],calibration:{identity:'old',threshold:.8},updated:''});
   await migrateRules(d.root,d.store);
   const [lens]=listLenses(d.root,d.store) as [Lens];
   expect(lens).toMatchObject({name:c.name,text:'Garden things',servers:[c.id],pins:[kept.source_id],exclusions:[gone.source_id],members:[kept.source_id]});
   expect(lens.calibration.threshold).toBe(.8);
   expect(getRule(d.store,c.id)).toBeNull();expect(existsSync(inclusionPath(d.root,d.store,sharedRuleScope(c.id)))).toBe(false);
   const after=(await passLens(d.root,d.store,lens,lensNotes(d.root),{factory:scorer()}))!;
   expect(after.members).toEqual([kept.source_id]);
   expect(after.review).toMatchObject({reason:'update',hold:true,joins:[idOf(d.root,'Never added')]});
  }finally{d.server.stop(true);}
 });
});

describe('syncServer',()=>{
 test('contributes and restores what lenses want, withdraws only what lenses put there',async()=>{
  const d=door();try{
   const c=await d.connect();
   const a=d.note('ex-a','Seed swap',.9),b=d.note('ex-b','Compost',.9),hand=d.note('ex-h','Shared by hand',.9);
   await sendSources(d.store,c,[hand]); // put there some other way: never a lens's to withdraw
   const lens=newLens({name:'Garden',text:'Garden things',servers:[c.id],members:[a.source_id,b.source_id]});writeLens(d.root,d.store,lens);
   await syncServer(d.store,c,[lens],lensNotes(d.root));
   const active=async()=>(await contributions(c)).filter(x=>x.status==='active').map(x=>x.title).sort();
   expect(await active()).toEqual(['Compost','Seed swap','Shared by hand']);
   const shares=JSON.parse(readFileSync(join(d.dir,'lens-shares.json'),'utf8'));expect(shares[c.id].sort()).toEqual([originOf(a.source_id),originOf(b.source_id)].sort());
   const smaller={...lens,members:[a.source_id]};
   await syncServer(d.store,c,[smaller],lensNotes(d.root));
   expect(await active()).toEqual(['Seed swap','Shared by hand']);
   await syncServer(d.store,c,[lens],lensNotes(d.root));
   expect(await active()).toEqual(['Compost','Seed swap','Shared by hand']);
   await syncServer(d.store,c,[{...lens,servers:[]}],lensNotes(d.root));
   expect(await active()).toEqual(['Shared by hand']);
  }finally{d.server.stop(true);}
 });
});

describe('a server and its vault',()=>{
 test('only the vault that shares with a server syncs or publishes to it: opening a copy withdraws and retracts nothing',async()=>{
  const d=door();try{
   const c=await d.connect(),seed=d.note('ex-a','Seed swap',.9);
   writeLens(d.root,d.store,newLens({name:'Garden',text:'Include everything',servers:[c.id]}));
   await tickLenses(d.root,d.store);
   expect(readConnections(d.store)[0]!.root).toBe(d.root);
   const active=async()=>(await contributions(c)).filter(x=>x.status==='active').map(x=>x.title);
   expect(await active()).toEqual(['Seed swap']);
   const claim={connection:c.id,personal_assertion_id:'ast_00000000000000000001',shared_assertion_id:'ast_00000000000000000002',status:'published',at:'2026-10-01T00:00:00.000Z'};
   writeFileSync(publishedPath(d.store),JSON.stringify({[`${c.id}:${claim.personal_assertion_id}`]:claim}));
   // A copy of the vault (a scratch one made from it): same notes, none of its lenses.
   const other=join(d.dir,'scratch');mkdirSync(other);writeFileSync(join(other,'vault.yaml'),'integrations: {}\n');appendSourceInsertionEvent(other,seed);
   const before=d.asked.length;
   await tickLenses(other,d.store);await tickPublishing(other,d.store);
   expect(d.asked.slice(before).filter(r=>r.startsWith('POST'))).toEqual([]);
   expect(await active()).toEqual(['Seed swap']);
   expect(JSON.parse(readFileSync(publishedPath(d.store),'utf8'))[`${c.id}:${claim.personal_assertion_id}`].status).toBe('published');
   expect(readConnections(d.store)[0]!.root).toBe(d.root);
  }finally{d.server.stop(true);}
 });
});
