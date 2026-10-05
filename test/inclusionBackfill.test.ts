import {test,expect} from 'bun:test';
import {join} from 'node:path';
import {landDrop} from '../lib/landItem';
import {mdVault} from './support/vault';
import {setRule,sourceKey} from '../lib/sharedRules';
import {readSourceInsertionLog} from '../lib/insertionLog';
import {inclusionEvaluator,decideInclusion} from '../lib/inclusionEvaluation';
import {readInclusionPolicy,writeInclusionPolicy,sharedRuleScope} from '../lib/inclusionPolicy';
import {startBackfill,getBackfill,backfillState,rateBackfill,addBackfill,POOL} from '../lib/inclusionBackfill';
import {saveJevKey} from '../lib/jevSettings';

const connection={id:'fixture-conn',name:'Fixture',endpoint:'https://vault.example.com',token:'sv_fixture'};
/** Invented notes; the fake evaluator scores a note by the number at the end of its body,
 * and a label on a note teaches it: any note sharing the label's first word follows the label. */
async function fixture(){
 const root=mdVault({prefix:'bb-backfill-',dirs:['inbox']}),store=join(root,'..',`conn-${Date.now()}-${Math.random()}.json`);
 saveJevKey(store,'fabricated-key');
 const notes=[['Daycare waitlist','childcare for the baby 0.95'],['Clinic booking','doctor appointment 0.9'],['Build log','compiler flags 0.1'],['Rent','household budget 0.85'],['Daycare tour','childcare visit 0.7'],['Tooling','editor config 0.2']];
 for(const [title,body] of notes)await landDrop({root,content:`---\ntitle: ${title}\n---\n${body}\n`});
 setRule(store,connection.id,'Family concerns.',root);
 const scope=sharedRuleScope(connection.id),factory=evaluatorFactory();
 writeInclusionPolicy(root,store,{version:'v1',scope,text:'Family concerns.',labels:[],calibration:{identity:factory(root,store,'Family concerns.',[]).identity,threshold:.8},updated:new Date().toISOString()});
 return {root,store,scope,factory};
}
function evaluatorFactory():typeof inclusionEvaluator{
 return (root,store,text,labels=[])=>({identity:inclusionEvaluator(root,store,text,labels).identity,score:async(source:{body:string})=>{
  const taught=labels.find(l=>l.source.body.split(' ')[0]===source.body.split(' ')[0]);
  return taught?(taught.include?.99:.01):Number(source.body.trim().split(' ').at(-1));
 }});
}
async function settled(root:string,id:string){for(let i=0;i<400;i++){const b=getBackfill(root,id);if(!backfillState(b).busy)return b;await Bun.sleep(5);}throw Error('Backfill did not settle');}
const titles=(b:Parameters<typeof backfillState>[0])=>backfillState(b).matches.map(m=>m.title);

test('lists existing notes at or above the saved threshold, best first, uploading nothing',async()=>{
 const c=await fixture();
 const start=await startBackfill(c.root,c.store,connection,{factory:c.factory,queries:async()=>undefined,existing:async()=>new Set()});
 const b=await settled(c.root,start.id);
 expect(titles(b)).toEqual(['Daycare waitlist','Clinic booking','Rent']);
 expect(backfillState(b).total).toBeLessThanOrEqual(POOL);
});

test('a thumbs down drops a match and teaches the saved rule; a thumbs up keeps it on top; re-scoring follows',async()=>{
 const c=await fixture();
 const b=await settled(c.root,(await startBackfill(c.root,c.store,connection,{factory:c.factory,queries:async()=>undefined,existing:async()=>new Set()})).id);
 const rent=backfillState(b).matches.find(m=>m.title==='Rent')!,daycare=backfillState(b).matches.find(m=>m.title==='Daycare waitlist')!;
 rateBackfill(b,rent.id,false);
 rateBackfill(b,daycare.id,true);
 await settled(c.root,b.id);
 // "Daycare tour" shares the kept note's first word, so the taught rule now includes it
 expect(titles(b)).toEqual(['Daycare waitlist','Daycare tour','Clinic booking']);
 expect(backfillState(b).matches[0]!.kept).toBe(true);
 const policy=readInclusionPolicy(c.root,c.store,c.scope)!;
 expect(policy.labels.map(l=>[l.source.title,l.include])).toEqual([['Rent',false],['Daycare waitlist',true]]);
 // the saved rule stays usable for future arrivals: calibration follows the new labels
 expect(policy.calibration!.identity).toBe(inclusionEvaluator(c.root,c.store,policy.text,policy.labels).identity);
 const tour=readSourceInsertionLog(c.root,{strict:true}).find(s=>s.title==='Daycare tour')!;
 expect(await decideInclusion(c.root,c.store,c.scope,policy.text,tour).catch(e=>String(e))).not.toContain('Review this inclusion rule again');
});

