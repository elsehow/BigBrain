import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startReview,getReview,reviewState,rateReview,pickReview,searchReviewSources,editReview,finishReview} from '../lib/inclusionReview';
import {readInclusionPolicy,sharedRuleScope} from '../lib/inclusionPolicy';
import {inclusionEvaluator} from '../lib/inclusionEvaluation';
import {rankCandidates} from '../lib/inclusionCandidates';
import {saveJevKey} from '../lib/jevSettings';
import {OutOfCredits,outOfCredits} from '../lib/sharedJev';
function fixture(){const root=mkdtempSync(join(tmpdir(),'rule-review-')),store=join(root,'connections.json');writeFileSync(join(root,'vault.yaml'),'integrations: {}\n');saveJevKey(store,'fabricated-key');return {root,store,scope:sharedRuleScope('fixture'),text:'Sources about the Example project.',sources:[.95,.9,.85,.1,.2,.3,.65,.45].map((score,i)=>({id:String(i),title:'Example source '+i,origin:'Fixture',body:'Complete source '+score})),check:()=>{},save:(_text:string)=>{}};}
const factory:typeof inclusionEvaluator=(root,store,text,labels)=>({identity:inclusionEvaluator(root,store,text,labels).identity,score:async(source:{body:string})=>Number(source.body.split(' ').at(-1))});
async function idle(root:string,id:string){for(let i=0;i<100;i++){const s=getReview(root,id);if(!reviewState(s).busy)return s;await Bun.sleep(1);}throw Error('Review did not settle');}
test('real review persists judgments, hides scores, scopes policies and enforces provider/rule changes',async()=>{
 const c=fixture();try{
  const initial=startReview(c,factory);let s=await idle(c.root,initial.id);
  expect(reviewState(s).items).toHaveLength(3);expect(()=>finishReview(s)).toThrow();
  for(let i=0;i<4;i++){
   const row=reviewState(s).items[0]!;rateReview(s,row.id,i%2===0,s.revision);s=await idle(c.root,s.id);
  }
  expect(reviewState(s).ready).toBe(true);expect(JSON.stringify(reviewState(s))).not.toContain('threshold');expect(JSON.stringify(reviewState(s))).not.toContain('"score"');
  const count=reviewState(s).judged;editReview(s,c.text+' Exclude routine chatter.',s.revision,factory);s=await idle(c.root,s.id);expect(reviewState(s).judged).toBe(count);expect(reviewState(s).ready).toBe(true);
  let saved='';s.context.save=text=>{saved=text};finishReview(s);expect(saved).toContain('Exclude routine');
  const policy=readInclusionPolicy(c.root,c.store,c.scope)!;expect(policy.labels.length).toBe(count);expect(policy.calibration).toBeDefined();expect(readInclusionPolicy(c.root,c.store,sharedRuleScope('other'))).toBeUndefined();
 }finally{rmSync(c.root,{recursive:true,force:true});}
});
test('old asynchronous results cannot mark an edited rule ready; draft labels survive reopening',async()=>{
 const c=fixture();try{
  let release!:()=>void;const wait=new Promise<void>(r=>release=r);
  const initial=startReview(c,(root,store,text)=>({identity:inclusionEvaluator(root,store,text).identity,score:async()=>{await wait;return .99;}}));
  let s=getReview(c.root,initial.id);editReview(s,'New rule',s.revision,factory);release();s=await idle(c.root,s.id);
  expect(reviewState(s).text).toBe('New rule');expect(reviewState(s).ready).toBe(false);
  const card=reviewState(s).items[0]!;rateReview(s,card.id,true,s.revision);s=await idle(c.root,s.id);
  const reopened=startReview({...c,text:'New rule'},factory),newSession=await idle(c.root,reopened.id);expect(reviewState(newSession).judged).toBe(1);expect(()=>getReview(c.root,s.id)).toThrow('replaced');
 }finally{rmSync(c.root,{recursive:true,force:true});}
});

