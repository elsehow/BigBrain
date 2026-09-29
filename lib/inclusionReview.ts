import {randomUUID} from 'node:crypto';
import {calibrateInclusion,readInclusionPolicy,writeInclusionPolicy,sourceDigest,type InclusionPolicy,type InclusionSource} from './inclusionPolicy';
import {inclusionEvaluator} from './inclusionEvaluation';
export interface ReviewContext {root:string;store:string;scope:string;text:string;sources:InclusionSource[];select?:(text:string)=>InclusionSource[];check:()=>void;save:(text:string)=>void}
type Evaluator=ReturnType<typeof inclusionEvaluator>;
interface Session {id:string;context:ReviewContext;policy:InclusionPolicy;evaluator:Evaluator;pool:InclusionSource[];scores:Map<string,number>;failed:Map<string,string>;cards:InclusionSource[];busy:boolean;revision:number;error?:string;at:number}
const sessions=new Map<string,Session>(),latest=new Map<string,string>();
const key=(c:ReviewContext)=>JSON.stringify([c.root,c.store,c.scope]);
const labelKey=(s:InclusionSource)=>sourceDigest(s);
function persist(s:Session){writeInclusionPolicy(s.context.root,s.context.store,s.policy,true);}
function active(s:Session){return latest.get(key(s.context))===s.id;}
function calibration(s:Session){const labels=s.policy.labels;const scored=labels.flatMap(l=>{const score=s.scores.get(labelKey(l.source));return score===undefined?[]:[{include:l.include,score}]});return {allScored:scored.length===labels.length,...calibrateInclusion(scored)};}
export function reviewState(s:Session){
 const c=calibration(s),ready=c.ready&&c.allScored&&!s.busy&&!s.error;
 return {id:s.id,text:s.policy.text,revision:s.revision,busy:s.busy,ready,remaining:c.remaining,overlap:c.reason==='overlap',judged:s.policy.labels.length,unresolved:s.failed.size,error:s.error,
 items:s.cards.slice(0,3).map(({id,title,origin,body})=>({id,title,origin,excerpt:body.replace(/^---[\s\S]*?---\s*/, '').replace(/\s+/g,' ').slice(0,280),body})),
 exhausted:!s.busy&&s.cards.length===0};
}
export function getReview(root:string,id:string){const s=sessions.get(id);if(!s||s.context.root!==root||!active(s))throw Error('This review was replaced or expired. Reopen the rule.');s.context.check();s.at=Date.now();return s;}
export function startReview(context:ReviewContext,factory= inclusionEvaluator){
 context.check();for(const [id,s] of sessions)if(Date.now()-s.at>3600000)sessions.delete(id);
 const prior=readInclusionPolicy(context.root,context.store,context.scope,true)??readInclusionPolicy(context.root,context.store,context.scope);
 const text=context.text.trim()||prior?.text||'';
 const policy:InclusionPolicy={version:randomUUID(),scope:context.scope,text,labels:prior?.labels??[],updated:new Date().toISOString()};
 const evaluator=factory(context.root,context.store,text);
 // Interleave recent and older sources, then select using their actual scores.
 const pool:InclusionSource[]=[];const rows=context.select?.(text)??context.sources;for(let i=0;i<rows.length;i++){const index=i%2===0?i/2:rows.length-1-Math.floor(i/2);pool.push(rows[index]!);}
 const s:Session={id:randomUUID(),context,policy,evaluator,pool,scores:new Map(),failed:new Map(),cards:[],busy:true,revision:0,at:Date.now()};
 latest.set(key(context),s.id);sessions.set(s.id,s);persist(s);void refill(s);return reviewState(s);
}
async function refill(s:Session){
 const revision=s.revision;s.busy=true;s.error=undefined;
 const valid=()=>active(s)&&revision===s.revision;
 try{
  // Re-score every rated example on rule/model changes. A failed judgment prevents saving.
  for(const label of s.policy.labels){if(!valid())return;const k=labelKey(label.source);if(s.scores.has(k))continue;try{const score=await s.evaluator.score(label.source);if(!valid())return;s.scores.set(k,score);s.failed.delete(k);}catch{if(!valid())return;s.failed.set(k,'Could not evaluate this source');}}
  const judged=new Set(s.policy.labels.map(l=>labelKey(l.source)));
  const candidates=s.pool.filter(p=>!judged.has(labelKey(p)));
  // Bound paid requests per refill. Errors remain distinct from negative judgments.
  const availableScores=candidates.filter(p=>s.scores.has(labelKey(p))).length;
  const fresh=candidates.filter(p=>!s.scores.has(labelKey(p))&&!s.failed.has(labelKey(p))).slice(0,Math.max(0,6-availableScores));
  for(const source of fresh){if(!valid())return;const k=labelKey(source);try{const score=await s.evaluator.score(source);if(!valid())return;s.scores.set(k,score);}catch{if(!valid())return;s.failed.set(k,'Could not evaluate this source');}}
  if(!valid())return;
  const available=candidates.filter(p=>s.scores.has(labelKey(p))&&!s.cards.some(c=>c.id===p.id));
  const yes=s.policy.labels.filter(l=>l.include).length,no=s.policy.labels.length-yes;
  const cutoff=calibration(s).threshold??.8;
  available.sort((a,b)=>{const sa=s.scores.get(labelKey(a))!,sb=s.scores.get(labelKey(b))!;return yes<2?sb-sa:no<2?sa-sb:Math.abs(sa-cutoff)-Math.abs(sb-cutoff);});
  while(s.cards.length<3&&available.length)s.cards.push(available.shift()!);
  if(s.policy.labels.some(l=>!s.scores.has(labelKey(l.source))))s.error='Some rated sources could not be evaluated. Retry before saving.';
  if(!s.cards.length&&!calibration(s).ready&&s.failed.size)s.error='Sources could not be evaluated. Retry, or choose a model that can read them in full.';
 }catch(e){if(valid())s.error=e instanceof Error?e.message:'Evaluation failed';}
 finally{if(valid()){s.busy=false;persist(s);}}
}
export function rateReview(s:Session,id:string,include:boolean,revision:number){
 if(revision!==s.revision||s.busy)throw Error('Wait for this rule to finish evaluating.');
 if(typeof include!=='boolean')throw Error('Choose include or exclude.');
 const source=s.cards.find(c=>c.id===id);if(!source)throw Error('Choose a currently displayed example.');
 s.policy.labels=s.policy.labels.filter(l=>labelKey(l.source)!==labelKey(source));s.policy.labels.push({source,include});s.cards=s.cards.filter(c=>c.id!==id);persist(s);void refill(s);return reviewState(s);
}
export function editReview(s:Session,text:string,revision:number,factory=inclusionEvaluator){
 if(revision!==s.revision)throw Error('The rule changed in another request. Reload this review.');
 if(typeof text!=='string'||!text.trim()||text.length>8000)throw Error('Write an inclusion rule under 8,000 characters.');
 const evaluator=factory(s.context.root,s.context.store,text.trim());
 s.revision++;s.policy.text=text.trim();if(s.context.select)s.pool=s.context.select(text.trim());s.evaluator=evaluator;s.scores.clear();s.failed.clear();s.cards=[];persist(s);void refill(s);return reviewState(s);
}
export function retryReview(s:Session){if(s.busy)return reviewState(s);const evaluator=inclusionEvaluator(s.context.root,s.context.store,s.policy.text);if(evaluator.identity!==s.evaluator.identity){s.revision++;s.evaluator=evaluator;s.scores.clear();s.cards=[];}if(s.context.select)s.pool=s.context.select(s.policy.text);s.failed.clear();void refill(s);return reviewState(s);}
export function finishReview(s:Session){
 s.context.check();const current=inclusionEvaluator(s.context.root,s.context.store,s.policy.text);
 if(current.identity!==s.evaluator.identity)throw Error('The model changed. Reopen this review to recalibrate.');
 const c=calibration(s);if(s.busy||s.error||!c.ready||!c.allScored||c.threshold===undefined)throw Error('Rate more examples or refine the rule before saving.');
 const policy={...s.policy,version:randomUUID(),updated:new Date().toISOString(),calibration:{identity:s.evaluator.identity,threshold:c.threshold}};
 writeInclusionPolicy(s.context.root,s.context.store,policy);s.context.save(policy.text);writeInclusionPolicy(s.context.root,s.context.store,policy,true);latest.delete(key(s.context));sessions.delete(s.id);return {saved:true,judged:policy.labels.length};
}
