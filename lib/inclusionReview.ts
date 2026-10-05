import {includesEverything} from './inclusionMode';
import {inclusionExcerpt} from './inclusionExamples';
import {randomUUID} from 'node:crypto';
import {readInclusionPolicy,writeInclusionPolicy,sourceDigest,type InclusionPolicy,type InclusionSource} from './inclusionPolicy';
import {inclusionEvaluator} from './inclusionEvaluation';
import {rankCandidates,type CandidateEntity} from './inclusionCandidates';
import type {RuleQueries} from './inclusionQueries';
import {resolveRuleMentions} from './sharedRuleMentions';
import {OutOfCredits} from './sharedJev';
const NO_CREDITS='Out of usage credits. (You need credits to calibrate your inclusion rule.)';
export interface ReviewContext {root:string;store:string;scope:string;text:string;sources:InclusionSource[];select?:(text:string)=>InclusionSource[];check:()=>void;save:(text:string)=>void;
 /** Search phrases and subject mentions for a rule (lib/inclusionQueries.ts); absent, the rule's own words rank. */
 queries?:(text:string,entities:CandidateEntity[])=>Promise<RuleQueries|undefined>}
type Evaluator=ReturnType<typeof inclusionEvaluator>;
interface Session {factory:typeof inclusionEvaluator;id:string;context:ReviewContext;policy:InclusionPolicy;evaluator:Evaluator;pool:InclusionSource[];scores:Map<string,number>;failed:Map<string,string>;cards:InclusionSource[];busy:boolean;revision:number;error?:string;at:number;
 /** The rule text the pool was last ranked for with model-derived queries. */
 queriedFor?:string}
