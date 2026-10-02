import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startReview,getReview,reviewState,rateReview,editReview,finishReview} from '../lib/inclusionReview';
import {readInclusionPolicy,sharedRuleScope,integrationRuleScope} from '../lib/inclusionPolicy';
import {inclusionEvaluator,decideInclusion} from '../lib/inclusionEvaluation';
import {rankCandidates} from '../lib/inclusionCandidates';
import {saveJevKey} from '../lib/jevSettings';
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
  const policy=readInclusionPolicy(c.root,c.store,c.scope)!;expect(policy.labels.length).toBe(count);expect(policy.calibration).toBeDefined();expect(readInclusionPolicy(c.root,c.store,integrationRuleScope('email','other'))).toBeUndefined();
  const positive=policy.labels.find(l=>l.include)!;expect(await decideInclusion(c.root,c.store,c.scope,policy.text,positive.source)).toBe(true);
  const negative=policy.labels.find(l=>!l.include)!;expect(await decideInclusion(c.root,c.store,c.scope,policy.text,negative.source)).toBe(false);
  await expect(decideInclusion(c.root,c.store,c.scope,'Changed rule',positive.source)).rejects.toThrow('Review this inclusion rule again');
  saveJevKey(c.store,null);await expect(decideInclusion(c.root,c.store,c.scope,policy.text,positive.source)).rejects.toThrow('model changed');
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
  expect(await decideInclusion(c.root,c.store,c.scope,'Include everything.',c.sources[0]!)).toBe(true);
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