test('adds exactly the current matches, skipping notes already contributed',async()=>{
 const c=await fixture();
 const clinic=readSourceInsertionLog(c.root,{strict:true}).find(s=>s.title==='Clinic booking')!;
 const existing=new Set<string>();
 const b=await settled(c.root,(await startBackfill(c.root,c.store,connection,{factory:c.factory,queries:async()=>undefined,existing:async()=>existing})).id);
 existing.add('origin:'+sourceKey(clinic)); // contributed elsewhere while the list was open
 let uploaded:string[]=[];
 const r=await addBackfill(b,async(_store,_c,rows)=>{uploaded=rows.map(s=>s.title);return rows.length;});
 expect(uploaded.sort()).toEqual(['Daycare waitlist','Rent']);expect(r.added).toBe(2);
 expect(()=>getBackfill(c.root,b.id)).toThrow('expired');
});

test('needs a saved, calibrated rule',async()=>{
 const c=await fixture();
 setRule(c.store,connection.id,'A different rule.',c.root);
 await expect(startBackfill(c.root,c.store,connection,{factory:c.factory,queries:async()=>undefined,existing:async()=>new Set()})).rejects.toThrow('Review and save');
});

/** Like the real evaluator: a note's own label is left out of the examples it is scored with,
 * so a model that disagrees with the user's thumbs up still scores it low. */
const ignoresLabels:typeof inclusionEvaluator=(root,store,text,labels=[])=>({identity:inclusionEvaluator(root,store,text,labels).identity,score:async(source:{body:string})=>Number(source.body.trim().split(' ').at(-1))});

test('a note kept while reviewing the rule is listed and added, whatever the model now scores it',async()=>{
 const c=await fixture();
 const build=readSourceInsertionLog(c.root,{strict:true}).find(s=>s.title==='Build log')!;
 const policy=readInclusionPolicy(c.root,c.store,c.scope)!;
 policy.labels=[{source:{id:'review-card',title:build.title,body:build.body,origin:'Personal'},include:true}];
 writeInclusionPolicy(c.root,c.store,policy);
 const b=await settled(c.root,(await startBackfill(c.root,c.store,connection,{factory:ignoresLabels,queries:async()=>undefined,existing:async()=>new Set()})).id);
 expect(titles(b)).toEqual(['Build log','Daycare waitlist','Clinic booking','Rent']);
 expect(backfillState(b).matches[0]!.kept).toBe(true);
 let uploaded:string[]=[];
 await addBackfill(b,async(_store,_c,rows)=>{uploaded=rows.map(s=>s.title);return rows.length;});
 expect(uploaded).toContain('Build log');
});

test('a note left out while reviewing stays out without being re-scored',async()=>{
 const c=await fixture();
 const rent=readSourceInsertionLog(c.root,{strict:true}).find(s=>s.title==='Rent')!;
 const policy=readInclusionPolicy(c.root,c.store,c.scope)!;
 policy.labels=[{source:{id:'review-card',title:rent.title,body:rent.body,origin:'Personal'},include:false}];
 writeInclusionPolicy(c.root,c.store,policy);
 const scored:string[]=[];
 const counting:typeof inclusionEvaluator=(root,store,text,labels)=>{const e=ignoresLabels(root,store,text,labels);return {...e,score:async s=>{scored.push(s.title);return e.score(s);}};};
 const b=await settled(c.root,(await startBackfill(c.root,c.store,connection,{factory:counting,queries:async()=>undefined,existing:async()=>new Set()})).id);
 expect(titles(b)).toEqual(['Daycare waitlist','Clinic booking']);
 expect(scored).not.toContain('Rent');
});

test('a scoring failure is reported as failed, not as no matches',async()=>{
 const c=await fixture();
 const limited:typeof inclusionEvaluator=(root,store,text,labels)=>({...ignoresLabels(root,store,text,labels),score:async()=>{throw Error('429 rate_limit_error');}});
 const b=await settled(c.root,(await startBackfill(c.root,c.store,connection,{factory:limited,queries:async()=>undefined,existing:async()=>new Set()})).id);
 const state=backfillState(b);
 expect(state.matches).toEqual([]);
 expect(state.failed).toBe(state.total);
 expect(state.failure).toContain('429');
});