const sessions=new Map<string,Session>(),latest=new Map<string,string>();
const key=(c:ReviewContext)=>JSON.stringify([c.root,c.store,c.scope]);
const labelKey=(s:InclusionSource)=>sourceDigest(s);
function persist(s:Session){writeInclusionPolicy(s.context.root,s.context.store,s.policy,true);}
function active(s:Session){return latest.get(key(s.context))===s.id;}
// Score plausible matches first: a recency-ordered pool spends every paid call on sources the rule obviously excludes.
// A stale or unselected mention surfaces when the rule is saved; for ranking, the rule's words suffice.
function mentionedEntities(root:string,text:string){try{return resolveRuleMentions(root,text);}catch{return [];}}
function candidatePool(c:ReviewContext,text:string){return rankCandidates(c.select?.(text)??c.sources,text,mentionedEntities(c.root,text));}
const BATCH=9,CONCURRENCY=3;
export function reviewState(s:Session){
 const ready=(includesEverything(s.policy.text)||s.policy.labels.length>0)&&!s.busy&&!s.error;
 return {id:s.id,text:s.policy.text,revision:s.revision,busy:s.busy,ready,remaining:includesEverything(s.policy.text)?0:Math.max(0,4-s.policy.labels.length),overlap:false,judged:s.policy.labels.length,unresolved:s.failed.size,error:s.error,
 items:s.cards.slice(0,3).map(({id,title,origin,body})=>({id,title,origin,excerpt:inclusionExcerpt(body),body})),
 exhausted:!s.busy&&s.cards.length===0};
}
export function getReview(root:string,id:string){const s=sessions.get(id);if(!s||s.context.root!==root||!active(s))throw Error('This review was replaced or expired. Reopen the rule.');s.context.check();s.at=Date.now();return s;}
export function startReview(context:ReviewContext,factory= inclusionEvaluator){
 context.check();for(const [id,s] of sessions)if(Date.now()-s.at>3600000)sessions.delete(id);
 const prior=readInclusionPolicy(context.root,context.store,context.scope,true)??readInclusionPolicy(context.root,context.store,context.scope);
 const text=context.text.trim()||prior?.text||'';
 const policy:InclusionPolicy={version:randomUUID(),scope:context.scope,text,labels:prior?.labels??[],updated:new Date().toISOString()};
 const evaluator=factory(context.root,context.store,text,policy.labels);
 const pool=candidatePool(context,text);
 const s:Session={factory,id:randomUUID(),context,policy,evaluator,pool,scores:new Map(),failed:new Map(),cards:[],busy:true,revision:0,at:Date.now()};
 latest.set(key(context),s.id);sessions.set(s.id,s);persist(s);void refill(s);return reviewState(s);
}
async function refill(s:Session){
 if(includesEverything(s.policy.text)){s.cards=[];s.busy=false;s.error=undefined;persist(s);return;}
 const revision=s.revision;s.busy=true;s.error=undefined;
 const valid=()=>active(s)&&revision===s.revision;
 try{
  // Re-rank once per rule text with the model's search phrases before any paid scoring.
  if(s.context.queries&&s.queriedFor!==s.policy.text){
   const text=s.policy.text,q=await s.context.queries(text,mentionedEntities(s.context.root,text));
   if(!valid())return;
   if(q)s.pool=rankCandidates(s.context.select?.(text)??s.context.sources,text,q.subjects,q.phrases);
   s.queriedFor=text;
  }
  const judged=new Set(s.policy.labels.map(l=>labelKey(l.source)));
  const candidates=s.pool.filter(p=>!judged.has(labelKey(p)));
  // Bound paid requests per refill. Errors remain distinct from negative judgments.
  const availableScores=candidates.filter(p=>s.scores.has(labelKey(p))).length;
  const fresh=candidates.filter(p=>!s.scores.has(labelKey(p))&&!s.failed.has(labelKey(p))).slice(0,Math.max(0,BATCH-availableScores));
  for(let i=0;i<fresh.length;i+=CONCURRENCY){
   if(!valid())return;
   let broke=false;
   await Promise.all(fresh.slice(i,i+CONCURRENCY).map(async source=>{const k=labelKey(source);try{const score=await s.evaluator.score(source);if(valid())s.scores.set(k,score);}catch(e){if(e instanceof OutOfCredits)broke=true;else if(valid())s.failed.set(k,'Could not evaluate this source');}}));
   // no credits: no source will score until the account is topped up, so stop and say so
   if(broke){if(valid())s.error=NO_CREDITS;return;}
  }
  if(!valid())return;
  const available=candidates.filter(p=>s.scores.has(labelKey(p))&&!s.cards.some(c=>c.id===p.id)),score=(p:InclusionSource)=>s.scores.get(labelKey(p))!;
  // Until something is included the threshold has nothing to calibrate against, so lead with likely matches.
  if(!s.policy.labels.some(l=>l.include))available.sort((a,b)=>score(b)-score(a));
  else{
   available.sort((a,b)=>Math.abs(score(a)-.5)-Math.abs(score(b)-.5));
   // Reserve one slot for exploration rather than only uncertain examples.
   if(available.length>3&&s.policy.labels.length%3===0)available.unshift(available.pop()!);
  }
  while(s.cards.length<3&&available.length)s.cards.push(available.shift()!);
  if(!s.cards.length&&!s.policy.labels.length&&s.failed.size)s.error='Sources could not be evaluated. Retry, or choose a model that can read them in full.';
 }catch(e){if(valid())s.error=e instanceof Error?e.message:'Evaluation failed';}
 finally{if(valid()){s.busy=false;persist(s);}}
}
export function rateReview(s:Session,id:string,include:boolean,revision:number){
 if(revision!==s.revision||s.busy)throw Error('Wait for this rule to finish evaluating.');
 if(typeof include!=='boolean')throw Error('Choose include or exclude.');
 const source=s.cards.find(c=>c.id===id);if(!source)throw Error('Choose a currently displayed example.');
 s.policy.labels=s.policy.labels.filter(l=>labelKey(l.source)!==labelKey(source));const score=s.scores.get(labelKey(source));s.policy.labels.push({source,include,...(score===undefined?{}:{prediction:{score,identity:s.evaluator.identity}})});s.cards=s.cards.filter(c=>c.id!==id);s.evaluator=s.factory(s.context.root,s.context.store,s.policy.text,s.policy.labels);s.scores.clear();s.failed.clear();s.revision++;persist(s);void refill(s);return reviewState(s);
}
export function editReview(s:Session,text:string,revision:number,factory=inclusionEvaluator){
 if(revision!==s.revision)throw Error('The rule changed in another request. Reload this review.');
 if(typeof text!=='string'||!text.trim()||text.length>8000)throw Error('Write an inclusion rule under 8,000 characters.');
 const evaluator=factory(s.context.root,s.context.store,text.trim(),s.policy.labels);s.factory=factory;
 s.revision++;s.policy.text=text.trim();s.pool=candidatePool(s.context,text.trim());s.evaluator=evaluator;s.scores.clear();s.failed.clear();s.cards=[];persist(s);void refill(s);return reviewState(s);
}
export function retryReview(s:Session){if(s.busy)return reviewState(s);const evaluator=inclusionEvaluator(s.context.root,s.context.store,s.policy.text,s.policy.labels);if(evaluator.identity!==s.evaluator.identity){s.revision++;s.evaluator=evaluator;s.scores.clear();s.cards=[];}s.pool=candidatePool(s.context,s.policy.text);s.queriedFor=undefined;s.failed.clear();void refill(s);return reviewState(s);}
export function finishReview(s:Session){
 s.context.check();const current=inclusionEvaluator(s.context.root,s.context.store,s.policy.text,s.policy.labels);
 if(current.identity!==s.evaluator.identity)throw Error('The model changed. Reopen this review to recalibrate.');
 if(s.busy||s.error||(!s.policy.labels.length&&!includesEverything(s.policy.text)))throw Error('Rate an example before saving.');
 const policy={...s.policy,version:randomUUID(),updated:new Date().toISOString(),calibration:{identity:s.evaluator.identity,threshold:.8}};
 writeInclusionPolicy(s.context.root,s.context.store,policy);s.context.save(policy.text);writeInclusionPolicy(s.context.root,s.context.store,policy,true);latest.delete(key(s.context));sessions.delete(s.id);return {saved:true,judged:policy.labels.length};
}