test('include everything needs neither ratings nor model calls',async()=>{
 const c=fixture();try{
  let calls=0;const initial=startReview({...c,text:'Include everything.'},(root,store,text,labels)=>({identity:inclusionEvaluator(root,store,text,labels).identity,score:async()=>{calls++;throw Error('Should not call model');}}));
  const s=await idle(c.root,initial.id);expect(reviewState(s).ready).toBe(true);expect(reviewState(s).items).toEqual([]);expect(reviewState(s).remaining).toBe(0);
  expect(finishReview(s).saved).toBe(true);expect(calls).toBe(0);
 }finally{rmSync(c.root,{recursive:true,force:true});}
});
test('candidates are ranked by fit to the rule before any paid scoring',()=>{
 const source=(id:string,title:string,body:string)=>({id,title,body,origin:'Fixture'});
 const rows=[source('a','Tide tables','Notes on harbor tides.'),source('b','Bakery visit','Croissant review.'),source('c','Note','Avery asked about the estate plan and our finances.'),source('d','Will and trust draft','Estate planning with counsel.'),source('e','Journal','A quiet morning.')];
 const ranked=rankCandidates(rows,'Include everything about me and [[projection/entities/a.md|Avery Example]]\'s finances, estate, and family planning.',[{title:'Avery Example',aliases:['Avery'],sourceIds:new Set(['e'])}]).map(r=>r.id);
 expect(ranked.slice(0,3).sort()).toEqual(['c','d','e']);expect(ranked.slice(3)).toEqual(['a','b']);
 expect(rankCandidates(rows,'Anything.').map(r=>r.id)).toEqual(['a','b','c','d','e']);
});
test('before any include, the likeliest matches are shown first',async()=>{
 const c=fixture();try{
  const s=await idle(c.root,startReview(c,factory).id);
  expect(reviewState(s).items.map(i=>i.body)).toEqual(['Complete source 0.95','Complete source 0.9','Complete source 0.85']);
 }finally{rmSync(c.root,{recursive:true,force:true});}
});
test('model-derived phrases rank a rule\'s real topic first, and an audience mention is not a topic',()=>{
 const source=(id:string,title:string,body:string)=>({id,title,body,origin:'Fixture'});
 const rows=[source('a','Dream','Avery was beside me in the dream.'),source('b','Benefits','Avery and I compared dental plans.'),source('c','Lawyer call','Drafting the estate plan; we named an executor and a guardian.'),source('d','Journal','A quiet morning.')];
 const avery={title:'Avery Example',aliases:['Avery'],sourceIds:new Set<string>()};
 const rule='Items to be shared with [[projection/entities/a.md|Avery Example]] - things about our will';
 // as before: "will" is dropped as rule grammar and the audience mention leads
 expect(rankCandidates(rows,rule,[avery]).slice(0,2).map(r=>r.id).sort()).toEqual(['a','b']);
 // with phrases and no subject entities, the estate note leads
 expect(rankCandidates(rows,rule,[],['will','estate plan','executor','guardian'])[0]!.id).toBe('c');
});
test('a review re-ranks its pool with the rule\'s queries before scoring, once per rule text',async()=>{
 const c=fixture();try{
  let calls=0;const target=c.sources[3]!;
  const queries=async(text:string)=>{calls++;return text.includes('Example')?{phrases:[target.body.toLowerCase()],subjects:[]}:undefined;};
  const scored:string[]=[];
  const s=await idle(c.root,startReview({...c,queries},(root,store,text,labels)=>({identity:inclusionEvaluator(root,store,text,labels).identity,score:async(source:{body:string})=>{scored.push(source.body);return .5;}})).id);
  expect(scored[0]).toBe(target.body);expect(calls).toBe(1);
  rateReview(s,reviewState(s).items[0]!.id,false,s.revision);await idle(c.root,s.id);expect(calls).toBe(1);
 }finally{rmSync(c.root,{recursive:true,force:true});}
});
test('rule queries come from one Quick call, are cached, and fall back on failure',async()=>{
 const {ruleQueries}=await import('../lib/inclusionQueries');
 const c=fixture();try{
  let calls=0;const avery={title:'Avery Example',aliases:[],sourceIds:new Set<string>()},estate={title:'Estate',aliases:[],sourceIds:new Set<string>()};
  const run=(async()=>{calls++;return {text:JSON.stringify({phrases:['Estate  Plan','executor','x'],subjects:['Estate']})};}) as never;
  const q=await ruleQueries(c.root,c.store,'shared with Avery: our estate',[avery,estate],run);
  expect(q).toEqual({phrases:['estate plan','executor'],subjects:[estate]});
  expect(await ruleQueries(c.root,c.store,'shared with Avery: our estate',[avery,estate],run)).toEqual(q);expect(calls).toBe(1);
  expect(await ruleQueries(c.root,c.store,'another rule',[],(async()=>{throw Error('offline');}) as never)).toBeUndefined();
 }finally{rmSync(c.root,{recursive:true,force:true});}
});
test('a long transcript that mentions the topic in passing does not outrank a note about it',()=>{
 const source=(id:string,title:string,body:string)=>({id,title,body,origin:'Fixture'});
 const filler=Array.from({length:400},(_,i)=>`line ${i} about tooling and builds`).join('\n');
 const rows=[source('t','Session log',`${filler}\nwe talked about the baby and childcare once\n${filler}`),source('n','Daycare','Childcare waitlist for the baby.'),source('x','Note','Unrelated short note.'),source('y','Note','Another short note.')];
 expect(rankCandidates(rows,'family concerns',[],['baby','childcare'])[0]!.id).toBe('n');
});

test('out of credits stops the review and says so, instead of blaming the sources',async()=>{
 const c=fixture();try{
  let calls=0;
  const broke:typeof inclusionEvaluator=(root,store,text,labels)=>({identity:inclusionEvaluator(root,store,text,labels).identity,score:async()=>{calls++;throw new OutOfCredits();}});
  const s=await idle(c.root,startReview(c,broke).id);
  expect(reviewState(s).error).toBe('Out of usage credits. (You need credits to calibrate your inclusion rule.)');
  expect(calls).toBeLessThanOrEqual(4); // one batch, not every candidate
 }finally{rmSync(c.root,{recursive:true,force:true});}
});
test('a provider error reads as out of credits only when it says so',()=>{
 expect(outOfCredits(402,'')).toBe(true);
 expect(outOfCredits(400,'Your credit balance is too low to access the API.')).toBe(true);
 expect(outOfCredits(429,'{"error":{"code":"insufficient_quota"}}')).toBe(true);
 expect(outOfCredits(500,'upstream timed out')).toBe(false);
 expect(outOfCredits(400,'The source thanks the film credits team.')).toBe(false);
});
test('once something is included, likely matches are still offered before uncertain ones',async()=>{
 const c=fixture();try{
  const sources=[.95,.9,.85,.82,.5,.45,.55].map((score,i)=>({id:String(i),title:'Example source '+i,origin:'Fixture',body:'Complete source '+score}));
  let s=await idle(c.root,startReview({...c,sources},factory).id);
  rateReview(s,reviewState(s).items.find(i=>i.body.endsWith('0.95'))!.id,true,s.revision);s=await idle(c.root,s.id);
  // the uncertain 0.5 would teach more, but a likely match not yet asked about comes first
  expect(reviewState(s).items.map(i=>i.body)).toEqual(['Complete source 0.9','Complete source 0.85','Complete source 0.82']);
 }finally{rmSync(c.root,{recursive:true,force:true});}
});
test('a note added by hand is included, shown with its thumbs up, teaches the rule, and can be undone',async()=>{
 const c=fixture();try{
  let s=await idle(c.root,startReview(c,factory).id);
  const missed=c.sources.find(x=>x.body.endsWith('0.1'))!;
  expect(searchReviewSources(s,'').map(n=>n.id)).toContain(missed.id);
  expect(searchReviewSources(s,'source 0.1').map(n=>n.id)).toEqual([missed.id]);
  expect(()=>pickReview(s,'no-such-note',s.revision)).toThrow('Choose a note');
  pickReview(s,missed.id,s.revision);s=await idle(c.root,s.id);
  expect(reviewState(s).picked.map(p=>p.id)).toEqual([missed.id]);expect(reviewState(s).ready).toBe(true);
  expect(reviewState(s).items.map(i=>i.id)).not.toContain(missed.id);
  expect(searchReviewSources(s,'').map(n=>n.id)).not.toContain(missed.id);
  finishReview(s);
  const kept=()=>readInclusionPolicy(c.root,c.store,c.scope)!.labels.find(l=>l.source.id===missed.id)?.include;
  expect(kept()).toBe(true);
  s=await idle(c.root,startReview(c,factory).id);
  pickReview(s,missed.id,s.revision);s=await idle(c.root,s.id);
  rateReview(s,missed.id,false,s.revision);s=await idle(c.root,s.id);
  expect(reviewState(s).picked).toEqual([]);finishReview(s);
  expect(kept()).toBe(false);
 }finally{rmSync(c.root,{recursive:true,force:true});}
});
test('a source that cannot be scored keeps its reason, and an empty review says how many sources it had',async()=>{
 const c=fixture();try{
  const one={...c,sources:[c.sources[0]!]};
  const failing:typeof inclusionEvaluator=(root,store,text,labels)=>({identity:inclusionEvaluator(root,store,text,labels).identity,score:async()=>{throw Error('Quick model is not connected');}});
  const s=await idle(c.root,startReview(one,failing).id),view=reviewState(s);
  expect(view.unresolved).toBe(1);expect(view.failures).toEqual(['Quick model is not connected']);
  expect(view.sources).toBe(1);expect(view.untried).toBe(0);expect(view.narrowed).toBe(false);expect(view.exhausted).toBe(true);
  expect(view.error).toContain('could not be evaluated');
 }finally{rmSync(c.root,{recursive:true,force:true});}
});
